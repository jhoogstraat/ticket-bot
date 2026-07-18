import type { ContinueHarnessTaskInput } from "./coding-harness.js";

export function buildCiContext(input: ContinueHarnessTaskInput): string {
  return JSON.stringify({
    ticket: input.ticketSummary,
    currentCommitSha: input.currentCommitSha,
    diffSummary: input.diffSummary.slice(0, 4_000),
    failure: input.failure,
  });
}
