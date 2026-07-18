import { describe, expect, it } from "bun:test";
import type { RunResult, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { TicketAnalysis } from "../src/features/bugfix/analysis.js";
import type { NormalizedBugTicket } from "../src/domain/ticket.js";
import {
  CodexHarness,
  type CodexClient,
} from "../src/coding/codex-coding-harness.js";

const ticket: NormalizedBugTicket = {
  key: "ABC-1",
  summary: "Fix the fixture",
  reproductionSteps: [],
  status: "Open",
  affectedVersions: [],
  statusHistory: [],
  labels: [],
  relevantComments: [],
  linkedIssues: [],
  attachments: [],
};

const analysis: TicketAnalysis = {
  issueKey: ticket.key,
  summary: ticket.summary,
  rootCauseConfidence: "high",
  proposedFixConfidence: "high",
  issue: "Fixture fails",
  rootCause: "Incorrect fixture",
  proposedFix: "Correct the fixture",
  expectedFiles: ["fixture.ts"],
  nonGoals: [],
  observableBehavior: ["Fixture passes"],
  jiraEvidence: [],
  repositoryEvidence: [],
  reproductionEvidence: [],
  complexity: { rating: "low", reasoning: "One file", risks: [] },
  missingInformation: [],
};

describe("CodexHarness", () => {
  it("uses the SDK thread API with a structured schema and isolated permissions", async () => {
    const calls: Array<{ input: string; options: TurnOptions | undefined }> = [];
    const threadOptions: ThreadOptions[] = [];
    const client: CodexClient = {
      startThread: (options) => {
        if (options) threadOptions.push(options);
        return {
          id: "thread-sdk-1",
          run: async (input, runOptions) => {
            calls.push({ input, options: runOptions });
            return completedRun({
              status: "completed",
              summary: "Fixed fixture",
              changedFiles: ["fixture.ts"],
              validation: { commandsRun: ["bun test"], succeeded: true, failures: [] },
            });
          },
        };
      },
      resumeThread: () => {
        throw new Error("not used");
      },
    };

    const harness = new CodexHarness(45, client);

    const result = await harness.startTask({
      ticket,
      approvedAnalysis: analysis,
      workspacePath: "/workspace/abc-1",
      repositoryInstructions: { buildCommands: [], testCommands: ["bun test"], lintCommands: [] },
      limits: { maxAgentTurns: 5, maxChangedFiles: 3, maxExecutionMinutes: 10 },
    });

    expect(result).toMatchObject({
      sessionId: "thread-sdk-1",
      status: "completed",
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 },
    });

    expect(threadOptions).toEqual([
      {
        workingDirectory: "/workspace/abc-1",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        webSearchMode: "disabled",
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toContain("You are resolving one bug");
    expect(calls[0]?.options?.outputSchema).toMatchObject({
      type: "object",
      required: ["status", "summary", "changedFiles", "validation"],
    });
  });

  it("resumes through the SDK with the original workspace and sandbox settings", async () => {
    const threadOptions: ThreadOptions[] = [];
    const client: CodexClient = {
      startThread: () => {
        throw new Error("not used");
      },
      resumeThread: (id, options) => {
        if (options) threadOptions.push(options);
        expect(id).toBe("thread-sdk-2");
        return {
          id,
          run: async () =>
            completedRun({
              status: "completed",
              summary: "Repaired fixture",
              changedFiles: ["fixture.ts"],
              validation: { commandsRun: ["bun test"], succeeded: true, failures: [] },
            }),
        };
      },
    };

    const harness = new CodexHarness(45, client);

    const result = await harness.continueTask("thread-sdk-2", {
      workspacePath: "/workspace/abc-1",
      ticketSummary: {
        key: ticket.key,
        summary: ticket.summary,
        expectedBehavior: "Fixture succeeds",
        actualBehavior: "Fixture fails",
      },
      currentCommitSha: "a".repeat(40),
      diffSummary: "One changed fixture",
      failure: {
        provider: "jenkins",
        buildId: "build-1",
        fingerprint: "fixture-failure",
        category: "test",
        failedTests: [
          {
            name: "fixture test",
            message: "expected true, received false",
            repositoryFrames: [],
          },
        ],
        compilerErrors: [],
        logExcerpt: "expected true, received false",
        removedLineCount: 0,
      },
    });

    expect(result.sessionId).toBe("thread-sdk-2");
    expect(threadOptions).toEqual([
      {
        workingDirectory: "/workspace/abc-1",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        webSearchMode: "disabled",
      },
    ]);
  });
});

function completedRun(output: unknown): RunResult {
  return {
    finalResponse: JSON.stringify(output),
    items: [],
    usage: {
      input_tokens: 12,
      cached_input_tokens: 3,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    },
  };
}
