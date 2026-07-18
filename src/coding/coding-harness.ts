import type { CompactCiFailure, SonarFinding } from "../domain/ci.js";
import type { TicketAnalysis } from "../features/bugfix/analysis.js";
import type { NormalizedBugTicket } from "../domain/ticket.js";

export interface HarnessUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

export interface HarnessRunResult {
  sessionId: string;
  status: "completed" | "blocked" | "failed" | "human_input_required";
  summary: string;
  rootCause?: string;
  changedFiles: string[];
  validation: { commandsRun: string[]; succeeded: boolean; failures: string[] };
  commitSha?: string;
  usage?: HarnessUsage;
  humanInputRequest?: string;
}

export interface StartHarnessTaskInput {
  ticket: NormalizedBugTicket;
  approvedAnalysis: TicketAnalysis;
  workspacePath: string;
  repositoryInstructions: {
    buildCommands: string[];
    testCommands: string[];
    lintCommands: string[];
  };
  limits: { maxAgentTurns: number; maxChangedFiles: number; maxExecutionMinutes: number };
}

export interface AnalyzeHarnessTaskInput {
  ticket: NormalizedBugTicket;
  workspacePath: string;
  repositoryId: string;
  repositoryInstructions: {
    buildCommands: string[];
    testCommands: string[];
    lintCommands: string[];
  };
  limits: { maxAgentTurns: number; maxExecutionMinutes: number };
}

export interface ContinueHarnessTaskInput {
  workspacePath: string;
  ticketSummary: Pick<
    NormalizedBugTicket,
    "key" | "summary" | "expectedBehavior" | "actualBehavior"
  >;
  currentCommitSha: string;
  diffSummary: string;
  failure: CompactCiFailure;
}

export interface ReviseHarnessTaskInput {
  workspacePath: string;
  ticketSummary: Pick<
    NormalizedBugTicket,
    "key" | "summary" | "expectedBehavior" | "actualBehavior"
  >;
  diffSummary: string;
  review: HarnessReviewResult;
}

export interface ReviewHarnessTaskInput {
  ticket: NormalizedBugTicket;
  analysis: TicketAnalysis;
  workspacePath: string;
  diff: string;
  validationSummary: string;
  ciStatus: string;
  sonarFindings: SonarFinding[];
}

export interface HarnessReviewResult {
  sessionId: string;
  verdict: "accept" | "revise" | "re-investigate";
  summary: string;
  findings: Array<{
    severity: "blocking" | "important";
    location?: string;
    problem: string;
    correction: string;
  }>;
  usage?: HarnessUsage;
}

export interface CodingHarness {
  analyzeTask(input: AnalyzeHarnessTaskInput): Promise<TicketAnalysis>;
  startTask(input: StartHarnessTaskInput): Promise<HarnessRunResult>;
  continueTask(sessionId: string, input: ContinueHarnessTaskInput): Promise<HarnessRunResult>;
  reviseTask(sessionId: string, input: ReviseHarnessTaskInput): Promise<HarnessRunResult>;
  review(input: ReviewHarnessTaskInput): Promise<HarnessReviewResult>;
}

export function usedTokens(usage?: HarnessUsage): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}
