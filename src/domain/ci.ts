export type CiFailureCategory =
  "compilation" | "test" | "lint" | "quality_gate" | "infrastructure" | "timeout" | "unknown";

export type CiResult = {
  provider: "jenkins";
  buildId: string;
  status: "success" | "failed";
  branch?: string;
  commitSha?: string;
};

export interface CompactCiFailure {
  provider: "jenkins";
  buildId: string;
  category: CiFailureCategory;
  stage?: string;
  failedTests: Array<{ name: string; file?: string; message: string; repositoryFrames: string[] }>;
  compilerErrors: Array<{ file?: string; line?: number; message: string }>;
  logExcerpt: string;
  removedLineCount: number;
  fingerprint: string;
}

export interface SonarFinding {
  rule: string;
  severity: string;
  file: string;
  line?: number;
  message: string;
  remediation?: string;
  isNewCode: boolean;
  qualityGateFailure?: boolean;
}
