import type { CompactCiFailure, CiResult, SonarFinding } from "./ci.js";
import type { MergeRequest } from "./merge-request.js";
import type { TicketAnalysis } from "./analysis.js";

/** Stages before a change is ready for CI and external review. */
export type PreparationStage =
  "RECEIVED" | "CONTEXT_READY" | "ANALYZING" | "IMPLEMENTING" | "LOCAL_VALIDATION" | "MR_CREATED";

/** Stages while automated checks, repair, and review are in progress. */
export type DeliveryStage = "CI_RUNNING" | "CI_FAILED" | "REPAIRING" | "REVIEWING" | "REVIEW_READY";

/** Terminal stages: no further automated workflow work is expected. */
export type TerminalStage = "DONE" | "HUMAN_REQUIRED" | "FAILED";

export type WorkflowStage = PreparationStage | DeliveryStage | TerminalStage;

export interface TokenUsage {
  initialRun: number;
  repairs: number;
  review: number;
  total: number;
}

export interface BugFixWorkflowState {
  runId: string;
  issueKey: string;
  generation: number;
  repository: { id: string; cloneUrl: string; defaultBranch: string };
  branchName?: string;
  baseCommitSha?: string;
  currentCommitSha?: string;
  harness?: { provider: "codex"; sessionId?: string; workspaceId?: string };
  mergeRequest?: MergeRequest;
  analysis?: TicketAnalysis;
  state: WorkflowStage;
  repairAttempt: number;
  reviewAttempt: number;
  maxRepairAttempts: number;
  lastFailureFingerprint?: string;
  lastCommitAtFailure?: string;
  tokenUsage: TokenUsage;
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
  result: CiResult;
  failure?: CompactCiFailure;
}
export interface SonarCallback {
  qualityGate: "passed" | "failed";
  findings: SonarFinding[];
}
export interface MergeRequestReviewCallback {
  commitSha?: string;
  requiredFeedbackResolved: boolean;
  detail?: string;
}

export const emptyTokenUsage = (): TokenUsage => ({
  initialRun: 0,
  repairs: 0,
  review: 0,
  total: 0,
});

export function addTokenUsage(
  current: TokenUsage,
  stage: "initialRun" | "repairs" | "review",
  tokens: number,
): TokenUsage {
  const next = { ...current, [stage]: current[stage] + Math.max(0, tokens) };
  return { ...next, total: next.initialRun + next.repairs + next.review };
}

/** Pause automation and expose the reason that human attention is required. */
export function humanRequired(
  current: BugFixWorkflowState,
  statusDetail: string,
): BugFixWorkflowState {
  return { ...current, state: "HUMAN_REQUIRED", statusDetail };
}

/** End automation because of an unrecoverable workflow failure. */
export function failed(current: BugFixWorkflowState, statusDetail: string): BugFixWorkflowState {
  return { ...current, state: "FAILED", statusDetail };
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
