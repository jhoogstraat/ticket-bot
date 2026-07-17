import * as restate from "@restatedev/restate-sdk";
import { DomainError } from "../domain/errors.js";
import type {
  BugFixWorkflowState,
  CiCallback,
  MergeRequestReviewCallback,
  SonarCallback,
  StartBugFixInput,
} from "../domain/workflow.js";
import { emptyTokenUsage } from "../domain/workflow.js";
import type { BugFixService } from "../services/bug-fix-service.js";
import { runCiRepairPhase } from "./ci-repair-phase.js";
import { runCompletionPhase } from "./completion-phase.js";
import { runInitialFix, publishInitialFix } from "./initial-fix-phase.js";
import { runReviewPhase } from "./review-phase.js";
import {
  saveWorkflowState,
  type BugFixWorkflowSharedContext,
  type BugFixWorkflowContext,
} from "./workflow-context.js";

export function createBugFixWorkflow(service: BugFixService) {
  return restate.workflow({
    name: "BugFixWorkflow",
    handlers: {
      run: restate.handlers.workflow.workflow(
        async (ctx: BugFixWorkflowContext, input: StartBugFixInput) => {
          const runId = workflowId(input.issueKey, input.generation);
          let state = await ctx.get("workflowState");
          if (state && isTerminal(state)) return workflowResult(runId, state);

          try {
            const ticket = await ctx.run("load-normalized-ticket", () =>
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

              const reviewed = await runReviewPhase(
                ctx,
                service,
                initial.state,
                ticket,
                repository,
              );
              if (reviewed.status === "human_required")
                return workflowResult(runId, reviewed.state);

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

            const ci = await runCiRepairPhase(ctx, service, state, ticket, repository);
            if (ci.status === "human_required") return workflowResult(runId, ci.state);

            const completion = await runCompletionPhase(ctx, service, ci.state);
            return workflowResult(runId, completion.state);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const failed = state ?? createFailureState(runId, input, error, detail);
            const nextState = {
              ...failed,
              state:
                failed.state === "HUMAN_REQUIRED"
                  ? ("HUMAN_REQUIRED" as const)
                  : ("FAILED" as const),
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
          if (!state) throw new restate.TerminalError("Workflow has not initialized");
          if (isStaleCommit(callback.result.commitSha, state.currentCommitSha)) return;
          await ctx.promise<CiCallback>(`jenkins-${state.repairAttempt}`).resolve(callback);
        },
      ),

      onSonarQube: restate.handlers.workflow.shared(
        async (ctx: BugFixWorkflowSharedContext, callback: SonarCallback) => {
          const state = await ctx.get("workflowState");
          if (!state) throw new restate.TerminalError("Workflow has not initialized");
          await ctx.promise<SonarCallback>(`sonarqube-${state.repairAttempt}`).resolve(callback);
        },
      ),

      onGitLabReview: restate.handlers.workflow.shared(
        async (ctx: BugFixWorkflowSharedContext, callback: MergeRequestReviewCallback) => {
          const state = await ctx.get("workflowState");
          if (!state) throw new restate.TerminalError("Workflow has not initialized");
          if (isStaleCommit(callback.commitSha, state.currentCommitSha)) return;
          await ctx
            .promise<MergeRequestReviewCallback>(`gitlab-review-${state.repairAttempt}`)
            .resolve(callback);
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

function isStaleCommit(
  callbackCommit: string | undefined,
  currentCommit: string | undefined,
): boolean {
  return !!callbackCommit && !!currentCommit && callbackCommit !== currentCommit;
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
  return {
    runId,
    issueKey: input.issueKey,
    generation: input.generation,
    repository: { id: "unresolved", cloneUrl: "", defaultBranch: "" },
    state:
      error instanceof DomainError && humanRequiredCodes.includes(error.code)
        ? "HUMAN_REQUIRED"
        : "FAILED",
    repairAttempt: 0,
    reviewAttempt: 0,
    maxRepairAttempts: 0,
    tokenUsage: emptyTokenUsage(),
    statusDetail: detail,
  };
}

export type BugFixWorkflow = ReturnType<typeof createBugFixWorkflow>;
export const workflowId = (issueKey: string, generation: number): string =>
  `bug-fix/${issueKey}/${generation}`;
