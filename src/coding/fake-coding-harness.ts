import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketAnalysis } from "../features/bugfix/analysis.js";
import type {
  AnalyzeHarnessTaskInput,
  CodingHarness,
  ContinueHarnessTaskInput,
  HarnessReviewResult,
  HarnessRunResult,
  ReviewHarnessTaskInput,
  ReviseHarnessTaskInput,
  StartHarnessTaskInput,
} from "./coding-harness.js";

export class FakeCodingHarness implements CodingHarness {
  readonly analyses: AnalyzeHarnessTaskInput[] = [];
  readonly starts: StartHarnessTaskInput[] = [];
  readonly continuations: ContinueHarnessTaskInput[] = [];
  readonly revisions: ReviseHarnessTaskInput[] = [];

  async analyzeTask(input: AnalyzeHarnessTaskInput): Promise<TicketAnalysis> {
    this.analyses.push(structuredClone(input));
    return {
      issueKey: input.ticket.key,
      summary: input.ticket.summary,
      rootCauseConfidence: "high",
      proposedFixConfidence: "high",
      issue: input.ticket.description ?? input.ticket.summary,
      rootCause: "Simulated root cause",
      proposedFix: "Create one focused fixture change",
      expectedFiles: [`.ticket-bot/${input.ticket.key}.txt`],
      nonGoals: ["Unrelated changes"],
      observableBehavior: ["Focused fixture exists"],
      jiraEvidence: [input.ticket.summary],
      repositoryEvidence: ["Fake harness fixture"],
      reproductionEvidence: ["Fake reproduction"],
      complexity: { rating: "low", reasoning: "Single fixture", risks: [] },
      missingInformation: [],
    };
  }

  async startTask(input: StartHarnessTaskInput): Promise<HarnessRunResult> {
    this.starts.push(structuredClone(input));
    const relative = `.ticket-bot/${input.ticket.key}.txt`;
    await mkdir(join(input.workspacePath, ".ticket-bot"), { recursive: true });
    await writeFile(
      join(input.workspacePath, relative),
      `Simulated focused fix for ${input.ticket.key}\n`,
      "utf8",
    );

    return {
      sessionId: randomUUID(),
      status: "completed",
      summary: "Fake harness produced a focused change",
      rootCause: "Simulated root cause",
      changedFiles: [relative],
      validation: { commandsRun: ["fake:test"], succeeded: true, failures: [] },
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  async continueTask(
    sessionId: string,
    input: ContinueHarnessTaskInput,
  ): Promise<HarnessRunResult> {
    this.continuations.push(structuredClone(input));
    const relative = `.ticket-bot/repair-${this.continuations.length}.txt`;
    await writeFile(
      join(input.workspacePath, relative),
      `Simulated repair for ${input.failure.fingerprint}\n`,
      "utf8",
    );

    return {
      sessionId,
      status: "completed",
      summary: "Fake repair completed",
      changedFiles: [relative],
      validation: { commandsRun: ["fake:test"], succeeded: true, failures: [] },
      usage: { inputTokens: 30, outputTokens: 20 },
    };
  }

  async reviseTask(sessionId: string, input: ReviseHarnessTaskInput): Promise<HarnessRunResult> {
    this.revisions.push(structuredClone(input));
    const relative = `.ticket-bot/review-revision-${this.revisions.length}.txt`;
    await writeFile(join(input.workspacePath, relative), "Simulated review revision\n", "utf8");
    return {
      sessionId,
      status: "completed",
      summary: "Fake review findings addressed",
      changedFiles: [relative],
      validation: { commandsRun: ["fake:test"], succeeded: true, failures: [] },
    };
  }

  async review(_input: ReviewHarnessTaskInput): Promise<HarnessReviewResult> {
    return {
      sessionId: randomUUID(),
      verdict: "accept",
      summary: "Fake independent review accepted the patch",
      findings: [],
      usage: { inputTokens: 40, outputTokens: 10 },
    };
  }
}
