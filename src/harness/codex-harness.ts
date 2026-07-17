import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface InvocationResult {
  sessionId: string;
  output: unknown;
  usage?: HarnessUsage;
}

export class CodexHarness implements CodingHarness {
  private readonly processes = new Map<string, ChildProcess>();
  constructor(
    private readonly command = "codex",
    private readonly timeoutMinutes = 45,
  ) {}

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

  async cancel(sessionId: string): Promise<void> {
    this.processes.get(sessionId)?.kill("SIGTERM");
  }

  private async invoke(
    workspacePath: string,
    prompt: string,
    schema: object,
    resumeSessionId?: string,
    readOnly = false,
  ): Promise<InvocationResult> {
    const temp = await mkdtemp(join(tmpdir(), "ticket-bot-codex-"));
    const schemaPath = join(temp, "schema.json");
    const outputPath = join(temp, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    const args = resumeSessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--output-schema",
          schemaPath,
          "-o",
          outputPath,
          resumeSessionId,
          "-",
        ]
      : [
          "exec",
          "--json",
          "-C",
          workspacePath,
          "-s",
          readOnly ? "read-only" : "workspace-write",
          "-a",
          "never",
          "--output-schema",
          schemaPath,
          "-o",
          outputPath,
          "-",
        ];
    try {
      const events = await this.runProcess(args, prompt, workspacePath, resumeSessionId);
      const final = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
      const sessionId = extractSessionId(events) ?? resumeSessionId;
      if (!sessionId) throw new Error("Codex did not emit a session ID");
      const usage = extractUsage(events);
      return { sessionId, output: final, ...(usage ? { usage } : {}) };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  private runProcess(
    args: string[],
    prompt: string,
    cwd: string,
    knownSessionId?: string,
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, JIRA_TOKEN: undefined, GITLAB_TOKEN: undefined },
      });
      if (knownSessionId) this.processes.set(knownSessionId, child);
      const events: unknown[] = [];
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new DomainError("HARNESS_TIMEOUT", `Codex exceeded ${this.timeoutMinutes} minutes`));
      }, this.timeoutMinutes * 60_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            events.push(JSON.parse(line) as unknown);
          } catch {
            /* bounded structured stream may contain warnings */
          }
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (knownSessionId) this.processes.delete(knownSessionId);
        if (code !== 0) reject(new Error(`Codex exited with ${code}: ${stderr}`));
        else resolve(events);
      });
      child.stdin.end(prompt);
    });
  }
}

function extractSessionId(events: unknown[]): string | undefined {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (record.type === "thread.started" && typeof record.thread_id === "string")
      return record.thread_id;
    if (typeof record.session_id === "string") return record.session_id;
  }
  return undefined;
}

function extractUsage(events: unknown[]): HarnessUsage | undefined {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "number") {
        if (key === "input_tokens") inputTokens = Math.max(inputTokens, nested);
        if (key === "cached_input_tokens") cachedInputTokens = Math.max(cachedInputTokens, nested);
        if (key === "output_tokens") outputTokens = Math.max(outputTokens, nested);
      } else visit(nested);
    }
  };
  events.forEach(visit);
  return inputTokens || outputTokens ? { inputTokens, cachedInputTokens, outputTokens } : undefined;
}
