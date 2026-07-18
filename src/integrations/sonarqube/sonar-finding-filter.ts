import type { SonarFinding } from "../../domain/ci.js";

const severityRanks: Readonly<Record<string, number>> = {
  blocker: 5,
  critical: 4,
  major: 3,
  minor: 2,
  info: 1,
};

export function filterSonarFindings(
  findings: SonarFinding[],
  changedFiles: readonly string[],
  maxFindings = 20,
): SonarFinding[] {
  const changed = new Set(changedFiles.map((file) => file.replace(/^\.\//, "")));
  return findings
    .filter((finding) => finding.isNewCode || finding.qualityGateFailure === true)
    .filter(
      (finding) =>
        finding.qualityGateFailure === true || changed.has(finding.file.replace(/^\.\//, "")),
    )
    .sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        left.file.localeCompare(right.file) ||
        (left.line ?? 0) - (right.line ?? 0),
    )
    .slice(0, maxFindings)
    .map((finding) => ({
      ...finding,
      message: finding.message.slice(0, 500),
      ...(finding.remediation ? { remediation: finding.remediation.slice(0, 300) } : {}),
    }));
}

function severityRank(severity: string): number {
  return severityRanks[severity.toLowerCase()] ?? 0;
}
