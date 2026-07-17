import type { ReviewHarnessTaskInput } from "../domain/harness.js";
export function buildReviewContext(input: ReviewHarnessTaskInput): string {
  return JSON.stringify({
    ticket: input.ticket,
    diff: input.diff.slice(0, 50_000),
    validationSummary: input.validationSummary.slice(0, 4_000),
    ciStatus: input.ciStatus,
    sonarFindings: input.sonarFindings.slice(0, 20),
    analysis: input.analysis,
  });
}
