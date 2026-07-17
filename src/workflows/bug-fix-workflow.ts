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
import { workspaceFromState, type BugFixService } from "../services/bug-fix-service.js";
import { decideRepair } from "./repair-policy.js";

interface WorkflowStateStore {
  workflowState: BugFixWorkflowState;
}

export function createBugFixWorkflow(service: BugFixService) {
  return restate.workflow({
    name: "BugFixWorkflow",
    handlers: {
      run: restate.handlers.workflow.workflow(
        async (ctx: restate.WorkflowContext<WorkflowStateStore>, input: StartBugFixInput) => {
          const runId = workflowId(input.issueKey, input.generation);
          let state = await ctx.get("workflowState");
          if (state && ["REVIEW_READY", "DONE", "HUMAN_REQUIRED", "FAILED"].includes(state.state))
            return {
              runId,
              state: state.state,
              ...(state.statusDetail ? { detail: state.statusDetail } : {}),
            };
          try {
            const ticket = await ctx.run("load-normalized-ticket", () =>
              service.loadTicket(input.issueKey),
            );
            const repository = service.resolveRepository(ticket);
            let current: BugFixWorkflowState;
            if (!state) {
              const workspace = await ctx.run(
                "create-workspace",
                () => service.createWorkspace(runId, ticket, repository),
                { maxRetryAttempts: 3 },
              );
              const investigation = await ctx.run(
                "investigate-ticket",
                () => service.investigate(ticket, repository, workspace),
                { maxRetryAttempts: 2 },
              );
              if (!investigation.gate.actionable) {
                current = {
                  runId,
                  issueKey: ticket.key,
                  generation: input.generation,
                  repository: {
                    id: repository.id,
                    cloneUrl: repository.cloneUrl,
                    defaultBranch: repository.defaultBranch,
                  },
                  branchName: workspace.branchName,
                  baseCommitSha: workspace.baseCommitSha,
                  harness: { provider: "codex", workspaceId: workspace.id },
                  analysis: investigation.analysis,
                  state: "HUMAN_REQUIRED",
                  repairAttempt: 0,
                  reviewAttempt: 0,
                  maxRepairAttempts: repository.limits.maxRepairAttempts,
                  tokenUsage: emptyTokenUsage(),
                  statusDetail: investigation.gate.reason,
                };
                state = current;
                ctx.set("workflowState", current);
                return { runId, state: current.state, detail: current.statusDetail };
              }
              await ctx.run("claim-jira-ticket", () => service.claimTicket(ticket.key), {
                maxRetryAttempts: 3,
              });
              const implementationWorkspace = await ctx.run(
                "activate-focused-branch",
                () => service.activateWorkspace(workspace),
                { maxRetryAttempts: 2 },
              );
              const harnessResult = await ctx.run(
                "start-codex",
                () =>
                  service.startHarness(
                    ticket,
                    repository,
                    implementationWorkspace,
                    investigation.analysis,
                  ),
                { maxRetryAttempts: 2 },
              );
              const commit = await ctx.run(
                "validate-and-commit",
                () =>
                  service.validateAndCommit(
                    implementationWorkspace,
                    ticket,
                    repository,
                    harnessResult,
                  ),
                { maxRetryAttempts: 1 },
              );
              current = service.createImplementationState(
                runId,
                input.generation,
                ticket,
                repository,
                implementationWorkspace,
                investigation.analysis,
                harnessResult,
                commit.commitSha,
              );
              for (;;) {
                const cycle = current.reviewAttempt;
                const reviewed = await ctx.run(
                  `independent-review-${cycle}`,
                  () => service.review(current, ticket, []),
                  { maxRetryAttempts: 2 },
                );
                if (reviewed.review.verdict === "accept") {
                  current = reviewed.state;
                  break;
                }
                if (reviewed.review.verdict === "re-investigate") {
                  current = {
                    ...reviewed.state,
                    state: "HUMAN_REQUIRED",
                    statusDetail: `Review invalidated the analysis: ${reviewed.review.summary}`,
                  };
                  state = current;
                  ctx.set("workflowState", current);
                  return { runId, state: current.state, detail: current.statusDetail };
                }
                current = await ctx.run(
                  `address-review-${cycle + 1}`,
                  () => service.reviseBeforePublish(current, ticket, repository, reviewed.review),
                  { maxRetryAttempts: 1 },
                );
                state = current;
                ctx.set("workflowState", current);
              }
              await ctx.run("push-branch", () => service.push(implementationWorkspace), {
                maxRetryAttempts: 3,
              });
              const mergeRequest = await ctx.run(
                "create-draft-merge-request",
                () =>
                  service.createMergeRequest(
                    runId,
                    ticket,
                    repository,
                    implementationWorkspace,
                    harnessResult,
                  ),
                { maxRetryAttempts: 3 },
              );
              current = service.createPublishedState(current, mergeRequest);
            } else current = state;
            state = current;
            ctx.set("workflowState", current);

            for (;;) {
              const callback: CiCallback = await ctx.promise<CiCallback>(
                `jenkins-${current.repairAttempt}`,
              );
              if (callback.result.status === "success") break;
              if (!callback.failure) {
                current = {
                  ...current,
                  state: "HUMAN_REQUIRED",
                  statusDetail: "Jenkins failed without compact failure details",
                };
                state = current;
                ctx.set("workflowState", current);
                return { runId, state: current.state, detail: current.statusDetail };
              }
              const currentCommit = current.currentCommitSha ?? "unknown";
              const decision = decideRepair(current, callback.failure, currentCommit);
              if (decision.action === "human_required") {
                current = {
                  ...current,
                  state: "HUMAN_REQUIRED",
                  statusDetail: decision.reason,
                  lastFailureFingerprint: callback.failure.fingerprint,
                };
                state = current;
                ctx.set("workflowState", current);
                return { runId, state: current.state, detail: decision.reason };
              }
              current = { ...current, state: "REPAIRING" };
              state = current;
              ctx.set("workflowState", current);
              const stateToRepair = current;
              const failure = callback.failure;
              const attempt = current.repairAttempt + 1;
              const repairResult = await ctx.run(
                `resume-codex-${attempt}`,
                () => service.continueHarness(stateToRepair, ticket, failure),
                { maxRetryAttempts: 2 },
              );
              const repairCommit = await ctx.run(
                `validate-and-commit-repair-${attempt}`,
                () =>
                  service.validateAndCommitRepair(stateToRepair, ticket, repository, repairResult),
                { maxRetryAttempts: 1 },
              );
              current = service.createRepairState(
                stateToRepair,
                repairResult,
                repairCommit.commitSha,
                failure,
              );
              state = current;
              ctx.set("workflowState", current);
              await ctx.run(
                `push-repair-${attempt}`,
                () => service.push(workspaceFromState(current)),
                { maxRetryAttempts: 3 },
              );
            }

            const sonar = await ctx.promise<SonarCallback>(`sonarqube-${current.repairAttempt}`);
            if (
              sonar.qualityGate === "failed" ||
              sonar.findings.some((finding) => finding.qualityGateFailure)
            ) {
              current = {
                ...current,
                state: "HUMAN_REQUIRED",
                statusDetail:
                  "SonarQube has unresolved latest-commit findings; product code was not changed without a focused diagnosis",
              };
              state = current;
              ctx.set("workflowState", current);
              return { runId, state: current.state, detail: current.statusDetail };
            }
            const mergeRequestReview = await ctx.promise<MergeRequestReviewCallback>(
              `gitlab-review-${current.repairAttempt}`,
            );
            if (!mergeRequestReview.requiredFeedbackResolved) {
              current = {
                ...current,
                state: "HUMAN_REQUIRED",
                statusDetail:
                  mergeRequestReview.detail ?? "Required merge-request feedback remains unresolved",
              };
              state = current;
              ctx.set("workflowState", current);
              return { runId, state: current.state, detail: current.statusDetail };
            }
            const ready = {
              ...current,
              state: "REVIEW_READY" as const,
              statusDetail: "Latest pipeline succeeded with no unresolved required feedback",
            };
            current = await ctx.run("jira-ready-to-merge", () => service.handoff(ready), {
              maxRetryAttempts: 3,
            });
            state = current;
            ctx.set("workflowState", current);
            return {
              runId,
              state: current.state,
              ...(current.statusDetail ? { detail: current.statusDetail } : {}),
            };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const failed: BugFixWorkflowState = state ?? {
              runId,
              issueKey: input.issueKey,
              generation: input.generation,
              repository: { id: "unresolved", cloneUrl: "", defaultBranch: "" },
              state:
                error instanceof DomainError &&
                [
                  "HUMAN_INPUT_REQUIRED",
                  "HARNESS_BLOCKED",
                  "REPAIR_LIMIT_REACHED",
                  "REPEATED_FAILURE",
                  "CI_INFRASTRUCTURE_FAILURE",
                ].includes(error.code)
                  ? "HUMAN_REQUIRED"
                  : "FAILED",
              repairAttempt: 0,
              reviewAttempt: 0,
              maxRepairAttempts: 0,
              tokenUsage: emptyTokenUsage(),
              statusDetail: detail,
            };
            state = {
              ...failed,
              state: failed.state === "HUMAN_REQUIRED" ? "HUMAN_REQUIRED" : "FAILED",
              statusDetail: detail,
            };
            ctx.set("workflowState", state);
            return { runId, state: state.state, detail };
          }
        },
      ),

      onJenkins: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext<WorkflowStateStore>, callback: CiCallback) => {
          const state = await ctx.get("workflowState");
          if (!state) throw new restate.TerminalError("Workflow has not initialized");
          if (
            callback.result.commitSha &&
            state.currentCommitSha &&
            callback.result.commitSha !== state.currentCommitSha
          )
            return;
          await ctx.promise<CiCallback>(`jenkins-${state.repairAttempt}`).resolve(callback);
        },
      ),

      onSonarQube: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext<WorkflowStateStore>, callback: SonarCallback) => {
          const state = await ctx.get("workflowState");
          if (!state) throw new restate.TerminalError("Workflow has not initialized");
          await ctx.promise<SonarCallback>(`sonarqube-${state.repairAttempt}`).resolve(callback);
        },
      ),

      onGitLabReview: restate.handlers.workflow.shared(
        async (
          ctx: restate.WorkflowSharedContext<WorkflowStateStore>,
          callback: MergeRequestReviewCallback,
        ) => {
          const state = await ctx.get("workflowState");
          if (!state) throw new restate.TerminalError("Workflow has not initialized");
          if (
            callback.commitSha &&
            state.currentCommitSha &&
            callback.commitSha !== state.currentCommitSha
          )
            return;
          await ctx
            .promise<MergeRequestReviewCallback>(`gitlab-review-${state.repairAttempt}`)
            .resolve(callback);
        },
      ),

      status: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext<WorkflowStateStore>) =>
          await ctx.get("workflowState"),
      ),
    },
  });
}

export type BugFixWorkflow = ReturnType<typeof createBugFixWorkflow>;
export const workflowId = (issueKey: string, generation: number): string =>
  `bug-fix/${issueKey}/${generation}`;
