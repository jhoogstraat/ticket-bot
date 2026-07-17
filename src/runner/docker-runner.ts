import type {
  CreateWorkspaceInput,
  ExecuteHarnessInput,
  ExecutionResult,
  ExecutionRunner,
  Workspace,
} from "./execution-runner.js";
import type { TicketAnalysis } from "../domain/analysis.js";
import type { AnalyzeHarnessTaskInput, CodingHarness } from "../domain/harness.js";

export class DockerRunner implements ExecutionRunner {
  createWorkspace(_input: CreateWorkspaceInput): Promise<Workspace> {
    return Promise.reject(new Error("Docker runner is not implemented in the initial slice"));
  }
  activateWorkspace(_workspace: Workspace): Promise<Workspace> {
    return Promise.reject(new Error("Docker runner is not implemented in the initial slice"));
  }
  analyzeHarness(_harness: CodingHarness, _task: AnalyzeHarnessTaskInput): Promise<TicketAnalysis> {
    return Promise.reject(new Error("Docker runner is not implemented in the initial slice"));
  }
  executeHarness(_input: ExecuteHarnessInput): Promise<ExecutionResult> {
    return Promise.reject(new Error("Docker runner is not implemented in the initial slice"));
  }
  destroyWorkspace(_workspaceId: string): Promise<void> {
    return Promise.resolve();
  }
}
