import * as restate from "@restatedev/restate-sdk";
import { startWebhookApi } from "./api/webhook-api.js";
import { loadEnvironment } from "./config/environment.js";
import { repositoryConfigs, resolveRepository } from "./config/repositories.js";
import { CodexHarness } from "./harness/codex-harness.js";
import { FakeCodingHarness } from "./harness/fake-coding-harness.js";
import { FakeGitLabClient, HttpGitLabClient } from "./integrations/gitlab/gitlab-client.js";
import { FakeJiraClient, HttpJiraClient } from "./integrations/jira/jira-client.js";
import type { JiraIssueDto } from "./integrations/jira/jira-types.js";
import { LocalRunner } from "./runner/local-runner.js";
import { WorkspaceManager } from "./runner/workspace-manager.js";
import { createBugFixQueueRestateService } from "./restate/services/bugfix-queue.js";
import { createGitLabWebhookIngressService } from "./restate/webhooks/gitlab-webhook.js";
import { createJenkinsWebhookIngressService } from "./restate/webhooks/jenkins-webhook.js";
import { createJiraWebhookIngressService } from "./restate/webhooks/jira-webhook.js";
import { createSonarQubeWebhookIngressService } from "./restate/webhooks/sonarqube-webhook.js";
import { createBugFixRestateWorkflow } from "./restate/workflows/bugfix/definition.js";

const env = loadEnvironment();
const fakeIssue: JiraIssueDto = {
  key: "DEMO-1",
  fields: {
    summary: "Demonstrate the automated bugfix workflow",
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
    ? new CodexHarness(env.CODEX_TIMEOUT_MINUTES)
    : new FakeCodingHarness();
const workspaceManager = new WorkspaceManager(env.WORKSPACE_ROOT, env.KEEP_WORKSPACES);
const runner = new LocalRunner(workspaceManager);
const workflow = createBugFixRestateWorkflow(
  {
    jira,
    gitlab,
    harness,
    runner,
    workspaces: workspaceManager,
    resolveRepository: (ticket) => resolveRepository(ticket, repositoryConfigs),
    actionableRepositoryId: env.ACTIONABLE_REPOSITORY_ID,
  },
  {
    inactivityTimeoutMinutes: env.CODEX_TIMEOUT_MINUTES + 5,
    callbackTimeoutMinutes: env.CALLBACK_TIMEOUT_MINUTES,
  },
);
const queue = createBugFixQueueRestateService(jira, workflow);
const jiraWebhook = createJiraWebhookIngressService(workflow);
const jenkinsWebhook = createJenkinsWebhookIngressService(workflow);
const sonarQubeWebhook = createSonarQubeWebhookIngressService(workflow);
const gitLabWebhook = createGitLabWebhookIngressService(workflow);
const restateDefinitions = [
  workflow,
  queue,
  jiraWebhook,
  jenkinsWebhook,
  sonarQubeWebhook,
  gitLabWebhook,
];
const port = await restate.serve({
  services: restateDefinitions,
  port: env.PORT,
  ...(env.RESTATE_IDENTITY_KEYS ? { identityKeys: env.RESTATE_IDENTITY_KEYS } : {}),
});
const webhookApi = startWebhookApi({
  port: env.APP_PORT,
  restateIngressUrl: env.RESTATE_INGRESS_URL,
  ...(env.WEBHOOK_SIGNING_SECRET ? { signingSecret: env.WEBHOOK_SIGNING_SECRET } : {}),
  services: {
    jira: jiraWebhook,
    jenkins: jenkinsWebhook,
    sonarqube: sonarQubeWebhook,
    gitlab: gitLabWebhook,
  },
});
console.log(
  JSON.stringify({
    level: "info",
    event: "server.started",
    port,
    webhookApiPort: webhookApi.port,
    adapterMode: env.ADAPTER_MODE,
    harnessMode: env.HARNESS_MODE,
    runtime: "bun",
    transport: "restate-http2",
  }),
);
