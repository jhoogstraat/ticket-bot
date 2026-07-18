import type { RepositoryConfig } from "../../../../domain/repository.js";
import type { NormalizedBugTicket } from "../../../../domain/ticket.js";
import { humanRequired, type BugFixWorkflowState } from "../../../../domain/workflow.js";
import type { BugFixApplication } from "../../../../application/bugfix-application.js";
import { saveWorkflowState, type BugFixWorkflowContext } from "../state.js";
import { runApplicationStep } from "../../../application-step.js";

export type ReviewPhaseResult =
  | { status: "accepted"; state: BugFixWorkflowState }
  | { status: "human_required"; state: BugFixWorkflowState; detail: string };

export async function runReviewPhase(
  ctx: BugFixWorkflowContext,
  service: BugFixApplication,
  state: BugFixWorkflowState,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
): Promise<ReviewPhaseResult> {
  let current = state;
  for (;;) {
    const cycle = current.reviewAttempt;
    const reviewed = await runApplicationStep(
      ctx,
      `independent-review-${cycle}`,
      () => service.review(current, ticket, []),
      { maxRetryAttempts: 2 },
    );
    if (reviewed.review.verdict === "accept") return { status: "accepted", state: reviewed.state };

    if (reviewed.review.verdict === "re-investigate") {
      const detail = `Review invalidated the analysis: ${reviewed.review.summary}`;
      const stopped = humanRequired(reviewed.state, detail);
      saveWorkflowState(ctx, stopped);
      return { status: "human_required", state: stopped, detail };
    }

    current = await runApplicationStep(
      ctx,
      `address-review-${cycle + 1}`,
      () => service.reviseBeforePublish(current, ticket, repository, reviewed.review),
      { maxRetryAttempts: 1 },
    );
    saveWorkflowState(ctx, current);
  }
}
