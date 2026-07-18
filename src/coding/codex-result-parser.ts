import { z } from "zod";
import type { HarnessReviewResult, HarnessRunResult } from "./coding-harness.js";
import type { TicketAnalysis } from "../features/bugfix/analysis.js";

const usage = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    estimatedCost: z.number().nonnegative().optional(),
  })
  .optional();

const runSchema = z.object({
  sessionId: z.string().default("unknown"),
  status: z.enum(["completed", "blocked", "failed", "human_input_required"]),
  summary: z.string().max(8_000),
  rootCause: z.string().max(8_000).optional(),
  changedFiles: z.array(z.string()).max(100),
  validation: z.object({
    commandsRun: z.array(z.string()).max(50),
    succeeded: z.boolean(),
    failures: z.array(z.string().max(2_000)).max(20),
  }),
  commitSha: z.string().optional(),
  usage,
  humanInputRequest: z.string().max(4_000).optional(),
});

const reviewSchema = z.object({
  sessionId: z.string().default("unknown"),
  verdict: z.enum(["accept", "revise", "re-investigate"]),
  summary: z.string().max(8_000),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocking", "important"]),
        location: z.string().optional(),
        problem: z.string(),
        correction: z.string(),
      }),
    )
    .max(30),
  usage,
});

const analysisSchema = z.object({
  issueKey: z.string(),
  summary: z.string().max(8_000),
  rootCauseConfidence: z.enum(["high", "medium", "low"]),
  proposedFixConfidence: z.enum(["high", "medium", "low"]),
  issue: z.string().max(12_000),
  rootCause: z.string().max(12_000),
  proposedFix: z.string().max(12_000),
  expectedFiles: z.array(z.string()).max(50),
  nonGoals: z.array(z.string()).max(50),
  observableBehavior: z.array(z.string()).max(50),
  jiraEvidence: z.array(z.string()).max(100),
  repositoryEvidence: z.array(z.string()).max(100),
  reproductionEvidence: z.array(z.string()).max(100),
  complexity: z.object({
    rating: z.enum(["low", "medium", "high"]),
    reasoning: z.string(),
    risks: z.array(z.string()).max(50),
  }),
  missingInformation: z.array(z.string()).max(50),
  humanRequest: z.string().max(8_000).optional(),
});

export const parseHarnessRunResult = (value: unknown): HarnessRunResult =>
  runSchema.parse(value) as HarnessRunResult;

export const parseHarnessReviewResult = (value: unknown): HarnessReviewResult =>
  reviewSchema.parse(value) as HarnessReviewResult;

export const parseTicketAnalysis = (value: unknown): TicketAnalysis =>
  analysisSchema.parse(value) as TicketAnalysis;

export const analysisResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "issueKey",
    "summary",
    "rootCauseConfidence",
    "proposedFixConfidence",
    "issue",
    "rootCause",
    "proposedFix",
    "expectedFiles",
    "nonGoals",
    "observableBehavior",
    "jiraEvidence",
    "repositoryEvidence",
    "reproductionEvidence",
    "complexity",
    "missingInformation",
  ],
  properties: {
    issueKey: { type: "string" },
    summary: { type: "string" },
    rootCauseConfidence: { enum: ["high", "medium", "low"] },
    proposedFixConfidence: { enum: ["high", "medium", "low"] },
    issue: { type: "string" },
    rootCause: { type: "string" },
    proposedFix: { type: "string" },
    expectedFiles: { type: "array", items: { type: "string" } },
    nonGoals: { type: "array", items: { type: "string" } },
    observableBehavior: { type: "array", items: { type: "string" } },
    jiraEvidence: { type: "array", items: { type: "string" } },
    repositoryEvidence: { type: "array", items: { type: "string" } },
    reproductionEvidence: { type: "array", items: { type: "string" } },
    complexity: {
      type: "object",
      additionalProperties: false,
      required: ["rating", "reasoning", "risks"],
      properties: {
        rating: { enum: ["low", "medium", "high"] },
        reasoning: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
      },
    },
    missingInformation: { type: "array", items: { type: "string" } },
    humanRequest: { type: "string" },
  },
} as const;

export const runResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "changedFiles", "validation"],
  properties: {
    sessionId: { type: "string" },
    status: { enum: ["completed", "blocked", "failed", "human_input_required"] },
    summary: { type: "string" },
    rootCause: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["commandsRun", "succeeded", "failures"],
      properties: {
        commandsRun: { type: "array", items: { type: "string" } },
        succeeded: { type: "boolean" },
        failures: { type: "array", items: { type: "string" } },
      },
    },
    commitSha: { type: "string" },
    humanInputRequest: { type: "string" },
  },
} as const;

export const reviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    sessionId: { type: "string" },
    verdict: { enum: ["accept", "revise", "re-investigate"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "problem", "correction"],
        properties: {
          severity: { enum: ["blocking", "important"] },
          location: { type: "string" },
          problem: { type: "string" },
          correction: { type: "string" },
        },
      },
    },
  },
} as const;
