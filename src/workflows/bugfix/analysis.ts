import type { NormalizedBugTicket } from "../../domain/ticket.js";

export type Confidence = "high" | "medium" | "low";

export interface TicketAnalysis {
  issueKey: string;
  summary: string;
  rootCauseConfidence: Confidence;
  proposedFixConfidence: Confidence;
  issue: string;
  rootCause: string;
  proposedFix: string;
  expectedFiles: string[];
  nonGoals: string[];
  observableBehavior: string[];
  jiraEvidence: string[];
  repositoryEvidence: string[];
  reproductionEvidence: string[];
  complexity: { rating: "low" | "medium" | "high"; reasoning: string; risks: string[] };
  missingInformation: string[];
  humanRequest?: string;
}

export interface ConfidenceGateDecision {
  actionable: boolean;
  reason: string;
}

export function applyConfidenceGate(
  analysis: TicketAnalysis,
  repositoryId: string,
  allowedRepositoryId: string,
): ConfidenceGateDecision {
  const blockers: string[] = [];
  if (analysis.rootCauseConfidence !== "high") blockers.push("root-cause confidence is not High");
  if (analysis.proposedFixConfidence !== "high")
    blockers.push("proposed-fix confidence is not High");

  if (analysis.expectedFiles.length === 0 || analysis.observableBehavior.length === 0)
    blockers.push("the proposed change is not focused and verifiable");

  if (analysis.missingInformation.length > 0)
    blockers.push(`missing information: ${analysis.missingInformation.join("; ")}`);

  if (repositoryId !== allowedRepositoryId)
    blockers.push(
      `repository ${repositoryId} is outside the allowed ${allowedRepositoryId} repository`,
    );

  return blockers.length === 0
    ? {
        actionable: true,
        reason: "High-confidence, focused, verifiable fix contained in the allowed repository",
      }
    : { actionable: false, reason: blockers.join(". ") };
}

export function analysisMarkdown(
  ticket: NormalizedBugTicket,
  analysis: TicketAnalysis,
  decision: ConfidenceGateDecision,
): string {
  const list = (values: string[]): string =>
    values.length ? values.map((value) => `- ${value}`).join("\n") : "- None";

  return `# ${ticket.key}: ${ticket.summary}

## Verdict
- Root cause: ${analysis.rootCauseConfidence}
- Proposed fix: ${analysis.proposedFixConfidence}
- Decision: ${decision.actionable ? "Assign and implement yes" : "Assign and implement no"}
- Remaining uncertainty: ${analysis.missingInformation.join("; ") || "None"}

## Issue
${analysis.issue}

## Root cause
${analysis.rootCause}

## Proposed fix
${analysis.proposedFix}

## Scope
- Expected files or components: ${analysis.expectedFiles.join(", ") || "None identified"}
- Explicit non-goals: ${analysis.nonGoals.join("; ") || "None"}
- Observable behavior to verify: ${analysis.observableBehavior.join("; ") || "None identified"}

## Evidence
### Jira evidence
${list(analysis.jiraEvidence)}

### Repository evidence
${list(analysis.repositoryEvidence)}

### Reproduction evidence
${list(analysis.reproductionEvidence)}

## Complexity
- Rating: ${analysis.complexity.rating}
- Reasoning: ${analysis.complexity.reasoning}
- Main risks: ${analysis.complexity.risks.join("; ") || "None identified"}

## Missing information
${list(analysis.missingInformation)}
${decision.actionable ? "" : `\n## Human action required\n${analysis.humanRequest ?? decision.reason}\n`}`;
}
