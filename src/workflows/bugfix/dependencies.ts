import { CodexHarness } from "../../coding/codex-coding-harness.js";
import { FakeCodingHarness } from "../../coding/fake-coding-harness.js";
import { LocalGitWorkspaces } from "../../integrations/git/local-git-workspaces.js";
import { FakeGitHubClient, HttpGitHubClient } from "../../integrations/github/github-client.js";
import { FakeGitLabClient, HttpGitLabClient } from "../../integrations/gitlab/gitlab-client.js";
import { FakeJiraClient, HttpJiraClient } from "../../integrations/jira/jira-client.js";
import type { JiraIssueDto } from "../../integrations/jira/jira-types.js";
import { loadEnvironment } from "../../app/environment.js";

const environment = loadEnvironment();

const demoIssue: JiraIssueDto = {
  key: "DEMO-1",
  fields: {
    summary: "Demonstrate the automated bugfix workflow",
    description: "Create one focused simulated change.",
    status: { name: "Ready for development" },
    issuetype: { name: "Bug" },
    components: [{ name: "Bug Bot" }],
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

export const jira =
  environment.ADAPTER_MODE === "real"
    ? new HttpJiraClient(
        required(environment.JIRA_BASE_URL, "JIRA_BASE_URL"),
        required(environment.JIRA_TOKEN, "JIRA_TOKEN"),
      )
    : new FakeJiraClient(new Map([[demoIssue.key, demoIssue]]));

export const forges =
  environment.ADAPTER_MODE === "real"
    ? {
        github: new HttpGitHubClient(environment.GITHUB_TOKEN),
        gitlab: new HttpGitLabClient(environment.GITLAB_TOKEN),
      }
    : { github: new FakeGitHubClient(), gitlab: new FakeGitLabClient() };

export const codingHarness =
  environment.HARNESS_MODE === "codex"
    ? new CodexHarness(environment.CODEX_TIMEOUT_MINUTES)
    : new FakeCodingHarness();

export const workspaces = new LocalGitWorkspaces(environment.WORKSPACE_ROOT);

export const trustedRepositoryUrlPrefixes = environment.TRUSTED_REPOSITORY_URL_PREFIXES;

export const limits = {
  maxAgentTurns: environment.MAX_AGENT_TURNS,
  maxChangedFiles: environment.MAX_CHANGED_FILES,
  maxRepairAttempts: environment.MAX_REPAIR_ATTEMPTS,
  maxExecutionMinutes: environment.MAX_EXECUTION_MINUTES,
};
