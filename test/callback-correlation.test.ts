import { describe, expect, it } from "bun:test";
import type { BugFixWorkflowState, CallbackCorrelation } from "../src/domain/workflow.js";
import { emptyTokenUsage } from "../src/domain/workflow.js";
import {
  callbackPromiseName,
  isCurrentCallback,
} from "../src/restate/workflows/bugfix/callbacks.js";

const state: BugFixWorkflowState = {
  runId: "bugfix/ABC-1/1",
  issueKey: "ABC-1",
  generation: 1,
  repository: { id: "repo", cloneUrl: "git@example.test/repo.git", defaultBranch: "main" },
  currentCommitSha: "current-sha",
  state: "CI_RUNNING",
  repairAttempt: 2,
  reviewAttempt: 0,
  maxRepairAttempts: 3,
  tokenUsage: emptyTokenUsage(),
};
const correlation = (overrides: Partial<CallbackCorrelation> = {}): CallbackCorrelation => ({
  attempt: 2,
  commitSha: "current-sha",
  providerEventId: "provider-event-1",
  ...overrides,
});

describe("external callback correlation", () => {
  it("accepts only the callback for the current workflow revision and attempt", () => {
    expect(isCurrentCallback(state, correlation())).toBe(true);
    expect(isCurrentCallback(state, correlation({ attempt: 1 }))).toBe(false);
    expect(isCurrentCallback(state, correlation({ commitSha: "old-sha" }))).toBe(false);
  });

  it("uses a stable durable-promise name per callback type and attempt", () => {
    expect(callbackPromiseName("jenkins", 2)).toBe("jenkins-2");
    expect(callbackPromiseName("sonarqube", 2)).toBe("sonarqube-2");
    expect(callbackPromiseName("gitlab-review", 2)).toBe("gitlab-review-2");
  });
});
