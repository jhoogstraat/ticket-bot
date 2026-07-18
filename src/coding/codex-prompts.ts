import { buildCiContext } from "./ci-context-builder.js";
import { buildReviewContext } from "./review-context-builder.js";
import { buildTicketContext } from "./ticket-context-builder.js";
import type {
  AnalyzeHarnessTaskInput,
  ContinueHarnessTaskInput,
  ReviewHarnessTaskInput,
  ReviseHarnessTaskInput,
  StartHarnessTaskInput,
} from "./coding-harness.js";

export function analysisTaskPrompt(input: AnalyzeHarnessTaskInput): string {
  return `Investigate one Jira bug against this read-only repository snapshot. Do not edit files and do not access external systems.

Ticket evidence (normalized, bounded JSON):
${buildTicketContext(input.ticket)}

Repository: ${input.repositoryId}
Configured commands: ${JSON.stringify(input.repositoryInstructions)}
Limits: ${JSON.stringify(input.limits)}

Trace the behavior through the repository and reproduce it when possible. Distinguish observed facts from inference. Identify the causal root, the smallest focused fix, affected files, verification, risks, and every missing fact. Confidence is High only when direct evidence supports both cause and correction. Return only the requested structured analysis.`;
}

export function initialTaskPrompt(input: StartHarnessTaskInput): string {
  return `You are resolving one bug in an isolated repository workspace. Do not browse Jira or any external engineering system.

Ticket (normalized, bounded JSON):
${buildTicketContext(input.ticket)}

Approved high-confidence analysis:
${JSON.stringify(input.approvedAnalysis)}

Configured commands:
${JSON.stringify(input.repositoryInstructions)}

Limits:
${JSON.stringify(input.limits)}

Read repository instructions such as AGENTS.md. Reproduce before editing when possible, then implement only the approved proposed fix. If repository evidence disproves the analysis, stop and request re-investigation. Add or update a focused test only when needed to defend the corrected behavior, and run relevant checks. Avoid unrelated refactoring, formatting, dependency changes, and speculative hardening. Do not commit or push. Leave a clean reviewable diff. Return only the requested structured result.`;
}

export function repairTaskPrompt(input: ContinueHarnessTaskInput): string {
  return `Repair the current patch using only this compact new evidence. Do not revisit external systems and do not make unrelated changes.
${buildCiContext(input)}
Run focused validation and return only the requested structured result.`;
}

export function revisionTaskPrompt(input: ReviseHarnessTaskInput): string {
  return `Address every blocking and important finding from the independent review. Reject a finding only with concrete repository or test evidence in the result summary. If feedback invalidates the root cause, stop and request re-investigation. Do not make unrelated changes.
${JSON.stringify(input)}
Run the defect reproduction and relevant checks again. Return only the requested structured result.`;
}

export function reviewTaskPrompt(input: ReviewHarnessTaskInput): string {
  return `Independently review this final bug fix in a fresh read-only session. Inspect the diff and ticket behavior before relying on the proposed-fix rationale. Do not edit files. Challenge symptom-only fixes, unsupported assumptions, missed callsites and boundaries, regressions, error handling, security, data integrity, test quality, and unrelated scope. Return Accept only with no blocking or important findings. Return only the requested structured verdict.
${buildReviewContext(input)}`;
}
