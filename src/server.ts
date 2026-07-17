import { createEndpointHandler } from "@restatedev/restate-sdk/fetch";
import { loadEnvironment } from "./config/environment.js";
import { repositoryConfigs, resolveRepository } from "./config/repositories.js";
import { CodexHarness } from "./harness/codex-harness.js";
import { FakeCodexHarness } from "./harness/fake-codex-harness.js";
import { FakeGitLabClient, HttpGitLabClient } from "./integrations/gitlab/gitlab-client.js";
import { FakeJiraClient, HttpJiraClient } from "./integrations/jira/jira-client.js";
import type { JiraIssueDto } from "./integrations/jira/jira-types.js";
import { LocalRunner } from "./runner/local-runner.js";
import { WorkspaceManager } from "./runner/workspace-manager.js";
import { BugFixService } from "./services/bug-fix-service.js";
import { BugFixQueueService } from "./services/bug-fix-queue-service.js";
import { createJenkinsWebhookService } from "./webhooks/jenkins-webhook.js";
import { createJiraWebhookService } from "./webhooks/jira-webhook.js";
import { createSonarQubeWebhookService } from "./webhooks/sonarqube-webhook.js";
import { createGitLabWebhookService } from "./webhooks/gitlab-webhook.js";
import { createBugFixWorkflow } from "./workflows/bug-fix-workflow.js";
import { createBugFixQueueWorkflow } from "./workflows/bug-fix-queue.js";

const env = loadEnvironment();
const fakeIssue: JiraIssueDto = {
  key: "DEMO-1",
  fields: {
    summary: "Demonstrate the automated bug-fix workflow",
    description: "Create one focused simulated change.",
    status: { name: "Ready for development" },
    issuetype: { name: "Bug" },
    components: [{ name: "Ticket Bot" }],
    labels: ["demo"],
    comment: { comments: [] },
    issuelinks: [],
    attachment: [],
  },
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required in real adapter mode`);
  return value;
}

const jira =
  env.ADAPTER_MODE === "real"
    ? new HttpJiraClient(
        required(env.JIRA_BASE_URL, "JIRA_BASE_URL"),
        required(env.JIRA_TOKEN, "JIRA_TOKEN"),
      )
    : new FakeJiraClient(new Map([[fakeIssue.key, fakeIssue]]));
const gitlab =
  env.ADAPTER_MODE === "real"
    ? new HttpGitLabClient(
        required(env.GITLAB_BASE_URL, "GITLAB_BASE_URL"),
        required(env.GITLAB_TOKEN, "GITLAB_TOKEN"),
      )
    : new FakeGitLabClient();

const harness =
  env.HARNESS_MODE === "codex"
    ? new CodexHarness(env.CODEX_COMMAND, env.CODEX_TIMEOUT_MINUTES)
    : new FakeCodexHarness();
const workspaceManager = new WorkspaceManager(env.WORKSPACE_ROOT, env.KEEP_WORKSPACES);
const runner = new LocalRunner(workspaceManager);
const service = new BugFixService(
  jira,
  gitlab,
  harness,
  runner,
  workspaceManager,
  (ticket) => resolveRepository(ticket, repositoryConfigs),
  env.ACTIONABLE_REPOSITORY_ID,
);
const workflow = createBugFixWorkflow(service);
const queue = createBugFixQueueWorkflow(new BugFixQueueService(jira), workflow);
const services = [
  workflow,
  queue,
  createJiraWebhookService(workflow),
  createJenkinsWebhookService(workflow),
  createSonarQubeWebhookService(workflow),
  createGitLabWebhookService(workflow),
];
const handler = createEndpointHandler({ services });

Bun.serve({ port: env.PORT, fetch: handler });
console.log(
  JSON.stringify({
    level: "info",
    event: "server.started",
    port: env.PORT,
    adapterMode: env.ADAPTER_MODE,
    harnessMode: env.HARNESS_MODE,
    runtime: "bun",
  }),
);
