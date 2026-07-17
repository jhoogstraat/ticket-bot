import type { TokenUsage } from "../domain/workflow.js";
export const tokenUsageAttributes = (usage: TokenUsage): Record<string, number> => ({
  "bugfix.tokens.initial": usage.initialRun,
  "bugfix.tokens.repairs": usage.repairs,
  "bugfix.tokens.review": usage.review,
  "bugfix.tokens.total": usage.total,
});
