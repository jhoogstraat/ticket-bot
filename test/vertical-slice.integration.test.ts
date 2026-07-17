import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "bun:test";
import type { RepositoryConfig } from "../src/domain/repository.js";
import { FakeCodexHarness } from "../src/harness/fake-codex-harness.js";
import { FakeGitLabClient } from "../src/integrations/gitlab/gitlab-client.js";
import { FakeJiraClient } from "../src/integrations/jira/jira-client.js";
import type { JiraIssueDto } from "../src/integrations/jira/jira-types.js";
import { LocalRunner } from "../src/runner/local-runner.js";
import { WorkspaceManager } from "../src/runner/workspace-manager.js";
import { BugFixService } from "../src/services/bug-fix-service.js";

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("initial vertical slice", () => {
  it("normalizes Jira, runs an isolated harness, pushes, opens a draft MR, and waits for CI", async () => {
    const root = await mkdtemp(join(tmpdir(), "ticket-bot-test-"));
    cleanup.push(root);
    const source = join(root, "source");
    await exec("git", ["init", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "fixture\n", "utf8");
    await exec("git", ["-C", source, "add", "README.md"]);
    await exec("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial",
    ]);

    const issue: JiraIssueDto = {
      key: "ABC-1",
      fields: {
        summary: "Fix a defect",
        description: "Expected fixture behavior",
        status: { name: "Open" },
        issuetype: { name: "Bug" },
        components: [{ name: "Payments" }],
        labels: [],
        comment: { comments: [] },
        issuelinks: [],
        attachment: [],
      },
    };
    const repository: RepositoryConfig = {
      id: "fixture",
      jiraComponents: ["Payments"],
      cloneUrl: source,
      gitlabProjectId: "group/fixture",
      defaultBranch: "main",
      buildCommands: [],
      testCommands: [],
      lintCommands: [],
      harness: "codex",
      limits: {
        maxAgentTurns: 10,
        maxChangedFiles: 15,
        maxRepairAttempts: 3,
        maxExecutionMinutes: 5,
      },
    };
    const workspaces = new WorkspaceManager(join(root, "workspaces"), true);
    const harness = new FakeCodexHarness();
    const gitlab = new FakeGitLabClient();
    const jira = new FakeJiraClient(new Map([[issue.key, issue]]));
    const service = new BugFixService(
      jira,
      gitlab,
      harness,
      new LocalRunner(workspaces),
      workspaces,
      () => repository,
      repository.id,
    );
    const ticket = await service.loadTicket(issue.key);
    const result = await service.executeInitial("bug-fix/ABC-1/1", 1, ticket, repository);

    expect(result.state.state).toBe("CI_RUNNING");
    expect(result.state.currentCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.inspection.changedFiles).toEqual([
      ".ticket-bot/ABC-1.txt",
      "ticket-analysis/ABC-1/ANALYSIS.md",
    ]);
    expect(result.gate.actionable).toBe(true);
    expect(harness.analyses).toHaveLength(1);
    expect(harness.starts).toHaveLength(1);
    expect(result.state.tokenUsage.review).toBeGreaterThan(0);
    expect(jira.claimed).toEqual(["ABC-1"]);
    expect(gitlab.created[0]).toMatchObject({
      draft: true,
      sourceBranch: "agent/abc-1/fix-a-defect",
      targetBranch: "main",
      assignToCurrentUser: true,
      labels: ["LHIND"],
    });
    const { stdout } = await exec("git", [
      "-C",
      source,
      "branch",
      "--list",
      "agent/abc-1/fix-a-defect",
    ]);
    expect(stdout).toContain("agent/abc-1/fix-a-defect");
  });
});
