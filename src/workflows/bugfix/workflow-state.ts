import type { CompactCiFailure, CiResult, SonarFinding } from "../../domain/ci.js";
import type { MergeRequest } from "../../domain/merge-request.js";
import type { TicketAnalysis } from "../../domain/ticket-analysis.js";
import type { HarnessRunResult } from "../../coding/coding-harness.js";
import type { RepositoryConfig } from "../../domain/repository.js";
import type { NormalizedBugTicket } from "../../domain/ticket.js";
import type { RepositoryWorkspace } from "../../integrations/git/local-git-workspaces.js";
import * as restate from "@restatedev/restate-sdk";

/** Stages before a change is ready for CI and external review. */
export type PreparationStage =
  "RECEIVED" | "CONTEXT_READY" | "ANALYZING" | "IMPLEMENTING" | "LOCAL_VALIDATION" | "MR_CREATED";

/** Stages while automated checks, repair, and review are in progress. */
export type DeliveryStage = "CI_RUNNING" | "CI_FAILED" | "REPAIRING" | "REVIEWING" | "REVIEW_READY";

/** Terminal stages: no further automated workflow work is expected. */
export type TerminalStage = "DONE" | "HUMAN_REQUIRED";

export type WorkflowStage = PreparationStage | DeliveryStage | TerminalStage;

export interface BugFixWorkflowState {
  runId: string;
  issueKey: string;
  generation: number;
  repository: { id: string; cloneUrl: string; defaultBranch: string };
  branchName?: string;
  baseCommitSha?: string;
  currentCommitSha?: string;
  harness?: { provider: "codex"; sessionId?: string; workspacePath?: string };
  mergeRequest?: MergeRequest;
  analysis?: TicketAnalysis;
  state: WorkflowStage;
  repairAttempt: number;
  reviewAttempt: number;
  maxRepairAttempts: number;
  lastFailureFingerprint?: string;
  lastCommitAtFailure?: string;
  statusDetail?: string;
}

export interface StartBugFixInput {
  issueKey: string;
  generation: number;
}

export interface BugFixWorkflowResult {
  runId: string;
  state: WorkflowStage;
  detail?: string;
}

export interface CiCallback {
  correlation: CallbackCorrelation;
  result: CiResult;
  failure?: CompactCiFailure;
}

export interface SonarCallback {
  correlation: CallbackCorrelation;
  qualityGate: "passed" | "failed";
  findings: SonarFinding[];
}

export interface MergeRequestReviewCallback {
  correlation: CallbackCorrelation;
  requiredFeedbackResolved: boolean;
  detail?: string;
}

/** Immutable identity supplied by an external check for a published revision. */
export interface CallbackCorrelation {
  attempt: number;
  commitSha: string;
  providerEventId: string;
}

/** Pause automation and expose the reason that human attention is required. */
export function humanRequired(
  current: BugFixWorkflowState,
  statusDetail: string,
): BugFixWorkflowState {
  return { ...current, state: "HUMAN_REQUIRED", statusDetail };
}

/** Record publication of the merge request and begin waiting for CI. */
export function published(
  current: BugFixWorkflowState,
  mergeRequest: MergeRequest,
): BugFixWorkflowState {
  const next = { ...current, mergeRequest, state: "CI_RUNNING" as const };
  delete next.statusDetail;
  return next;
}

/** Mark that an automated repair is currently being attempted. */
export function repairing(current: BugFixWorkflowState): BugFixWorkflowState {
  return { ...current, state: "REPAIRING" };
}

/** Mark the latest change as accepted and ready for final handoff. */
export function reviewReady(
  current: BugFixWorkflowState,
  statusDetail: string,
): BugFixWorkflowState {
  return { ...current, state: "REVIEW_READY", statusDetail };
}

/** Complete automation after handing the accepted change to a human. */
export function done(current: BugFixWorkflowState, statusDetail: string): BugFixWorkflowState {
  return { ...current, state: "DONE", statusDetail };
}

export function initialState(
  runId: string,
  generation: number,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  workspace: RepositoryWorkspace,
  analysis: TicketAnalysis,
): BugFixWorkflowState {
  return {
    runId,
    issueKey: ticket.key,
    generation,
    repository: {
      id: repository.id,
      cloneUrl: repository.cloneUrl,
      defaultBranch: repository.defaultBranch,
    },
    branchName: workspace.branchName,
    baseCommitSha: workspace.baseCommitSha,
    harness: { provider: "codex", workspacePath: workspace.path },
    analysis,
    state: "REVIEWING",
    repairAttempt: 0,
    reviewAttempt: 0,
    maxRepairAttempts: repository.limits.maxRepairAttempts,
  };
}

export function implementationState(
  runId: string,
  generation: number,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  workspace: RepositoryWorkspace,
  analysis: TicketAnalysis,
  result: HarnessRunResult,
  commitSha: string,
): BugFixWorkflowState {
  return {
    ...initialState(runId, generation, ticket, repository, workspace, analysis),
    currentCommitSha: commitSha,
    harness: { provider: "codex", sessionId: result.sessionId, workspacePath: workspace.path },
  };
}

export function workflowResult(runId: string, state: BugFixWorkflowState): BugFixWorkflowResult {
  return {
    runId,
    state: state.state,
    ...(state.statusDetail ? { detail: state.statusDetail } : {}),
  };
}

export function workspaceFromState(state: BugFixWorkflowState): RepositoryWorkspace {
  const path = state.harness?.workspacePath;
  if (!path || !state.branchName || !state.baseCommitSha)
    throw new restate.TerminalError("Workflow does not contain a recoverable workspace");

  return { path, branchName: state.branchName, baseCommitSha: state.baseCommitSha };
}
