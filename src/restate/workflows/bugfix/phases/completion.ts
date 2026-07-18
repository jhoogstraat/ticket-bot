import type {
  MergeRequestReviewCallback,
  SonarCallback,
  BugFixWorkflowState,
} from "../../../../domain/workflow.js";
import { done, humanRequired, reviewReady } from "../../../../domain/workflow.js";
import type { BugFixApplication } from "../../../../application/bugfix-application.js";
import { saveWorkflowState, type BugFixWorkflowContext } from "../state.js";
import { waitForCallback } from "../callbacks.js";
import { runApplicationStep } from "../../../application-step.js";

export type CompletionResult =
  | { status: "done"; state: BugFixWorkflowState }
  | { status: "human_required"; state: BugFixWorkflowState; detail: string };

export async function runCompletionPhase(
  ctx: BugFixWorkflowContext,
  service: BugFixApplication,
  state: BugFixWorkflowState,
  callbackTimeoutMinutes: number,
): Promise<CompletionResult> {
  const sonarWait = await waitForCallback<SonarCallback>(
    ctx,
    "sonarqube",
    state.repairAttempt,
    callbackTimeoutMinutes,
  );
  if (sonarWait.status === "timed_out")
    return stopForHuman(
      ctx,
      state,
      `SonarQube did not report for repair attempt ${state.repairAttempt} within ${callbackTimeoutMinutes} minutes`,
    );
  const sonar = sonarWait.callback;
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

  const reviewWait = await waitForCallback<MergeRequestReviewCallback>(
    ctx,
    "gitlab-review",
    state.repairAttempt,
    callbackTimeoutMinutes,
  );
  if (reviewWait.status === "timed_out")
    return stopForHuman(
      ctx,
      state,
      `GitLab did not report for repair attempt ${state.repairAttempt} within ${callbackTimeoutMinutes} minutes`,
    );
  const mergeRequestReview = reviewWait.callback;
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
  await runApplicationStep(
    ctx,
    "jira-link-merge-request",
    () => service.linkMergeRequestInJira(ready),
    { maxRetryAttempts: 3 },
  );
  const completed = await runApplicationStep(
    ctx,
    "jira-ready-to-merge",
    () => service.markJiraReadyToMerge(ready),
    {
      maxRetryAttempts: 3,
    },
  );
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
