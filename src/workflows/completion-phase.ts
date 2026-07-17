import type {
  MergeRequestReviewCallback,
  SonarCallback,
  BugFixWorkflowState,
} from "../domain/workflow.js";
import { done, humanRequired, reviewReady } from "../domain/workflow.js";
import type { BugFixService } from "../services/bug-fix-service.js";
import { saveWorkflowState, type BugFixWorkflowContext } from "./workflow-context.js";

export type CompletionResult =
  | { status: "done"; state: BugFixWorkflowState }
  | { status: "human_required"; state: BugFixWorkflowState; detail: string };

export async function runCompletionPhase(
  ctx: BugFixWorkflowContext,
  service: BugFixService,
  state: BugFixWorkflowState,
): Promise<CompletionResult> {
  const sonar = await ctx.promise<SonarCallback>(`sonarqube-${state.repairAttempt}`);
  if (
    sonar.qualityGate === "failed" ||
    sonar.findings.some((finding) => finding.qualityGateFailure)
  ) {
    return stopForHuman(
      ctx,
      state,
      "SonarQube has unresolved latest-commit findings; product code was not changed without a focused diagnosis",
    );
  }

  const mergeRequestReview = await ctx.promise<MergeRequestReviewCallback>(
    `gitlab-review-${state.repairAttempt}`,
  );
  if (!mergeRequestReview.requiredFeedbackResolved) {
    return stopForHuman(
      ctx,
      state,
      mergeRequestReview.detail ?? "Required merge-request feedback remains unresolved",
    );
  }

  const ready = saveWorkflowState(
    ctx,
    reviewReady(state, "Latest pipeline succeeded with no unresolved required feedback"),
  );
  const completed = await ctx.run("jira-ready-to-merge", () => service.handoff(ready), {
    maxRetryAttempts: 3,
  });
  return {
    status: "done",
    state: saveWorkflowState(
      ctx,
      done(completed, completed.statusDetail ?? "Ready to merge; merge remains a human action"),
    ),
  };
}

function stopForHuman(
  ctx: BugFixWorkflowContext,
  state: BugFixWorkflowState,
  detail: string,
): CompletionResult {
  const stopped = humanRequired(state, detail);
  saveWorkflowState(ctx, stopped);
  return { status: "human_required", state: stopped, detail };
}
