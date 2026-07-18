import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  LocalGitWorkspaces,
  type CreateRepositoryWorkspaceInput,
} from "../src/integrations/git/local-git-workspaces.js";

const exec = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalGitWorkspaces", () => {
  it("preserves an existing checkout when reopening it fails", async () => {
    const root = await createRepositoryFixture();
    const source = join(root, "source");
    const workspaces = new LocalGitWorkspaces(join(root, "workspaces"));
    const input: CreateRepositoryWorkspaceInput = {
      workflowId: "bugfix/ABC-1/1",
      issueKey: "ABC-1",
      shortSlug: "Keep existing workspace",
      repository: {
        id: "fixture",
        jiraComponents: ["Bug Bot"],
        cloneUrl: source,
        gitlabProjectId: "group/fixture",
        defaultBranch: "main",
        buildCommands: [],
        testCommands: [],
        lintCommands: [],
        harness: "codex",
        limits: {
          maxAgentTurns: 1,
          maxChangedFiles: 1,
          maxRepairAttempts: 1,
          maxExecutionMinutes: 1,
        },
      },
    };

    const workspace = await workspaces.create(input);
    await rm(join(workspace.path, ".git"), { recursive: true, force: true });

    let reopenError: unknown;
    try {
      await workspaces.create(input);
    } catch (error) {
      reopenError = error;
    }

    expect(reopenError).toHaveProperty(
      "message",
      expect.stringContaining("Could not create workspace"),
    );

    expect((await stat(workspace.path)).isDirectory()).toBe(true);
  });
});

async function createRepositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bug-bot-workspaces-"));
  temporaryRoots.push(root);
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

  return root;
}
