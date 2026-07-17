import type { SonarFinding } from "../../domain/ci.js";
export interface SonarQubeClient {
  getFindings(projectId: string, commitSha: string): Promise<SonarFinding[]>;
}
export class FakeSonarQubeClient implements SonarQubeClient {
  constructor(private readonly findings: SonarFinding[] = []) {}
  async getFindings(): Promise<SonarFinding[]> {
    return structuredClone(this.findings);
  }
}
