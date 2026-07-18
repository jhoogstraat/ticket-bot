import * as restate from "@restatedev/restate-sdk";
import type {
  CodingHarness,
  HarnessReviewResult,
  HarnessRunResult,
} from "../../../coding/coding-harness.js";
import type { SonarFinding } from "../../../domain/ci.js";
import type { BugFixLimits } from "../../../domain/limits.js";
import type { TicketAnalysis } from "../../../domain/ticket-analysis.js";
import type { NormalizedBugTicket } from "../../../domain/ticket.js";
import type {
  LocalGitWorkspaces,
  RepositoryWorkspace,
  WorkspaceChanges,
} from "../../../integrations/git/local-git-workspaces.js";

export class CodingTask {
  constructor(
    private readonly harness: CodingHarness,
    private readonly workspaces: LocalGitWorkspaces,
    private readonly limits: BugFixLimits,
  ) {}

  async implementTicket(
    ticket: NormalizedBugTicket,
    workspace: RepositoryWorkspace,
    analysis: TicketAnalysis,
  ): Promise<HarnessRunResult> {
    const result = await this.harness.startTask({
      ticket,
      approvedAnalysis: analysis,
      workspacePath: workspace.path,
      limits: {
        maxAgentTurns: this.limits.maxAgentTurns,
        maxChangedFiles: this.limits.maxChangedFiles,
        maxExecutionMinutes: this.limits.maxExecutionMinutes,
      },
    });

    validateHarnessResult(result);
    return result;
  }

  async commitImplementation(
    workspace: RepositoryWorkspace,
    ticket: NormalizedBugTicket,
    result: HarnessRunResult,
  ): Promise<void> {
    await this.commitValidatedPatch(workspace, result, `fix(${ticket.key}): ${ticket.summary}`);
  }

  async reviewPatch(
    workspace: RepositoryWorkspace,
    ticket: NormalizedBugTicket,
    analysis: TicketAnalysis,
    sonarFindings: SonarFinding[],
  ): Promise<HarnessReviewResult> {
    const inspection = await this.workspaces.inspectChangesSinceBase(workspace);

    return await this.harness.review({
      ticket,
      analysis,
      workspacePath: workspace.path,
      diff: inspection.diff,
      validationSummary: "Defect reproduction and relevant local checks completed",
      ciStatus: "not started; review is required before publication",
      sonarFindings,
    });
  }

  async revisePatch(
    workspace: RepositoryWorkspace,
    sessionId: string,
    reviewAttempt: number,
    ticket: NormalizedBugTicket,
    review: HarnessReviewResult,
  ): Promise<void> {
    if (reviewAttempt >= this.limits.maxRepairAttempts)
      throw new restate.TerminalError("Review revision limit reached");

    const before = await this.workspaces.inspectChangesSinceBase(workspace);
    const result = await this.harness.reviseTask(sessionId, {
      workspacePath: workspace.path,
      ticketSummary: ticketSummary(ticket),
      diffSummary: before.diffSummary,
      review,
    });

    await this.commitValidatedPatch(
      workspace,
      result,
      `fix(${ticket.key}): repair review findings`,
    );
  }

  private async commitValidatedPatch(
    workspace: RepositoryWorkspace,
    result: HarnessRunResult,
    message: string,
  ): Promise<void> {
    validateHarnessResult(result);
    validatePatch(await this.workspaces.inspectPendingChanges(workspace), this.limits);
    await this.workspaces.commitChanges(workspace, message);
  }
}

function validateHarnessResult(result: HarnessRunResult): void {
  if (result.status === "human_input_required")
    throw new restate.TerminalError(result.humanInputRequest ?? result.summary);

  if (result.status !== "completed") throw new restate.TerminalError(result.summary);
  if (!result.validation.succeeded)
    throw new restate.TerminalError(result.validation.failures.join("; "));
}

function validatePatch(inspection: WorkspaceChanges, limits: BugFixLimits): void {
  if (inspection.changedFiles.length === 0)
    throw new restate.TerminalError("Harness completed without changing files");

  if (inspection.changedFiles.length > limits.maxChangedFiles)
    throw new restate.TerminalError(
      `Patch changed ${inspection.changedFiles.length} files; limit is ${limits.maxChangedFiles}`,
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
