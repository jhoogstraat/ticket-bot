import type { HarnessRunResult } from "../../../coding/coding-harness.js";
import type { MergeRequest } from "../../../domain/merge-request.js";
import { repositoryProjectPath, type RepositoryTarget } from "../../../domain/repository.js";
import type { NormalizedBugTicket } from "../../../domain/ticket.js";
import type { ForgeClients } from "../../../integrations/forge/forge-client.js";
import type { JiraClient } from "../../../integrations/jira/jira-client.js";

function mergeRequestDescription(ticket: NormalizedBugTicket, result: HarnessRunResult): string {
  return `## What\n${result.summary}\n\n## Why\n${result.rootCause ?? "See ticket context"}\n\n## How\nFocused automated patch for ${ticket.key}.\n\n## Verification\n${result.validation.commandsRun.join("\n")}\n\n## Scope\nNo unrelated changes.\n\nFixes ${ticket.key}`;
}

export class PublicationTask {
  constructor(
    private readonly forges: ForgeClients,
    private readonly jira: JiraClient,
  ) {}

  async createMergeRequest(
    runId: string,
    ticket: NormalizedBugTicket,
    repository: RepositoryTarget,
    sourceBranch: string,
    targetBranch: string,
    result: HarnessRunResult,
  ): Promise<MergeRequest> {
    return await this.forges[repository.forge].createMergeRequest({
      idempotencyKey: runId,
      projectId: repositoryProjectPath(repository),
      repositoryUrl: repository.url,
      sourceBranch,
      targetBranch,
      title: `${ticket.key}: ${ticket.summary}`,
      description: mergeRequestDescription(ticket, result),
      draft: true,
      assignToCurrentUser: true,
      labels: ["LHIND"],
    });
  }

  async linkMergeRequestInJira(issueKey: string, mergeRequestUrl: string): Promise<void> {
    await this.jira.ensureMergeRequestLink(issueKey, mergeRequestUrl);
  }

  async markJiraReadyToMerge(issueKey: string): Promise<void> {
    await this.jira.ensureReadyToMerge(issueKey);
  }
}
