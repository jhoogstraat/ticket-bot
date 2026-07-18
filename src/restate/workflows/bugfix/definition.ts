import * as restate from "@restatedev/restate-sdk";
import { DomainError } from "../../../domain/errors.js";
import type {
  BugFixWorkflowState,
  CiCallback,
  MergeRequestReviewCallback,
  SonarCallback,
  StartBugFixInput,
} from "../../../domain/workflow.js";
import { emptyTokenUsage } from "../../../domain/workflow.js";
import type { BugFixApplication } from "../../../application/bugfix-application.js";
import { runCiRepairPhase } from "./phases/ci-repair.js";
import { runCompletionPhase } from "./phases/completion.js";
import { runInitialFix, publishInitialFix } from "./phases/initial-fix.js";
import { runReviewPhase } from "./phases/review.js";
import {
  saveWorkflowState,
  type BugFixWorkflowSharedContext,
  type BugFixWorkflowContext,
} from "./state.js";
import { callbackPromiseName, isCurrentCallback } from "./callbacks.js";
import { domainErrorCode, runApplicationStep } from "../../application-step.js";

export function createBugFixRestateWorkflow(
  service: BugFixApplication,
  {
    inactivityTimeoutMinutes = 60,
    callbackTimeoutMinutes = 90,
  }: { inactivityTimeoutMinutes?: number; callbackTimeoutMinutes?: number } = {},
) {
  return restate.workflow({
    name: "BugFixWorkflow",
    options: {
      ingressPrivate: true,
      inactivityTimeout: inactivityTimeoutMinutes * 60_000,
    },
    handlers: {
      run: restate.handlers.workflow.workflow(
        async (ctx: BugFixWorkflowContext, input: StartBugFixInput) => {
          const runId = workflowId(input.issueKey, input.generation);

          let state = await ctx.get("workflowState");
          if (state && isTerminal(state)) return workflowResult(runId, state);

          try {
            const ticket = await runApplicationStep(ctx, "load-normalized-ticket", () =>
              service.loadTicket(input.issueKey),
            );
            const repository = service.resolveRepository(ticket);

            if (!state) {
              const initial = await runInitialFix(
                ctx,
                service,
                runId,
                input.generation,
                ticket,
                repository,
              );
              if (initial.status === "human_required") return workflowResult(runId, initial.state);
              state = initial.state;

              const reviewed = await runReviewPhase(
                ctx,
                service,
                initial.state,
                ticket,
                repository,
              );
              if (reviewed.status === "human_required")
                return workflowResult(runId, reviewed.state);
              state = reviewed.state;

              state = await publishInitialFix(
                ctx,
                service,
                runId,
                ticket,
                repository,
                reviewed.state,
                initial.workspace,
                initial.harnessResult,
              );
            }

            const ci = await runCiRepairPhase(
              ctx,
              service,
              state,
              ticket,
              repository,
              callbackTimeoutMinutes,
            );
            if (ci.status === "human_required") return workflowResult(runId, ci.state);

            const completion = await runCompletionPhase(
              ctx,
              service,
              ci.state,
              callbackTimeoutMinutes,
            );
            return workflowResult(runId, completion.state);
          } catch (error) {
            if (error instanceof restate.CancelledError) throw error;
            if (!(error instanceof restate.TerminalError) && !(error instanceof DomainError))
              throw error;

            const detail = error instanceof Error ? error.message : String(error);
            const failed =
              state ??
              (await ctx.get("workflowState")) ??
              createFailureState(runId, input, error, detail);
            const nextState: BugFixWorkflowState = {
              ...failed,
              state: failed.state === "HUMAN_REQUIRED" ? "HUMAN_REQUIRED" : "FAILED",
              statusDetail: detail,
            };
            saveWorkflowState(ctx, nextState);
            return workflowResult(runId, nextState);
          }
        },
      ),

      onJenkins: restate.handlers.workflow.shared(
        async (ctx: BugFixWorkflowSharedContext, callback: CiCallback) => {
          const state = await ctx.get("workflowState");
          if (!state || !isCurrentCallback(state, callback.correlation)) return;
          await resolveOnce(ctx, callbackPromiseName("jenkins", state.repairAttempt), callback);
        },
      ),

      onSonarQube: restate.handlers.workflow.shared(
        async (ctx: BugFixWorkflowSharedContext, callback: SonarCallback) => {
          const state = await ctx.get("workflowState");
          if (!state || !isCurrentCallback(state, callback.correlation)) return;
          await resolveOnce(ctx, callbackPromiseName("sonarqube", state.repairAttempt), callback);
        },
      ),

      onGitLabReview: restate.handlers.workflow.shared(
        async (ctx: BugFixWorkflowSharedContext, callback: MergeRequestReviewCallback) => {
          const state = await ctx.get("workflowState");
          if (!state || !isCurrentCallback(state, callback.correlation)) return;
          await resolveOnce(
            ctx,
            callbackPromiseName("gitlab-review", state.repairAttempt),
            callback,
          );
        },
      ),

      status: restate.handlers.workflow.shared(
        async (ctx: BugFixWorkflowSharedContext) => await ctx.get("workflowState"),
      ),
    },
  });
}

function isTerminal(state: BugFixWorkflowState | null | undefined): boolean {
  return !!state && ["REVIEW_READY", "DONE", "HUMAN_REQUIRED", "FAILED"].includes(state.state);
}

function workflowResult(runId: string, state: BugFixWorkflowState) {
  return {
    runId,
    state: state.state,
    ...(state.statusDetail ? { detail: state.statusDetail } : {}),
  };
}

function createFailureState(
  runId: string,
  input: StartBugFixInput,
  error: unknown,
  detail: string,
): BugFixWorkflowState {
  const humanRequiredCodes = [
    "HUMAN_INPUT_REQUIRED",
    "HARNESS_BLOCKED",
    "REPAIR_LIMIT_REACHED",
    "REPEATED_FAILURE",
    "CI_INFRASTRUCTURE_FAILURE",
  ];
  const code = domainErrorCode(error);
  return {
    runId,
    issueKey: input.issueKey,
    generation: input.generation,
    repository: { id: "unresolved", cloneUrl: "", defaultBranch: "" },
    state: code && humanRequiredCodes.includes(code) ? "HUMAN_REQUIRED" : "FAILED",
    repairAttempt: 0,
    reviewAttempt: 0,
    maxRepairAttempts: 0,
    tokenUsage: emptyTokenUsage(),
    statusDetail: detail,
  };
}

export type BugFixRestateWorkflow = ReturnType<typeof createBugFixRestateWorkflow>;
export const workflowId = (issueKey: string, generation: number): string =>
  `bugfix/${issueKey}/${generation}`;

async function resolveOnce(
  ctx: BugFixWorkflowSharedContext,
  promiseName: string,
  callback: unknown,
): Promise<void> {
  const promise = ctx.promise<unknown>(promiseName);
  if ((await promise.peek()) === undefined) await promise.resolve(callback);
}
