import type { HarnessRunResult } from "../../../../domain/harness.js";
import type { RepositoryConfig } from "../../../../domain/repository.js";
import type { NormalizedBugTicket } from "../../../../domain/ticket.js";
import {
  emptyTokenUsage,
  humanRequired,
  type BugFixWorkflowState,
} from "../../../../domain/workflow.js";
import type { Workspace } from "../../../../runner/execution-runner.js";
import type { BugFixApplication } from "../../../../application/bugfix-application.js";
import { saveWorkflowState, type BugFixWorkflowContext } from "../state.js";
import { runApplicationStep } from "../../../application-step.js";

export type InitialFixResult =
  | { status: "human_required"; state: BugFixWorkflowState; detail: string }
  | {
      status: "actionable";
      state: BugFixWorkflowState;
      workspace: Workspace;
      harnessResult: HarnessRunResult;
    };

export async function runInitialFix(
  ctx: BugFixWorkflowContext,
  service: BugFixApplication,
  runId: string,
  generation: number,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
): Promise<InitialFixResult> {
  const investigationWorkspace = await runApplicationStep(
    ctx,
    "create-workspace",
    () => service.createWorkspace(runId, ticket, repository),
    { maxRetryAttempts: 3 },
  );
  const investigation = await runApplicationStep(
    ctx,
    "investigate-ticket",
    () => service.investigate(ticket, repository, investigationWorkspace),
    { maxRetryAttempts: 2 },
  );

  if (!investigation.gate.actionable) {
    const state = humanRequired(
      {
        runId,
        issueKey: ticket.key,
        generation,
        repository: {
          id: repository.id,
          cloneUrl: repository.cloneUrl,
          defaultBranch: repository.defaultBranch,
        },
        branchName: investigationWorkspace.branchName,
        baseCommitSha: investigationWorkspace.baseCommitSha,
        harness: { provider: "codex", workspaceId: investigationWorkspace.id },
        analysis: investigation.analysis,
        state: "REVIEWING",
        repairAttempt: 0,
        reviewAttempt: 0,
        maxRepairAttempts: repository.limits.maxRepairAttempts,
        tokenUsage: emptyTokenUsage(),
      },
      investigation.gate.reason,
    );
    saveWorkflowState(ctx, state);
    return { status: "human_required", state, detail: investigation.gate.reason };
  }

  await runApplicationStep(ctx, "claim-jira-ticket", () => service.claimTicket(ticket.key), {
    maxRetryAttempts: 3,
  });
  const implementationWorkspace = await runApplicationStep(
    ctx,
    "activate-focused-branch",
    () => service.activateWorkspace(investigationWorkspace),
    { maxRetryAttempts: 2 },
  );
  const harnessResult = await runApplicationStep(
    ctx,
    "start-codex",
    () => service.startHarness(ticket, repository, implementationWorkspace, investigation.analysis),
    { maxRetryAttempts: 2 },
  );
  const commit = await runApplicationStep(
    ctx,
    "validate-and-commit",
    () => service.validateAndCommit(implementationWorkspace, ticket, repository, harnessResult),
    { maxRetryAttempts: 1 },
  );
  const state = service.createImplementationState(
    runId,
    generation,
    ticket,
    repository,
    implementationWorkspace,
    investigation.analysis,
    harnessResult,
    commit.commitSha,
  );
  saveWorkflowState(ctx, state);
  return { status: "actionable", state, workspace: implementationWorkspace, harnessResult };
}

export async function publishInitialFix(
  ctx: BugFixWorkflowContext,
  service: BugFixApplication,
  runId: string,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  state: BugFixWorkflowState,
  workspace: Workspace,
  harnessResult: HarnessRunResult,
): Promise<BugFixWorkflowState> {
  await runApplicationStep(ctx, "push-branch", () => service.push(workspace), {
    maxRetryAttempts: 3,
  });
  const mergeRequest = await runApplicationStep(
    ctx,
    "create-draft-merge-request",
    () => service.createMergeRequest(runId, ticket, repository, workspace, harnessResult),
    { maxRetryAttempts: 3 },
  );
  return saveWorkflowState(ctx, service.createPublishedState(state, mergeRequest));
}
