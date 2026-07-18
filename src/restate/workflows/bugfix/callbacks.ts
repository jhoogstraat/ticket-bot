import * as restate from "@restatedev/restate-sdk";
import type { CallbackCorrelation, BugFixWorkflowState } from "../../../domain/workflow.js";
import type { BugFixWorkflowContext } from "./state.js";

export type CallbackKind = "jenkins" | "sonarqube" | "gitlab-review";

export function callbackPromiseName(kind: CallbackKind, attempt: number): string {
  return `${kind}-${attempt}`;
}

export function isCurrentCallback(
  state: BugFixWorkflowState,
  correlation: CallbackCorrelation,
): boolean {
  return (
    correlation.attempt === state.repairAttempt && correlation.commitSha === state.currentCommitSha
  );
}

export type CallbackWait<T extends object> =
  { status: "received"; callback: T } | { status: "timed_out" };

/** Wait durably for one correlated external callback without leaving a workflow stuck forever. */
export async function waitForCallback<T extends object>(
  ctx: BugFixWorkflowContext,
  kind: CallbackKind,
  attempt: number,
  timeoutMinutes: number,
): Promise<CallbackWait<T>> {
  return await restate.RestatePromise.race([
    ctx
      .promise<T>(callbackPromiseName(kind, attempt))
      .get()
      .map((callback) => {
        if (callback === undefined)
          throw new Error(
            `Callback promise ${callbackPromiseName(kind, attempt)} resolved without a value`,
          );
        return { status: "received" as const, callback };
      }),
    ctx
      .sleep({ minutes: timeoutMinutes }, `wait-for-${kind}-${attempt}-deadline`)
      .map(() => ({ status: "timed_out" as const })),
  ]);
}
