import { DomainError } from "../domain/errors.js";
import {
  analysisMarkdown,
  applyConfidenceGate,
  type ConfidenceGateDecision,
  type TicketAnalysis,
} from "../domain/analysis.js";
import type { CodingHarness, HarnessReviewResult, HarnessRunResult } from "../domain/harness.js";
import { usedTokens } from "../domain/harness.js";
import type { MergeRequest } from "../domain/merge-request.js";
import type { RepositoryConfig } from "../domain/repository.js";
import type { NormalizedBugTicket } from "../domain/ticket.js";
import type { BugFixWorkflowState } from "../domain/workflow.js";
import { addTokenUsage, emptyTokenUsage } from "../domain/workflow.js";
import type { GitLabClient } from "../integrations/gitlab/gitlab-client.js";
import type { JiraClient } from "../integrations/jira/jira-client.js";
import { normalizeJiraIssue } from "../integrations/jira/jira-normalizer.js";
import type { ExecutionRunner, Workspace } from "../runner/execution-runner.js";
import { WorkspaceManager, type WorkspaceInspection } from "../runner/workspace-manager.js";

export interface InitialExecution {
  ticket: NormalizedBugTicket;
  repository: RepositoryConfig;
  workspace: Workspace;
  harnessResult: HarnessRunResult;
  inspection: WorkspaceInspection;
  commitSha: string;
  mergeRequest: MergeRequest;
  state: BugFixWorkflowState;
  analysis: TicketAnalysis;
  gate: ConfidenceGateDecision;
}

export class BugFixService {
  constructor(
    private readonly jira: JiraClient,
    private readonly gitlab: GitLabClient,
    private readonly harness: CodingHarness,
    private readonly runner: ExecutionRunner,
    private readonly workspaces: WorkspaceManager,
    private readonly repositoryResolver: (ticket: NormalizedBugTicket) => RepositoryConfig,
    private readonly allowedRepositoryId = "invoicing-outbound",
  ) {}

  async loadTicket(issueKey: string): Promise<NormalizedBugTicket> {
    return normalizeJiraIssue(await this.jira.getIssue(issueKey));
  }
  resolveRepository(ticket: NormalizedBugTicket): RepositoryConfig {
    return this.repositoryResolver(ticket);
  }

  async executeInitial(
    runId: string,
    generation: number,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
  ): Promise<InitialExecution> {
    const workspace = await this.createWorkspace(runId, ticket, repository);
    const { analysis, gate } = await this.investigate(ticket, repository, workspace);
    if (!gate.actionable) throw new DomainError("HUMAN_INPUT_REQUIRED", gate.reason);
    await this.claimTicket(ticket.key);
    const implementationWorkspace = await this.activateWorkspace(workspace);
    const harnessResult = await this.startHarness(
      ticket,
      repository,
      implementationWorkspace,
      analysis,
    );
    const { inspection, commitSha } = await this.validateAndCommit(
      implementationWorkspace,
      ticket,
      repository,
      harnessResult,
    );
    const implementationState = this.createImplementationState(
      runId,
      generation,
      ticket,
      repository,
      implementationWorkspace,
      analysis,
      harnessResult,
      commitSha,
    );
    const reviewed = await this.review(implementationState, ticket, []);
    if (reviewed.review.verdict !== "accept")
      throw new DomainError(
        "HARNESS_BLOCKED",
        `Independent review did not accept the implementation: ${reviewed.review.summary}`,
      );
    await this.push(implementationWorkspace);
    const mergeRequest = await this.createMergeRequest(
      runId,
      ticket,
      repository,
      implementationWorkspace,
      harnessResult,
    );
    const state = this.createPublishedState(reviewed.state, mergeRequest);
    return {
      ticket,
      repository,
      workspace,
      harnessResult,
      inspection,
      commitSha,
      mergeRequest,
      state,
      analysis,
      gate,
    };
  }

  createWorkspace(
    runId: string,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
  ): Promise<Workspace> {
    return this.runner.createWorkspace({
      workflowId: runId,
      issueKey: ticket.key,
      shortSlug: ticket.summary,
      repository,
    });
  }

  async investigate(
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    workspace: Workspace,
  ): Promise<{ analysis: TicketAnalysis; gate: ConfidenceGateDecision }> {
    const analysis = await this.runner.analyzeHarness(this.harness, {
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
    const gate = applyConfidenceGate(analysis, repository.id, this.allowedRepositoryId);
    await this.workspaces.writeArtifact(
      workspace,
      `ticket-analysis/${ticket.key}/ANALYSIS.md`,
      analysisMarkdown(ticket, analysis, gate),
    );
    return { analysis, gate };
  }

  claimTicket(issueKey: string): Promise<void> {
    return this.jira.claimIssue(issueKey);
  }
  activateWorkspace(workspace: Workspace): Promise<Workspace> {
    return this.runner.activateWorkspace(workspace);
  }

  async startHarness(
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    workspace: Workspace,
    approvedAnalysis: TicketAnalysis,
  ): Promise<HarnessRunResult> {
    const execution = await this.runner.executeHarness({
      kind: "start",
      harness: this.harness,
      task: {
        ticket,
        approvedAnalysis,
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
    this.validateHarnessResult(execution.result);
    return execution.result;
  }

  async validateAndCommit(
    workspace: Workspace,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    harnessResult: HarnessRunResult,
  ): Promise<{ inspection: WorkspaceInspection; commitSha: string }> {
    this.validateHarnessResult(harnessResult);
    const inspection = await this.workspaces.inspect(workspace);
    this.validatePatch(inspection, repository);
    const commitSha = await this.workspaces.commit(
      workspace,
      `fix(${ticket.key}): ${ticket.summary}`,
    );
    return { inspection, commitSha };
  }

  push(workspace: Workspace): Promise<void> {
    return this.workspaces.push(workspace);
  }

  createMergeRequest(
    runId: string,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    workspace: Workspace,
    result: HarnessRunResult,
  ): Promise<MergeRequest> {
    return this.gitlab.createDraftMergeRequest({
      idempotencyKey: runId,
      projectId: repository.gitlabProjectId,
      sourceBranch: workspace.branchName,
      targetBranch: repository.defaultBranch,
      title: `${ticket.key}: ${ticket.summary}`,
      description: mergeRequestDescription(ticket, result),
      draft: true,
      assignToCurrentUser: true,
      labels: ["LHIND"],
    });
  }

  createImplementationState(
    runId: string,
    generation: number,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    workspace: Workspace,
    analysis: TicketAnalysis,
    result: HarnessRunResult,
    commitSha: string,
  ): BugFixWorkflowState {
    const initialTokens = usedTokens(result.usage);
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
      currentCommitSha: commitSha,
      harness: { provider: "codex", sessionId: result.sessionId, workspaceId: workspace.id },
      analysis,
      state: "REVIEWING",
      repairAttempt: 0,
      reviewAttempt: 0,
      maxRepairAttempts: repository.limits.maxRepairAttempts,
      tokenUsage: addTokenUsage(emptyTokenUsage(), "initialRun", initialTokens),
    };
  }

  createPublishedState(
    state: BugFixWorkflowState,
    mergeRequest: MergeRequest,
  ): BugFixWorkflowState {
    const next = { ...state, mergeRequest, state: "CI_RUNNING" as const };
    delete next.statusDetail;
    return next;
  }

  async repair(
    state: BugFixWorkflowState,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    failure: import("../domain/ci.js").CompactCiFailure,
  ): Promise<{ result: HarnessRunResult; commitSha: string; state: BugFixWorkflowState }> {
    const result = await this.continueHarness(state, ticket, failure);
    const { commitSha } = await this.validateAndCommitRepair(state, ticket, repository, result);
    await this.push(workspaceFromState(state));
    return { result, commitSha, state: this.createRepairState(state, result, commitSha, failure) };
  }

  async continueHarness(
    state: BugFixWorkflowState,
    ticket: NormalizedBugTicket,
    failure: import("../domain/ci.js").CompactCiFailure,
  ): Promise<HarnessRunResult> {
    const workspace = workspaceFromState(state);
    const sessionId = state.harness?.sessionId;
    if (!sessionId || !state.currentCommitSha)
      throw new DomainError("HARNESS_BLOCKED", "Cannot resume without a session and commit");
    const before = await this.workspaces.inspectFromBase(workspace);
    const execution = await this.runner.executeHarness({
      kind: "continue",
      harness: this.harness,
      sessionId,
      task: {
        workspacePath: workspace.path,
        ticketSummary: {
          key: ticket.key,
          summary: ticket.summary,
          ...(ticket.expectedBehavior ? { expectedBehavior: ticket.expectedBehavior } : {}),
          ...(ticket.actualBehavior ? { actualBehavior: ticket.actualBehavior } : {}),
        },
        currentCommitSha: state.currentCommitSha,
        diffSummary: before.diffSummary,
        failure,
      },
    });
    this.validateHarnessResult(execution.result);
    return execution.result;
  }

  async validateAndCommitRepair(
    state: BugFixWorkflowState,
    ticket: NormalizedBugTicket,
    repository: RepositoryConfig,
    result: HarnessRunResult,
  ): Promise<{ commitSha: string }> {
    const workspace = workspaceFromState(state);
    this.validateHarnessResult(result);
    const inspection = await this.workspaces.inspect(workspace);
    this.validatePatch(inspection, repository);
    const commitSha = await this.workspaces.commit(
      workspace,
      `fix(${ticket.key}): repair CI failure`,
    );
    return { commitSha };
  }

  createRepairState(
    state: BugFixWorkflowState,
    result: HarnessRunResult,
    commitSha: string,
    failure: import("../domain/ci.js").CompactCiFailure,
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

  async review(
    state: BugFixWorkflowState,
    ticket: NormalizedBugTicket,
    sonarFindings: import("../domain/ci.js").SonarFinding[],
  ): Promise<{ review: HarnessReviewResult; state: BugFixWorkflowState }> {
    const workspace = workspaceFromState(state);
    const inspection = await this.workspaces.inspectFromBase(workspace);
    if (!state.analysis)
      throw new DomainError("HARNESS_BLOCKED", "Independent review requires the approved analysis");
    const review = await this.harness.review({
      ticket,
      analysis: state.analysis,
      workspacePath: workspace.path,
      diff: inspection.diff,
      validationSummary: "Defect reproduction and relevant local checks completed",
      ciStatus: "not started; review is required before publication",
      sonarFindings,
    });
    const nextState: BugFixWorkflowState = {
      ...state,
      state: review.verdict === "accept" ? "REVIEW_READY" : "HUMAN_REQUIRED",
      statusDetail: review.summary,
      tokenUsage: addTokenUsage(state.tokenUsage, "review", usedTokens(review.usage)),
    };
    return { review, state: nextState };
  }

  async reviseBeforePublish(
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
    const before = await this.workspaces.inspectFromBase(workspace);
    const execution = await this.runner.executeHarness({
      kind: "revise",
      harness: this.harness,
      sessionId,
      task: {
        workspacePath: workspace.path,
        ticketSummary: {
          key: ticket.key,
          summary: ticket.summary,
          ...(ticket.expectedBehavior ? { expectedBehavior: ticket.expectedBehavior } : {}),
          ...(ticket.actualBehavior ? { actualBehavior: ticket.actualBehavior } : {}),
        },
        diffSummary: before.diffSummary,
        review,
      },
    });
    this.validateHarnessResult(execution.result);
    const { commitSha } = await this.validateAndCommitRepair(
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

  async handoff(state: BugFixWorkflowState): Promise<BugFixWorkflowState> {
    if (state.state !== "REVIEW_READY" || !state.mergeRequest)
      throw new DomainError("VALIDATION_FAILURE", "Only an accepted review can be handed off");
    await this.jira.markReadyToMerge(state.issueKey, state.mergeRequest.url);
    return {
      ...state,
      state: "DONE",
      statusDetail: "Ready to merge; merge remains a human action",
    };
  }

  validateHarnessResult(result: HarnessRunResult): void {
    if (result.status === "human_input_required")
      throw new DomainError("HUMAN_INPUT_REQUIRED", result.humanInputRequest ?? result.summary);
    if (result.status !== "completed") throw new DomainError("HARNESS_BLOCKED", result.summary);
    if (!result.validation.succeeded)
      throw new DomainError("VALIDATION_FAILURE", result.validation.failures.join("; "));
  }

  validatePatch(inspection: WorkspaceInspection, repository: RepositoryConfig): void {
    if (inspection.changedFiles.length === 0)
      throw new DomainError("NO_CODE_CHANGES", "Harness completed without changing files");
    if (inspection.changedFiles.length > repository.limits.maxChangedFiles) {
      throw new DomainError(
        "VALIDATION_FAILURE",
        `Patch changed ${inspection.changedFiles.length} files; limit is ${repository.limits.maxChangedFiles}`,
      );
    }
  }
}

export function workspaceFromState(state: BugFixWorkflowState): Workspace {
  const path = state.harness?.workspaceId;
  if (!path || !state.branchName || !state.baseCommitSha)
    throw new DomainError("WORKSPACE_FAILURE", "Workflow does not contain a recoverable workspace");
  return { id: path, path, branchName: state.branchName, baseCommitSha: state.baseCommitSha };
}

function mergeRequestDescription(ticket: NormalizedBugTicket, result: HarnessRunResult): string {
  return `## What\n${result.summary}\n\n## Why\n${result.rootCause ?? "See ticket context"}\n\n## How\nFocused automated patch for ${ticket.key}.\n\n## Verification\n${result.validation.commandsRun.join("\n")}\n\n## Scope\nNo unrelated changes.\n\nFixes ${ticket.key}`;
}
