import type { CompactCiFailure, CiResult, SonarFinding } from "./ci.js";
import type { MergeRequest } from "./merge-request.js";
import type { TicketAnalysis } from "./analysis.js";

export type WorkflowStage =
  | "RECEIVED"
  | "CONTEXT_READY"
  | "ANALYZING"
  | "IMPLEMENTING"
  | "LOCAL_VALIDATION"
  | "MR_CREATED"
  | "CI_RUNNING"
  | "CI_FAILED"
  | "REPAIRING"
  | "REVIEWING"
  | "REVIEW_READY"
  | "DONE"
  | "HUMAN_REQUIRED"
  | "FAILED";

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
