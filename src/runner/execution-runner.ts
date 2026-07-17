import type { TicketAnalysis } from "../domain/analysis.js";
import type {
  AnalyzeHarnessTaskInput,
  CodingHarness,
  ContinueHarnessTaskInput,
  HarnessRunResult,
  ReviseHarnessTaskInput,
  StartHarnessTaskInput,
} from "../domain/harness.js";
import type { RepositoryConfig } from "../domain/repository.js";

export interface Workspace {
  id: string;
  path: string;
  branchName: string;
  baseCommitSha: string;
}
export interface CreateWorkspaceInput {
  workflowId: string;
  issueKey: string;
  shortSlug: string;
  repository: RepositoryConfig;
}
export type ExecuteHarnessInput =
  | { kind: "start"; harness: CodingHarness; task: StartHarnessTaskInput }
  | { kind: "continue"; harness: CodingHarness; sessionId: string; task: ContinueHarnessTaskInput }
  | { kind: "revise"; harness: CodingHarness; sessionId: string; task: ReviseHarnessTaskInput };
export interface ExecutionResult {
  result: HarnessRunResult;
}

export interface ExecutionRunner {
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  activateWorkspace(workspace: Workspace): Promise<Workspace>;
  analyzeHarness(harness: CodingHarness, task: AnalyzeHarnessTaskInput): Promise<TicketAnalysis>;
  executeHarness(input: ExecuteHarnessInput): Promise<ExecutionResult>;
  destroyWorkspace(workspaceId: string): Promise<void>;
}
