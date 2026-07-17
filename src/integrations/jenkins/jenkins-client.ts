import type { CiResult } from "../../domain/ci.js";
export interface JenkinsClient {
  getBuild(buildId: string): Promise<CiResult>;
}
export class FakeJenkinsClient implements JenkinsClient {
  constructor(private readonly results = new Map<string, CiResult>()) {}
  set(result: CiResult): void {
    this.results.set(result.buildId, result);
  }
  async getBuild(buildId: string): Promise<CiResult> {
    const result = this.results.get(buildId);
    if (!result) throw new Error(`Build ${buildId} does not exist`);
    return structuredClone(result);
  }
}
