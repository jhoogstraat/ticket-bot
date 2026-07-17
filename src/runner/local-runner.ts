import type {
  CreateWorkspaceInput,
  ExecuteHarnessInput,
  ExecutionResult,
  ExecutionRunner,
  Workspace,
} from "./execution-runner.js";
import type { TicketAnalysis } from "../domain/analysis.js";
import type { AnalyzeHarnessTaskInput, CodingHarness } from "../domain/harness.js";
import { WorkspaceManager } from "./workspace-manager.js";

export class LocalRunner implements ExecutionRunner {
  constructor(readonly workspaceManager: WorkspaceManager) {}
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.workspaceManager.create(
      input.workflowId,
      input.issueKey,
      input.shortSlug,
      input.repository,
    );
  }
  activateWorkspace(workspace: Workspace): Promise<Workspace> {
    return this.workspaceManager.activateBranch(workspace);
  }
  analyzeHarness(harness: CodingHarness, task: AnalyzeHarnessTaskInput): Promise<TicketAnalysis> {
    return harness.analyzeTask(task);
  }
  async executeHarness(input: ExecuteHarnessInput): Promise<ExecutionResult> {
    const result =
      input.kind === "start"
        ? await input.harness.startTask(input.task)
        : input.kind === "continue"
          ? await input.harness.continueTask(input.sessionId, input.task)
          : await input.harness.reviseTask(input.sessionId, input.task);
    return { result };
  }
  destroyWorkspace(workspaceId: string): Promise<void> {
    return this.workspaceManager.destroy(workspaceId);
  }
}
