import { describe, expect, it } from "bun:test";
import { applyConfidenceGate, type TicketAnalysis } from "../src/domain/analysis.js";

const complete: TicketAnalysis = {
  issueKey: "ABC-1",
  summary: "Bug",
  rootCauseConfidence: "high",
  proposedFixConfidence: "high",
  issue: "Observed bug",
  rootCause: "Cause",
  proposedFix: "Fix",
  expectedFiles: ["src/a.ts"],
  nonGoals: [],
  observableBehavior: ["Regression passes"],
  jiraEvidence: ["ticket"],
  repositoryEvidence: ["src/a.ts:1"],
  reproductionEvidence: ["test fails"],
  complexity: { rating: "low", reasoning: "focused", risks: [] },
  missingInformation: [],
};

describe("confidence gate", () => {
  it("accepts only a high-confidence focused fix in invoicing-outbound", () => {
    expect(
      applyConfidenceGate(complete, "invoicing-outbound", "invoicing-outbound").actionable,
    ).toBe(true);
  });
  it("blocks before Jira mutation when evidence or repository scope is incomplete", () => {
    const decision = applyConfidenceGate(
      { ...complete, rootCauseConfidence: "medium", missingInformation: ["production log"] },
      "other",
      "invoicing-outbound",
    );
    expect(decision.actionable).toBe(false);
    expect(decision.reason).toContain("root-cause confidence");
    expect(decision.reason).toContain("production log");
    expect(decision.reason).toContain("outside the allowed invoicing-outbound repository");
  });
});
