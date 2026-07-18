import { Codex, type RunResult, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { DomainError } from "../domain/errors.js";
import type { TicketAnalysis } from "../domain/analysis.js";
import type {
  AnalyzeHarnessTaskInput,
  CodingHarness,
  ContinueHarnessTaskInput,
  HarnessReviewResult,
  HarnessRunResult,
  HarnessUsage,
  ReviewHarnessTaskInput,
  ReviseHarnessTaskInput,
  StartHarnessTaskInput,
} from "../domain/harness.js";
import {
  analysisTaskPrompt,
  initialTaskPrompt,
  repairTaskPrompt,
  reviewTaskPrompt,
  revisionTaskPrompt,
} from "./harness-prompts.js";
import {
  analysisResultJsonSchema,
  parseHarnessReviewResult,
  parseHarnessRunResult,
  parseTicketAnalysis,
  reviewResultJsonSchema,
  runResultJsonSchema,
} from "./harness-result-parser.js";

interface CodexThread {
  readonly id: string | null;
  run(input: string, options?: TurnOptions): Promise<RunResult>;
}

export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
}

interface InvocationResult {
  sessionId: string;
  output: unknown;
  usage?: HarnessUsage;
}

export class CodexHarness implements CodingHarness {
  private readonly codex: CodexClient;

  constructor(
    private readonly timeoutMinutes = 45,
    codex?: CodexClient,
  ) {
    this.codex =
      codex ??
      new Codex({
        env: codexEnvironment(),
      });
  }

  async analyzeTask(input: AnalyzeHarnessTaskInput): Promise<TicketAnalysis> {
    const invocation = await this.invoke(
      input.workspacePath,
      analysisTaskPrompt(input),
      analysisResultJsonSchema,
      undefined,
      true,
    );
    return parseTicketAnalysis(invocation.output);
  }

  async startTask(input: StartHarnessTaskInput): Promise<HarnessRunResult> {
    const invocation = await this.invoke(
      input.workspacePath,
      initialTaskPrompt(input),
      runResultJsonSchema,
    );
    return {
      ...parseHarnessRunResult(invocation.output),
      sessionId: invocation.sessionId,
      ...(invocation.usage ? { usage: invocation.usage } : {}),
    };
  }

  async continueTask(
    sessionId: string,
    input: ContinueHarnessTaskInput,
  ): Promise<HarnessRunResult> {
    const invocation = await this.invoke(
      input.workspacePath,
      repairTaskPrompt(input),
      runResultJsonSchema,
      sessionId,
    );
    return {
      ...parseHarnessRunResult(invocation.output),
      sessionId: invocation.sessionId,
      ...(invocation.usage ? { usage: invocation.usage } : {}),
    };
  }

  async reviseTask(sessionId: string, input: ReviseHarnessTaskInput): Promise<HarnessRunResult> {
    const invocation = await this.invoke(
      input.workspacePath,
      revisionTaskPrompt(input),
      runResultJsonSchema,
      sessionId,
    );
    return {
      ...parseHarnessRunResult(invocation.output),
      sessionId: invocation.sessionId,
      ...(invocation.usage ? { usage: invocation.usage } : {}),
    };
  }

  async review(input: ReviewHarnessTaskInput): Promise<HarnessReviewResult> {
    const invocation = await this.invoke(
      input.workspacePath,
      reviewTaskPrompt(input),
      reviewResultJsonSchema,
      undefined,
      true,
    );
    return {
      ...parseHarnessReviewResult(invocation.output),
      sessionId: invocation.sessionId,
      ...(invocation.usage ? { usage: invocation.usage } : {}),
    };
  }

  private async invoke(
    workspacePath: string,
    prompt: string,
    schema: object,
    resumeSessionId?: string,
    readOnly = false,
  ): Promise<InvocationResult> {
    const options: ThreadOptions = {
      workingDirectory: workspacePath,
      sandboxMode: readOnly ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      webSearchMode: "disabled",
    };
    const thread = resumeSessionId
      ? this.codex.resumeThread(resumeSessionId, options)
      : this.codex.startThread(options);
    const controller = new AbortController();
    const timeoutState = { elapsed: false };
    const timer = setTimeout(() => {
      timeoutState.elapsed = true;
      controller.abort();
    }, this.timeoutMinutes * 60_000);

    try {
      const turn = await thread.run(prompt, { outputSchema: schema, signal: controller.signal });
      const sessionId = thread.id ?? resumeSessionId;
      if (!sessionId) throw new Error("Codex SDK did not return a thread ID");
      return {
        sessionId,
        output: parseJsonResponse(turn.finalResponse),
        ...(turn.usage ? { usage: usageFrom(turn.usage) } : {}),
      };
    } catch (error) {
      if (timeoutState.elapsed)
        throw new DomainError("HARNESS_TIMEOUT", `Codex exceeded ${this.timeoutMinutes} minutes`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function codexEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "JIRA_TOKEN" && name !== "GITLAB_TOKEN")
      environment[name] = value;
  }
  return environment;
}

function parseJsonResponse(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch (error) {
    throw new Error(`Codex returned invalid structured output: ${String(error)}`);
  }
}

function usageFrom(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}): HarnessUsage {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
  };
}
