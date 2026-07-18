import type { CompactCiFailure } from "../../../domain/ci.js";
import type { BugFixWorkflowState } from "../workflow-state.js";

export type RepairDecision = { action: "repair" } | { action: "human_required"; reason: string };

export function decideRepair(
  state: BugFixWorkflowState,
  failure: CompactCiFailure,
  currentCommitSha: string,
): RepairDecision {
  if (failure.category === "infrastructure" || failure.category === "timeout") {
    return {
      action: "human_required",
      reason: `CI failure is ${failure.category}; product code will not be changed`,
    };
  }

  if (state.repairAttempt >= state.maxRepairAttempts)
    return { action: "human_required", reason: "Maximum repair attempts reached" };

  if (
    state.lastFailureFingerprint === failure.fingerprint &&
    state.lastCommitAtFailure === currentCommitSha
  ) {
    return {
      action: "human_required",
      reason: "The same failure repeated without a meaningful code change",
    };
  }

  return { action: "repair" };
}
