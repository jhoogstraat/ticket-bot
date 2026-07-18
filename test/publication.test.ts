import { describe, expect, it } from "bun:test";
import { FakeGitHubClient } from "../src/integrations/github/github-client.js";
import { FakeGitLabClient } from "../src/integrations/gitlab/gitlab-client.js";
import { FakeJiraClient } from "../src/integrations/jira/jira-client.js";
import type { NormalizedBugTicket } from "../src/domain/ticket.js";
import { PublicationTask } from "../src/workflows/bugfix/tasks/publication.js";

const jira = new FakeJiraClient(new Map());
const ticket: NormalizedBugTicket = {
  key: "ABC-1",
  summary: "Fix the bug",
  reproductionSteps: [],
  status: "Open",
  affectedVersions: [],
  statusHistory: [],
  labels: [],
  relevantComments: [],
  linkedIssues: [],
  attachments: [],
};

const result = {
  sessionId: "session-1",
  status: "completed" as const,
  summary: "Fixed",
  changedFiles: ["src/fix.ts"],
  validation: { commandsRun: ["bun test"], succeeded: true, failures: [] },
};

describe("forge publication", () => {
  it("selects GitHub from the submitted forge", async () => {
    const github = new FakeGitHubClient();
    const task = new PublicationTask({ github, gitlab: new FakeGitLabClient() }, jira);

    await task.createMergeRequest(
      "bugfix/ABC-1/1",
      ticket,
      { forge: "github", url: "https://github.com/example/project.git" },
      "agent/abc-1/fix",
      "main",
      result,
    );

    expect(github.created[0]?.projectId).toBe("example/project");
  });

  it("keeps nested GitLab namespaces", async () => {
    const gitlab = new FakeGitLabClient();
    const task = new PublicationTask({ github: new FakeGitHubClient(), gitlab }, jira);

    await task.createMergeRequest(
      "bugfix/ABC-1/1",
      ticket,
      {
        forge: "gitlab",
        url: "https://gitlab.hlag.altemista.cloud/fis3/commons-ui/commons-ui-frontend.git",
      },
      "agent/abc-1/fix",
      "main",
      result,
    );

    expect(gitlab.created[0]?.projectId).toBe("fis3/commons-ui/commons-ui-frontend");
  });
});
