import {
  repairing,
  humanRequired,
  type CiCallback,
  type BugFixWorkflowState,
} from "../../../../domain/workflow.js";
import type { RepositoryConfig } from "../../../../domain/repository.js";
import type { NormalizedBugTicket } from "../../../../domain/ticket.js";
import type { BugFixApplication } from "../../../../application/bugfix-application.js";
import { workspaceFromState } from "../../../../application/bugfix-application.js";
import { decideRepair } from "./repair-policy.js";
import { saveWorkflowState, type BugFixWorkflowContext } from "../state.js";
import { waitForCallback } from "../callbacks.js";
import { runApplicationStep } from "../../../application-step.js";

export type CiRepairResult =
  | { status: "succeeded"; state: BugFixWorkflowState }
  | { status: "human_required"; state: BugFixWorkflowState; detail: string };

export async function runCiRepairPhase(
  ctx: BugFixWorkflowContext,
  service: BugFixApplication,
  state: BugFixWorkflowState,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  callbackTimeoutMinutes: number,
): Promise<CiRepairResult> {
  let current = state;
  for (;;) {
    const callbackWait = await waitForCallback<CiCallback>(
      ctx,
      "jenkins",
      current.repairAttempt,
      callbackTimeoutMinutes,
    );
    if (callbackWait.status === "timed_out")
      return stopForHuman(
        ctx,
        current,
        `Jenkins did not report for repair attempt ${current.repairAttempt} within ${callbackTimeoutMinutes} minutes`,
      );
    const callback = callbackWait.callback;
    if (callback.result.status === "success") return { status: "succeeded", state: current };

    if (!callback.failure) {
      return stopForHuman(ctx, current, "Jenkins failed without compact failure details");
    }

    const decision = decideRepair(current, callback.failure, current.currentCommitSha ?? "unknown");
    if (decision.action === "human_required")
      return stopForHuman(
        ctx,
        humanRequired(
          { ...current, lastFailureFingerprint: callback.failure.fingerprint },
          decision.reason,
        ),
        decision.reason,
      );

    current = saveWorkflowState(ctx, repairing(current));
    const attempt = current.repairAttempt + 1;
    const stateToRepair = current;
    const failure = callback.failure;
    const repairResult = await runApplicationStep(
      ctx,
      `resume-codex-${attempt}`,
      () => service.continueHarness(stateToRepair, ticket, failure),
      { maxRetryAttempts: 2 },
    );
    const repairCommit = await runApplicationStep(
      ctx,
      `validate-and-commit-repair-${attempt}`,
      () => service.validateAndCommitRepair(stateToRepair, ticket, repository, repairResult),
      { maxRetryAttempts: 1 },
    );
    current = saveWorkflowState(
      ctx,
      service.createRepairState(stateToRepair, repairResult, repairCommit.commitSha, failure),
    );
    await runApplicationStep(
      ctx,
      `push-repair-${attempt}`,
      () => service.push(workspaceFromState(current)),
      {
        maxRetryAttempts: 3,
      },
    );
  }
}

function stopForHuman(
  ctx: BugFixWorkflowContext,
  state: BugFixWorkflowState,
  detail: string,
): CiRepairResult {
  const stopped = humanRequired(state, detail);
  saveWorkflowState(ctx, stopped);
  return { status: "human_required", state: stopped, detail };
}
