import { describe, expect, it } from "bun:test";
import type { MergeRequest } from "../src/domain/merge-request.js";
import type { BugFixWorkflowState } from "../src/domain/workflow.js";
import {
  done,
  emptyTokenUsage,
  failed,
  humanRequired,
  published,
  repairing,
  reviewReady,
} from "../src/domain/workflow.js";

const state = (statusDetail?: string): BugFixWorkflowState => ({
  runId: "bug-fix/ABC-123/1",
  issueKey: "ABC-123",
  generation: 1,
  repository: { id: "repo", cloneUrl: "git@example.test/repo.git", defaultBranch: "main" },
  branchName: "fix/ABC-123",
  currentCommitSha: "abc123",
  state: "REVIEWING",
  repairAttempt: 1,
  reviewAttempt: 2,
  maxRepairAttempts: 3,
  tokenUsage: emptyTokenUsage(),
  ...(statusDetail === undefined ? {} : { statusDetail }),
});

describe("workflow state transitions", () => {
  it("moves to states that explain their outcome without mutating the current state", () => {
    const current = state("previous detail");

    expect(humanRequired(current, "input needed")).toMatchObject({
      state: "HUMAN_REQUIRED",
      statusDetail: "input needed",
      currentCommitSha: "abc123",
    });
    expect(failed(current, "unexpected failure")).toMatchObject({
      state: "FAILED",
      statusDetail: "unexpected failure",
      currentCommitSha: "abc123",
    });
    expect(reviewReady(current, "checks passed")).toMatchObject({
      state: "REVIEW_READY",
      statusDetail: "checks passed",
      currentCommitSha: "abc123",
    });
    expect(done(current, "ready to merge")).toMatchObject({
      state: "DONE",
      statusDetail: "ready to merge",
      currentCommitSha: "abc123",
    });
    expect(current).toEqual(state("previous detail"));
  });

  it("marks a repair in progress while preserving workflow context", () => {
    expect(repairing(state("CI failed"))).toEqual({
      ...state("CI failed"),
      state: "REPAIRING",
    });
  });

  it("records publication and clears detail from the previous stage", () => {
    const mergeRequest: MergeRequest = {
      projectId: "repo",
      iid: 42,
      url: "https://gitlab.example.test/repo/-/merge_requests/42",
    };

    expect(published(state("review accepted"), mergeRequest)).toEqual({
      ...state(),
      state: "CI_RUNNING",
      mergeRequest,
    });
  });
});
