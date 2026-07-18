import * as restate from "@restatedev/restate-sdk";
import type { HarnessRunResult } from "../../../coding/coding-harness.js";
import type { MergeRequest } from "../../../domain/merge-request.js";
import type { RepositoryConfig } from "../../../domain/repository.js";
import type { NormalizedBugTicket } from "../../../domain/ticket.js";
import { dependencies } from "../dependencies.js";
import { type BugFixWorkflowState, workspaceFromState } from "../workflow-state.js";

export async function pushReviewedBranch(state: BugFixWorkflowState): Promise<void> {
  await dependencies.workspaces.pushBranch(workspaceFromState(state));
}

export async function createMergeRequest(
  runId: string,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  state: BugFixWorkflowState,
  result: HarnessRunResult,
): Promise<MergeRequest> {
  return await dependencies.gitlab.createDraftMergeRequest({
    idempotencyKey: runId,
    projectId: repository.gitlabProjectId,
    sourceBranch: workspaceFromState(state).branchName,
    targetBranch: repository.defaultBranch,
    title: `${ticket.key}: ${ticket.summary}`,
    description: mergeRequestDescription(ticket, result),
    draft: true,
    assignToCurrentUser: true,
    labels: ["LHIND"],
  });
}

export async function linkMergeRequestInJira(state: BugFixWorkflowState): Promise<void> {
  if (!state.mergeRequest)
    throw new restate.TerminalError("Only an accepted review can be handed off");

  await dependencies.jira.ensureMergeRequestLink(state.issueKey, state.mergeRequest.url);
}

export async function markJiraReadyToMerge(state: BugFixWorkflowState): Promise<void> {
  if (!state.mergeRequest)
    throw new restate.TerminalError("Only an accepted review can be handed off");

  await dependencies.jira.ensureReadyToMerge(state.issueKey);
}

function mergeRequestDescription(ticket: NormalizedBugTicket, result: HarnessRunResult): string {
  return `## What\n${result.summary}\n\n## Why\n${result.rootCause ?? "See ticket context"}\n\n## How\nFocused automated patch for ${ticket.key}.\n\n## Verification\n${result.validation.commandsRun.join("\n")}\n\n## Scope\nNo unrelated changes.\n\nFixes ${ticket.key}`;
}
