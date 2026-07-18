import { CodexHarness } from "../../coding/codex-coding-harness.js";
import { FakeCodingHarness } from "../../coding/fake-coding-harness.js";
import { LocalGitWorkspaces } from "../../integrations/git/local-git-workspaces.js";
import { FakeGitLabClient, HttpGitLabClient } from "../../integrations/gitlab/gitlab-client.js";
import { FakeJiraClient, HttpJiraClient } from "../../integrations/jira/jira-client.js";
import type { JiraIssueDto } from "../../integrations/jira/jira-types.js";
import { loadEnvironment } from "../../app/environment.js";
import { repositoryConfigs, resolveRepository } from "../../app/repository-configs.js";

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

const jira =
  environment.ADAPTER_MODE === "real"
    ? new HttpJiraClient(
        required(environment.JIRA_BASE_URL, "JIRA_BASE_URL"),
        required(environment.JIRA_TOKEN, "JIRA_TOKEN"),
      )
    : new FakeJiraClient(new Map([[demoIssue.key, demoIssue]]));

const gitlab =
  environment.ADAPTER_MODE === "real"
    ? new HttpGitLabClient(
        required(environment.GITLAB_BASE_URL, "GITLAB_BASE_URL"),
        required(environment.GITLAB_TOKEN, "GITLAB_TOKEN"),
      )
    : new FakeGitLabClient();

const codingHarness =
  environment.HARNESS_MODE === "codex"
    ? new CodexHarness(environment.CODEX_TIMEOUT_MINUTES)
    : new FakeCodingHarness();

/** Process-lifetime, stateless adapters used by the direct workflow definition. */
export const dependencies = {
  jira,
  gitlab,
  codingHarness,
  workspaces: new LocalGitWorkspaces(environment.WORKSPACE_ROOT),
  resolveRepository: (ticket: Parameters<typeof resolveRepository>[0]) =>
    resolveRepository(ticket, repositoryConfigs),
  actionableRepositoryId: environment.ACTIONABLE_REPOSITORY_ID,
} as const;
