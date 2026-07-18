import * as restate from "@restatedev/restate-sdk";
import {
  analysisMarkdown,
  applyConfidenceGate,
  type ConfidenceGateDecision,
  type TicketAnalysis,
} from "../../../domain/analysis.js";
import type { CompactCiFailure, SonarFinding } from "../../../domain/ci.js";
import { DomainError, type DomainErrorCode } from "../../../domain/errors.js";
import type {
  CodingHarness,
  HarnessReviewResult,
  HarnessRunResult,
} from "../../../domain/harness.js";
import { usedTokens } from "../../../domain/harness.js";
import type { MergeRequest } from "../../../domain/merge-request.js";
import type { RepositoryConfig } from "../../../domain/repository.js";
import type { NormalizedBugTicket } from "../../../domain/ticket.js";
import {
  addTokenUsage,
  done,
  emptyTokenUsage,
  humanRequired,
  published,
  repairing,
  reviewReady,
  type BugFixWorkflowState,
  type CallbackCorrelation,
  type CiCallback,
  type MergeRequestReviewCallback,
  type SonarCallback,
  type StartBugFixInput,
} from "../../../domain/workflow.js";
import type { GitLabClient } from "../../../integrations/gitlab/gitlab-client.js";
import type { JiraClient } from "../../../integrations/jira/jira-client.js";
import { normalizeJiraIssue } from "../../../integrations/jira/jira-normalizer.js";
import type { ExecutionRunner, Workspace } from "../../../runner/execution-runner.js";
import { WorkspaceManager, type WorkspaceInspection } from "../../../runner/workspace-manager.js";

const domainCodeMetadataKey = "ticket-bot.domain-code";

interface WorkflowStateStore {
  workflowState?: BugFixWorkflowState;
}

type BugFixWorkflowContext = restate.WorkflowContext<WorkflowStateStore>;
type BugFixWorkflowSharedContext = restate.WorkflowSharedContext<WorkflowStateStore>;
type CallbackKind = "jenkins" | "sonarqube" | "gitlab-review";

export interface BugFixWorkflowDependencies {
  jira: JiraClient;
  gitlab: GitLabClient;
  harness: CodingHarness;
  runner: ExecutionRunner;
  workspaces: WorkspaceManager;
  resolveRepository(ticket: NormalizedBugTicket): RepositoryConfig;
  actionableRepositoryId: string;
}

export function createBugFixRestateWorkflow(
  dependencies: BugFixWorkflowDependencies,
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
      asTerminalError: (error) =>
        error instanceof DomainError
          ? new restate.TerminalError(error.message, {
              errorCode: 422,
              metadata: { [domainCodeMetadataKey]: error.code },
            })
          : undefined,
    },
    handlers: {
      run: restate.handlers.workflow.workflow(
        async (ctx: BugFixWorkflowContext, input: StartBugFixInput) => {
          const runId = workflowId(input.issueKey, input.generation);
          let state = await ctx.get("workflowState");
          if (state && isTerminal(state)) return workflowResult(runId, state);

          try {
            const ticket = await ctx.run("load-normalized-ticket", async () =>
              normalizeJiraIssue(await dependencies.jira.getIssue(input.issueKey)),
            );
            const repository = dependencies.resolveRepository(ticket);

            if (!state) {
              const investigationWorkspace = await ctx.run(
                "create-workspace",
                () =>
                  dependencies.runner.createWorkspace({
                    workflowId: runId,
                    issueKey: ticket.key,
                    shortSlug: ticket.summary,
                    repository,
                  }),
                { maxRetryAttempts: 3 },
              );
              const investigation = await ctx.run(
                "investigate-ticket",
                () => investigateTicket(dependencies, ticket, repository, investigationWorkspace),
                { maxRetryAttempts: 2 },
              );

              if (!investigation.gate.actionable) {
                state = humanRequired(
                  initialState(
                    runId,
                    input.generation,
                    ticket,
                    repository,
                    investigationWorkspace,
                    investigation.analysis,
                  ),
                  investigation.gate.reason,
                );
                ctx.set("workflowState", state);
                return workflowResult(runId, state);
              }

              await ctx.run("claim-jira-ticket", () => dependencies.jira.claimIssue(ticket.key), {
                maxRetryAttempts: 3,
              });
              const workspace = await ctx.run(
                "activate-focused-branch",
                () => dependencies.runner.activateWorkspace(investigationWorkspace),
                { maxRetryAttempts: 2 },
              );
              const harnessResult = await ctx.run(
                "start-codex",
                () =>
                  startHarness(dependencies, ticket, repository, workspace, investigation.analysis),
                { maxRetryAttempts: 2 },
              );
              const commitSha = await ctx.run(
                "validate-and-commit",
                () => validateAndCommit(dependencies, workspace, ticket, repository, harnessResult),
                { maxRetryAttempts: 1 },
              );
              let reviewState = implementationState(
                runId,
                input.generation,
                ticket,
                repository,
                workspace,
                investigation.analysis,
                harnessResult,
                commitSha,
              );
              state = reviewState;
              ctx.set("workflowState", reviewState);

              for (;;) {
                const review = await ctx.run(
                  `independent-review-${reviewState.reviewAttempt}`,
                  () => reviewPatch(dependencies, reviewState, ticket, []),
                  { maxRetryAttempts: 2 },
                );
                if (review.verdict === "accept") {
                  reviewState = reviewReady(review.state, review.summary);
                  break;
                }
                if (review.verdict === "re-investigate") {
                  reviewState = humanRequired(
                    review.state,
                    `Review invalidated the analysis: ${review.summary}`,
                  );
                  state = reviewState;
                  ctx.set("workflowState", reviewState);
                  return workflowResult(runId, reviewState);
                }

                reviewState = await ctx.run(
                  `address-review-${reviewState.reviewAttempt + 1}`,
                  () => revisePatch(dependencies, review.state, ticket, repository, review),
                  { maxRetryAttempts: 1 },
                );
                state = reviewState;
                ctx.set("workflowState", reviewState);
              }

              await ctx.run(
                "push-branch",
                () => dependencies.workspaces.push(workspaceFromState(reviewState)),
                { maxRetryAttempts: 3 },
              );
              const mergeRequest = await ctx.run(
                "create-draft-merge-request",
                () =>
                  createMergeRequest(
                    dependencies,
                    runId,
                    ticket,
                    repository,
                    reviewState,
                    harnessResult,
                  ),
                { maxRetryAttempts: 3 },
              );
              state = published(reviewState, mergeRequest);
              ctx.set("workflowState", state);
            }

            for (;;) {
              const jenkins = await waitForCallback<CiCallback>(
                ctx,
                "jenkins",
                state.repairAttempt,
                callbackTimeoutMinutes,
                ctx.promise<CiCallback>(callbackPromiseName("jenkins", state.repairAttempt)).get(),
              );
              if (jenkins.status === "timed_out") {
                state = stopForHuman(
                  state,
                  `Jenkins did not report for repair attempt ${state.repairAttempt} within ${callbackTimeoutMinutes} minutes`,
                );
                ctx.set("workflowState", state);
                return workflowResult(runId, state);
              }
              if (jenkins.callback.result.status === "success") break;
              if (!jenkins.callback.failure) {
                state = stopForHuman(state, "Jenkins failed without compact failure details");
                ctx.set("workflowState", state);
                return workflowResult(runId, state);
              }

              const failure = jenkins.callback.failure;
              const decision = decideRepair(state, failure, state.currentCommitSha ?? "unknown");
              if (decision.action === "human_required") {
                state = stopForHuman(
                  { ...state, lastFailureFingerprint: failure.fingerprint },
                  decision.reason,
                );
                ctx.set("workflowState", state);
                return workflowResult(runId, state);
              }

              state = repairing(state);
              ctx.set("workflowState", state);
              const attempt = state.repairAttempt + 1;
              const stateToRepair = state;
              const repair = await ctx.run(
                `resume-codex-${attempt}`,
                () => continueHarness(dependencies, stateToRepair, ticket, failure),
                { maxRetryAttempts: 2 },
              );
              const repairCommitSha = await ctx.run(
                `validate-and-commit-repair-${attempt}`,
                () =>
                  validateAndCommitRepair(dependencies, stateToRepair, ticket, repository, repair),
                { maxRetryAttempts: 1 },
              );
              state = repairState(stateToRepair, repair, repairCommitSha, failure);
              ctx.set("workflowState", state);
              const stateToPush = state;
              await ctx.run(
                `push-repair-${attempt}`,
                () => dependencies.workspaces.push(workspaceFromState(stateToPush)),
                { maxRetryAttempts: 3 },
              );
            }

            const sonar = await waitForCallback<SonarCallback>(
              ctx,
              "sonarqube",
              state.repairAttempt,
              callbackTimeoutMinutes,
              ctx
                .promise<SonarCallback>(callbackPromiseName("sonarqube", state.repairAttempt))
                .get(),
            );
            if (sonar.status === "timed_out") {
              state = stopForHuman(
                state,
                `SonarQube did not report for repair attempt ${state.repairAttempt} within ${callbackTimeoutMinutes} minutes`,
              );
              ctx.set("workflowState", state);
              return workflowResult(runId, state);
            }
            if (
              sonar.callback.qualityGate === "failed" ||
              sonar.callback.findings.some((finding) => finding.qualityGateFailure)
            ) {
              state = stopForHuman(
                state,
                "SonarQube has unresolved latest-commit findings; product code was not changed without a focused diagnosis",
              );
              ctx.set("workflowState", state);
              return workflowResult(runId, state);
            }

            const mergeRequestReview = await waitForCallback<MergeRequestReviewCallback>(
              ctx,
              "gitlab-review",
              state.repairAttempt,
              callbackTimeoutMinutes,
              ctx
                .promise<MergeRequestReviewCallback>(
                  callbackPromiseName("gitlab-review", state.repairAttempt),
                )
                .get(),
            );
            if (mergeRequestReview.status === "timed_out") {
              state = stopForHuman(
                state,
                `GitLab did not report for repair attempt ${state.repairAttempt} within ${callbackTimeoutMinutes} minutes`,
              );
              ctx.set("workflowState", state);
              return workflowResult(runId, state);
            }
            if (!mergeRequestReview.callback.requiredFeedbackResolved) {
              state = stopForHuman(
                state,
                mergeRequestReview.callback.detail ??
                  "Required merge-request feedback remains unresolved",
              );
              ctx.set("workflowState", state);
              return workflowResult(runId, state);
            }

            state = reviewReady(
              state,
              "Latest pipeline succeeded with no unresolved required feedback",
            );
            ctx.set("workflowState", state);
            const readyState = state;
            await ctx.run(
              "jira-link-merge-request",
              () => linkMergeRequestInJira(dependencies, readyState),
              { maxRetryAttempts: 3 },
            );
            await ctx.run(
              "jira-ready-to-merge",
              () => markJiraReadyToMerge(dependencies, readyState),
              { maxRetryAttempts: 3 },
            );
            state = done(readyState, "Ready to merge; merge remains a human action");
            ctx.set("workflowState", state);
            return workflowResult(runId, state);
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
            ctx.set("workflowState", nextState);
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

async function investigateTicket(
  dependencies: BugFixWorkflowDependencies,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  workspace: Workspace,
): Promise<{ analysis: TicketAnalysis; gate: ConfidenceGateDecision }> {
  const analysis = await dependencies.runner.analyzeHarness(dependencies.harness, {
    ticket,
    workspacePath: workspace.path,
    repositoryId: repository.id,
    repositoryInstructions: {
      buildCommands: repository.buildCommands,
      testCommands: repository.testCommands,
      lintCommands: repository.lintCommands,
    },
    limits: {
      maxAgentTurns: repository.limits.maxAgentTurns,
      maxExecutionMinutes: repository.limits.maxExecutionMinutes,
    },
  });
  if (analysis.issueKey !== ticket.key)
    throw new DomainError(
      "HARNESS_BLOCKED",
      `Analysis returned ${analysis.issueKey} for ${ticket.key}`,
    );
  const gate = applyConfidenceGate(analysis, repository.id, dependencies.actionableRepositoryId);
  await dependencies.workspaces.writeArtifact(
    workspace,
    `ticket-analysis/${ticket.key}/ANALYSIS.md`,
    analysisMarkdown(ticket, analysis, gate),
  );
  return { analysis, gate };
}

async function startHarness(
  dependencies: BugFixWorkflowDependencies,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  workspace: Workspace,
  analysis: TicketAnalysis,
): Promise<HarnessRunResult> {
  const execution = await dependencies.runner.executeHarness({
    kind: "start",
    harness: dependencies.harness,
    task: {
      ticket,
      approvedAnalysis: analysis,
      workspacePath: workspace.path,
      repositoryInstructions: {
        buildCommands: repository.buildCommands,
        testCommands: repository.testCommands,
        lintCommands: repository.lintCommands,
      },
      limits: {
        maxAgentTurns: repository.limits.maxAgentTurns,
        maxChangedFiles: repository.limits.maxChangedFiles,
        maxExecutionMinutes: repository.limits.maxExecutionMinutes,
      },
    },
  });
  validateHarnessResult(execution.result);
  return execution.result;
}

async function validateAndCommit(
  dependencies: BugFixWorkflowDependencies,
  workspace: Workspace,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  result: HarnessRunResult,
): Promise<string> {
  validateHarnessResult(result);
  validatePatch(await dependencies.workspaces.inspect(workspace), repository);
  return await dependencies.workspaces.commit(workspace, `fix(${ticket.key}): ${ticket.summary}`);
}

async function createMergeRequest(
  dependencies: BugFixWorkflowDependencies,
  runId: string,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  state: BugFixWorkflowState,
  result: HarnessRunResult,
): Promise<MergeRequest> {
  return await dependencies.gitlab.createDraftMergeRequest({
    idempotencyKey: runId,
    projectId: repository.gitlabProjectId,
    sourceBranch: workspaceFromState(state).branchName,
    targetBranch: repository.defaultBranch,
    title: `${ticket.key}: ${ticket.summary}`,
    description: mergeRequestDescription(ticket, result),
    draft: true,
    assignToCurrentUser: true,
    labels: ["LHIND"],
  });
}

async function reviewPatch(
  dependencies: BugFixWorkflowDependencies,
  state: BugFixWorkflowState,
  ticket: NormalizedBugTicket,
  sonarFindings: SonarFinding[],
): Promise<HarnessReviewResult & { state: BugFixWorkflowState }> {
  const workspace = workspaceFromState(state);
  const inspection = await dependencies.workspaces.inspectFromBase(workspace);
  if (!state.analysis)
    throw new DomainError("HARNESS_BLOCKED", "Independent review requires the approved analysis");
  const review = await dependencies.harness.review({
    ticket,
    analysis: state.analysis,
    workspacePath: workspace.path,
    diff: inspection.diff,
    validationSummary: "Defect reproduction and relevant local checks completed",
    ciStatus: "not started; review is required before publication",
    sonarFindings,
  });
  return {
    ...review,
    state: {
      ...state,
      statusDetail: review.summary,
      tokenUsage: addTokenUsage(state.tokenUsage, "review", usedTokens(review.usage)),
    },
  };
}

async function revisePatch(
  dependencies: BugFixWorkflowDependencies,
  state: BugFixWorkflowState,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  review: HarnessReviewResult,
): Promise<BugFixWorkflowState> {
  const workspace = workspaceFromState(state);
  const sessionId = state.harness?.sessionId;
  if (!sessionId)
    throw new DomainError(
      "HARNESS_BLOCKED",
      "Review feedback cannot be addressed without the implementer session",
    );
  if (state.reviewAttempt >= state.maxRepairAttempts)
    throw new DomainError("REPAIR_LIMIT_REACHED", "Review revision limit reached");
  const before = await dependencies.workspaces.inspectFromBase(workspace);
  const execution = await dependencies.runner.executeHarness({
    kind: "revise",
    harness: dependencies.harness,
    sessionId,
    task: {
      workspacePath: workspace.path,
      ticketSummary: ticketSummary(ticket),
      diffSummary: before.diffSummary,
      review,
    },
  });
  const commitSha = await validateAndCommitRepair(
    dependencies,
    state,
    ticket,
    repository,
    execution.result,
  );
  return {
    ...state,
    state: "REVIEWING",
    reviewAttempt: state.reviewAttempt + 1,
    currentCommitSha: commitSha,
    tokenUsage: addTokenUsage(state.tokenUsage, "repairs", usedTokens(execution.result.usage)),
    statusDetail: "Review findings addressed; awaiting a fresh independent review",
  };
}

async function continueHarness(
  dependencies: BugFixWorkflowDependencies,
  state: BugFixWorkflowState,
  ticket: NormalizedBugTicket,
  failure: CompactCiFailure,
): Promise<HarnessRunResult> {
  const workspace = workspaceFromState(state);
  const sessionId = state.harness?.sessionId;
  if (!sessionId || !state.currentCommitSha)
    throw new DomainError("HARNESS_BLOCKED", "Cannot resume without a session and commit");
  const before = await dependencies.workspaces.inspectFromBase(workspace);
  const execution = await dependencies.runner.executeHarness({
    kind: "continue",
    harness: dependencies.harness,
    sessionId,
    task: {
      workspacePath: workspace.path,
      ticketSummary: ticketSummary(ticket),
      currentCommitSha: state.currentCommitSha,
      diffSummary: before.diffSummary,
      failure,
    },
  });
  validateHarnessResult(execution.result);
  return execution.result;
}

async function validateAndCommitRepair(
  dependencies: BugFixWorkflowDependencies,
  state: BugFixWorkflowState,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  result: HarnessRunResult,
): Promise<string> {
  const workspace = workspaceFromState(state);
  validateHarnessResult(result);
  validatePatch(await dependencies.workspaces.inspect(workspace), repository);
  return await dependencies.workspaces.commit(workspace, `fix(${ticket.key}): repair CI failure`);
}

async function linkMergeRequestInJira(
  dependencies: BugFixWorkflowDependencies,
  state: BugFixWorkflowState,
): Promise<void> {
  if (!state.mergeRequest)
    throw new DomainError("VALIDATION_FAILURE", "Only an accepted review can be handed off");
  await dependencies.jira.ensureMergeRequestLink(state.issueKey, state.mergeRequest.url);
}

async function markJiraReadyToMerge(
  dependencies: BugFixWorkflowDependencies,
  state: BugFixWorkflowState,
): Promise<void> {
  if (!state.mergeRequest)
    throw new DomainError("VALIDATION_FAILURE", "Only an accepted review can be handed off");
  await dependencies.jira.ensureReadyToMerge(state.issueKey);
}

function initialState(
  runId: string,
  generation: number,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  workspace: Workspace,
  analysis: TicketAnalysis,
): BugFixWorkflowState {
  return {
    runId,
    issueKey: ticket.key,
    generation,
    repository: {
      id: repository.id,
      cloneUrl: repository.cloneUrl,
      defaultBranch: repository.defaultBranch,
    },
    branchName: workspace.branchName,
    baseCommitSha: workspace.baseCommitSha,
    harness: { provider: "codex", workspaceId: workspace.id },
    analysis,
    state: "REVIEWING",
    repairAttempt: 0,
    reviewAttempt: 0,
    maxRepairAttempts: repository.limits.maxRepairAttempts,
    tokenUsage: emptyTokenUsage(),
  };
}

function implementationState(
  runId: string,
  generation: number,
  ticket: NormalizedBugTicket,
  repository: RepositoryConfig,
  workspace: Workspace,
  analysis: TicketAnalysis,
  result: HarnessRunResult,
  commitSha: string,
): BugFixWorkflowState {
  return {
    ...initialState(runId, generation, ticket, repository, workspace, analysis),
    currentCommitSha: commitSha,
    harness: { provider: "codex", sessionId: result.sessionId, workspaceId: workspace.id },
    tokenUsage: addTokenUsage(emptyTokenUsage(), "initialRun", usedTokens(result.usage)),
  };
}

function repairState(
  state: BugFixWorkflowState,
  result: HarnessRunResult,
  commitSha: string,
  failure: CompactCiFailure,
): BugFixWorkflowState {
  return {
    ...state,
    state: "CI_RUNNING",
    repairAttempt: state.repairAttempt + 1,
    currentCommitSha: commitSha,
    lastFailureFingerprint: failure.fingerprint,
    ...(state.currentCommitSha ? { lastCommitAtFailure: state.currentCommitSha } : {}),
    tokenUsage: addTokenUsage(state.tokenUsage, "repairs", usedTokens(result.usage)),
  };
}

function validateHarnessResult(result: HarnessRunResult): void {
  if (result.status === "human_input_required")
    throw new DomainError("HUMAN_INPUT_REQUIRED", result.humanInputRequest ?? result.summary);
  if (result.status !== "completed") throw new DomainError("HARNESS_BLOCKED", result.summary);
  if (!result.validation.succeeded)
    throw new DomainError("VALIDATION_FAILURE", result.validation.failures.join("; "));
}

function validatePatch(inspection: WorkspaceInspection, repository: RepositoryConfig): void {
  if (inspection.changedFiles.length === 0)
    throw new DomainError("NO_CODE_CHANGES", "Harness completed without changing files");
  if (inspection.changedFiles.length > repository.limits.maxChangedFiles)
    throw new DomainError(
      "VALIDATION_FAILURE",
      `Patch changed ${inspection.changedFiles.length} files; limit is ${repository.limits.maxChangedFiles}`,
    );
}

function ticketSummary(ticket: NormalizedBugTicket) {
  return {
    key: ticket.key,
    summary: ticket.summary,
    ...(ticket.expectedBehavior ? { expectedBehavior: ticket.expectedBehavior } : {}),
    ...(ticket.actualBehavior ? { actualBehavior: ticket.actualBehavior } : {}),
  };
}

function workspaceFromState(state: BugFixWorkflowState): Workspace {
  const path = state.harness?.workspaceId;
  if (!path || !state.branchName || !state.baseCommitSha)
    throw new DomainError("WORKSPACE_FAILURE", "Workflow does not contain a recoverable workspace");
  return { id: path, path, branchName: state.branchName, baseCommitSha: state.baseCommitSha };
}

function mergeRequestDescription(ticket: NormalizedBugTicket, result: HarnessRunResult): string {
  return `## What\n${result.summary}\n\n## Why\n${result.rootCause ?? "See ticket context"}\n\n## How\nFocused automated patch for ${ticket.key}.\n\n## Verification\n${result.validation.commandsRun.join("\n")}\n\n## Scope\nNo unrelated changes.\n\nFixes ${ticket.key}`;
}

function stopForHuman(state: BugFixWorkflowState, detail: string): BugFixWorkflowState {
  return humanRequired(state, detail);
}

export type RepairDecision = { action: "repair" } | { action: "human_required"; reason: string };

export function decideRepair(
  state: BugFixWorkflowState,
  failure: CompactCiFailure,
  currentCommitSha: string,
): RepairDecision {
  if (failure.category === "infrastructure" || failure.category === "timeout") {
    return {
      action: "human_required",
      reason: `CI failure is ${failure.category}; product code will not be changed`,
    };
  }
  if (state.repairAttempt >= state.maxRepairAttempts)
    return { action: "human_required", reason: "Maximum repair attempts reached" };
  if (
    state.lastFailureFingerprint === failure.fingerprint &&
    state.lastCommitAtFailure === currentCommitSha
  ) {
    return {
      action: "human_required",
      reason: "The same failure repeated without a meaningful code change",
    };
  }
  return { action: "repair" };
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
  const humanRequiredCodes: DomainErrorCode[] = [
    "HUMAN_INPUT_REQUIRED",
    "HARNESS_BLOCKED",
    "REPAIR_LIMIT_REACHED",
    "REPEATED_FAILURE",
    "CI_INFRASTRUCTURE_FAILURE",
  ];
  const code =
    error instanceof DomainError
      ? error.code
      : error instanceof restate.TerminalError
        ? (error.metadata?.[domainCodeMetadataKey] as DomainErrorCode | undefined)
        : undefined;
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

function callbackPromiseName(kind: CallbackKind, attempt: number): string {
  return `${kind}-${attempt}`;
}

function isCurrentCallback(state: BugFixWorkflowState, correlation: CallbackCorrelation): boolean {
  return (
    correlation.attempt === state.repairAttempt && correlation.commitSha === state.currentCommitSha
  );
}

async function waitForCallback<T extends object>(
  ctx: BugFixWorkflowContext,
  kind: CallbackKind,
  attempt: number,
  timeoutMinutes: number,
  callback: restate.RestatePromise<T | undefined>,
): Promise<{ status: "received"; callback: T } | { status: "timed_out" }> {
  return await restate.RestatePromise.race([
    callback.map((value) => {
      if (value === undefined)
        throw new Error(
          `Callback promise ${callbackPromiseName(kind, attempt)} resolved without a value`,
        );
      return { status: "received" as const, callback: value };
    }),
    ctx
      .sleep({ minutes: timeoutMinutes }, `wait-for-${kind}-${attempt}-deadline`)
      .map(() => ({ status: "timed_out" as const })),
  ]);
}

async function resolveOnce(
  ctx: BugFixWorkflowSharedContext,
  promiseName: string,
  callback: unknown,
): Promise<void> {
  const promise = ctx.promise<unknown>(promiseName);
  if ((await promise.peek()) === undefined) await promise.resolve(callback);
}
