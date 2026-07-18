import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as clients from "@restatedev/restate-sdk-clients";
import * as restate from "@restatedev/restate-sdk";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { BugFixApplication } from "../src/application/bugfix-application.js";
import { DomainError } from "../src/domain/errors.js";
import type { GitLabClient } from "../src/integrations/gitlab/gitlab-client.js";
import type { StartBugFixInput } from "../src/domain/workflow.js";
import type { RepositoryConfig } from "../src/domain/repository.js";
import { BugFixQueueCapture } from "../src/application/bugfix-queue-capture.js";
import { FakeCodexHarness } from "../src/harness/fake-codex-harness.js";
import { FakeJiraClient } from "../src/integrations/jira/jira-client.js";
import type { JiraIssueDto } from "../src/integrations/jira/jira-types.js";
import { LocalRunner } from "../src/runner/local-runner.js";
import { WorkspaceManager } from "../src/runner/workspace-manager.js";
import { createBugFixQueueRestateService } from "../src/restate/services/bugfix-queue.js";
import {
  createBugFixRestateWorkflow,
  type BugFixRestateWorkflow,
} from "../src/restate/workflows/bugfix/definition.js";

const exec = promisify(execFile);

const issue: JiraIssueDto = {
  key: "ABC-1",
  fields: {
    summary: "Replay-safe queue capture",
    description: "Fixture",
    status: { name: "Open" },
    issuetype: { name: "Bug" },
    components: [],
    labels: [],
    comment: { comments: [] },
    issuelinks: [],
    attachment: [],
  },
};
const queueTarget = restate.workflow({
  name: "QueueReplayTarget",
  handlers: {
    run: restate.handlers.workflow.workflow(
      async (ctx: restate.WorkflowContext, input: StartBugFixInput) => {
        ctx.set("input", input);
        return input;
      },
    ),
  },
});
const queue = createBugFixQueueRestateService(
  new BugFixQueueCapture(new FakeJiraClient(new Map([[issue.key, issue]]))),
  queueTarget as unknown as BugFixRestateWorkflow,
);
const queueInvoker = restate.service({
  name: "QueueReplayInvoker",
  handlers: {
    run: async (ctx: restate.Context, input: { filterUrl: string; generation: number }) =>
      await ctx.serviceClient(queue).run(input),
  },
});

const describeWithRestate = process.env.RUN_RESTATE_TESTS === "1" ? describe : describe.skip;

describeWithRestate("Restate always-replay integration", () => {
  let environment: RestateTestEnvironment | undefined;
  let ingress: clients.Ingress;

  beforeAll(async () => {
    environment = await RestateTestEnvironment.start({
      services: [queueTarget, queue, queueInvoker],
      alwaysReplay: true,
      disableRetries: true,
      storage: "memory",
    });
    ingress = clients.connect({ url: environment.baseUrl() });
  }, 30_000);

  afterAll(async () => {
    await environment?.stop();
  });

  it("replays the production queue handler without re-reading its captured queue", async () => {
    if (!environment) throw new Error("Restate test environment did not start");
    const queueResult = await ingress.serviceClient(queueInvoker).run({
      filterUrl: "https://jira.example.test/issues/?filter=1",
      generation: 3,
    });

    expect(queueResult.entries).toEqual([{ issueKey: "ABC-1", generation: 3 }]);
    const workflowResult = await ingress
      .workflowClient(queueTarget, "bugfix/ABC-1/3")
      .workflowAttach();
    expect(workflowResult).toEqual({ issueKey: "ABC-1", generation: 3 });
  });
});

describeWithRestate("Restate workflow state recovery", () => {
  let environment: RestateTestEnvironment | undefined;
  let ingress: clients.Ingress;
  let invoker: ReturnType<typeof createWorkflowReplayInvoker>;
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ticket-bot-restate-workflow-"));
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

    const repository: RepositoryConfig = {
      id: "fixture",
      jiraComponents: ["Ticket Bot"],
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
    const jira = new FakeJiraClient(new Map([[issue.key, issue]]));
    const workspaces = new WorkspaceManager(join(root, "workspaces"), true);
    const gitlab: GitLabClient = {
      createDraftMergeRequest: async () => {
        throw new DomainError("MR_CREATION_FAILURE", "Merge request creation was rejected");
      },
    };
    const application = new BugFixApplication(
      jira,
      gitlab,
      new FakeCodexHarness(),
      new LocalRunner(workspaces),
      workspaces,
      () => repository,
      repository.id,
    );
    const workflow = createBugFixRestateWorkflow(application);
    invoker = createWorkflowReplayInvoker(workflow);
    environment = await RestateTestEnvironment.start({
      services: [workflow, invoker],
      alwaysReplay: true,
      disableRetries: true,
      storage: "memory",
    });
    ingress = clients.connect({ url: environment.baseUrl() });
  }, 30_000);

  afterAll(async () => {
    await environment?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("keeps the initialized workflow context when a later terminal step fails", async () => {
    const input = { issueKey: issue.key, generation: 1 };
    const result = await ingress.serviceClient(invoker).run(input);
    const state = await ingress.serviceClient(invoker).status(input);

    expect(result).toEqual({
      runId: "bugfix/ABC-1/1",
      state: "FAILED",
      detail: "Merge request creation was rejected",
    });
    expect(state).toMatchObject({ repository: { id: "fixture" }, state: "FAILED" });
  });
});

function createWorkflowReplayInvoker(workflow: BugFixRestateWorkflow) {
  return restate.service({
    name: "WorkflowReplayInvoker",
    handlers: {
      run: async (ctx: restate.Context, input: StartBugFixInput) =>
        await ctx
          .workflowClient(workflow, `bugfix/${input.issueKey}/${input.generation}`)
          .run(input),
      status: async (ctx: restate.Context, input: StartBugFixInput) =>
        await ctx.workflowClient(workflow, `bugfix/${input.issueKey}/${input.generation}`).status(),
    },
  });
}
