import { describe, expect, it } from "bun:test";
import type { CompactCiFailure } from "../src/domain/ci.js";
import type { BugFixWorkflowState } from "../src/domain/workflow.js";
import { emptyTokenUsage } from "../src/domain/workflow.js";
import { decideRepair } from "../src/workflows/repair-policy.js";

const state: BugFixWorkflowState = {
  runId: "r",
  issueKey: "A-1",
  generation: 1,
  repository: { id: "r", cloneUrl: "x", defaultBranch: "main" },
  state: "CI_FAILED",
  repairAttempt: 0,
  reviewAttempt: 0,
  maxRepairAttempts: 3,
  tokenUsage: emptyTokenUsage(),
};
const failure = (category: CompactCiFailure["category"], fingerprint = "f"): CompactCiFailure => ({
  provider: "jenkins",
  buildId: "1",
  category,
  failedTests: [],
  compilerErrors: [],
  logExcerpt: "",
  removedLineCount: 0,
  fingerprint,
});
describe("repair policy", () => {
  it("repairs code failures", () =>
    expect(decideRepair(state, failure("test"), "a").action).toBe("repair"));
  it("stops for infrastructure", () =>
    expect(decideRepair(state, failure("infrastructure"), "a").action).toBe("human_required"));
  it("stops repeated unchanged failures", () =>
    expect(
      decideRepair(
        { ...state, lastFailureFingerprint: "f", lastCommitAtFailure: "a" },
        failure("test"),
        "a",
      ).action,
    ).toBe("human_required"));
  it("stops at the repair limit", () =>
    expect(decideRepair({ ...state, repairAttempt: 3 }, failure("test"), "a").action).toBe(
      "human_required",
    ));
});
