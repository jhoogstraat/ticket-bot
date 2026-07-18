import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as clients from "@restatedev/restate-sdk-clients";
import * as restate from "@restatedev/restate-sdk";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import * as http2 from "node:http2";
import { DomainError } from "../src/domain/errors.js";
import type { GitLabClient } from "../src/integrations/gitlab/gitlab-client.js";
import type { StartBugFixInput } from "../src/domain/workflow.js";
import type { RepositoryConfig } from "../src/domain/repository.js";
import { FakeCodingHarness } from "../src/harness/fake-coding-harness.js";
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
  new FakeJiraClient(new Map([[issue.key, issue]])),
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
  let environment: RestateIntegrationEnvironment | undefined;
  let ingress: clients.Ingress;

  beforeAll(async () => {
    environment = await startRestateIntegrationEnvironment({
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
  let environment: RestateIntegrationEnvironment | undefined;
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
    const workflow = createBugFixRestateWorkflow({
      jira,
      gitlab,
      harness: new FakeCodingHarness(),
      runner: new LocalRunner(workspaces),
      workspaces,
      resolveRepository: () => repository,
      actionableRepositoryId: repository.id,
    });
    invoker = createWorkflowReplayInvoker(workflow);
    environment = await startRestateIntegrationEnvironment({
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

interface RestateIntegrationEnvironment {
  baseUrl(): string;
  stop(): Promise<void>;
}

type RestateEnvironmentOptions = Parameters<typeof RestateTestEnvironment.start>[0];

async function startRestateIntegrationEnvironment(
  options: RestateEnvironmentOptions,
): Promise<RestateIntegrationEnvironment> {
  if (process.env.RESTATE_CONTAINER_RUNTIME === "apple")
    return await AppleContainerRestateEnvironment.start(options);
  return await RestateTestEnvironment.start(options);
}

class AppleContainerRestateEnvironment implements RestateIntegrationEnvironment {
  private constructor(
    private readonly endpoint: http2.Http2Server,
    private readonly name: string,
    private readonly ingressPort: number,
  ) {}

  static async start(
    options: RestateEnvironmentOptions,
  ): Promise<AppleContainerRestateEnvironment> {
    const endpoint = http2.createServer(createEndpointHandler(options));
    await listen(endpoint);
    const endpointAddress = endpoint.address();
    if (!endpointAddress || typeof endpointAddress === "string")
      throw new Error("Restate test endpoint did not bind a TCP port");

    const name = `ticket-bot-restate-${crypto.randomUUID()}`;
    const ingressPort = await availablePort();
    const adminPort = await availablePort();
    try {
      await exec("container", [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--publish",
        `127.0.0.1:${ingressPort}:8080`,
        "--publish",
        `127.0.0.1:${adminPort}:9070`,
        "--env",
        "RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=0s",
        "--env",
        "RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=1",
        "--env",
        "RESTATE_DEFAULT_RETRY_POLICY__ON_MAX_ATTEMPTS=kill",
        "docker.io/restatedev/restate:latest",
      ]);
      await waitForHealthy(`http://127.0.0.1:${adminPort}/health`);
      const registration = await fetch(`http://127.0.0.1:${adminPort}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uri: `http://host.container.internal:${endpointAddress.port}`,
        }),
      });
      if (!registration.ok)
        throw new Error(
          `Restate service registration failed: ${registration.status} ${await registration.text()}`,
        );
      return new AppleContainerRestateEnvironment(endpoint, name, ingressPort);
    } catch (error) {
      endpoint.close();
      await stopContainer(name);
      throw error;
    }
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.ingressPort}`;
  }

  async stop(): Promise<void> {
    this.endpoint.close();
    await stopContainer(this.name);
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a TCP port");
  return address.port;
}

async function listen(server: http2.Http2Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
}

async function waitForHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Restate has not finished starting yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Restate did not become healthy at ${url}`);
}

async function stopContainer(name: string): Promise<void> {
  try {
    await exec("container", ["stop", name]);
  } catch {
    // A failed startup may already have removed the disposable container.
  }
}
