import { describe, expect, it } from "bun:test";
import { filterSonarFindings } from "../src/integrations/sonarqube/sonar-finding-filter.js";
import type { SonarFinding } from "../src/domain/ci.js";

const finding = (file: string, isNewCode: boolean, qualityGateFailure = false): SonarFinding => ({
  rule: "x",
  severity: "major",
  file,
  message: "fix",
  isNewCode,
  qualityGateFailure,
});
describe("filterSonarFindings", () => {
  it("returns only new changed-file and quality-gate findings", () => {
    const result = filterSonarFindings(
      [finding("src/a.ts", true), finding("src/b.ts", true), finding("src/c.ts", false, true)],
      ["src/a.ts"],
    );
    expect(result.map((item) => item.file)).toEqual(["src/a.ts", "src/c.ts"]);
  });
});
