import { describe, expect, it } from "bun:test";
import { parseJenkinsFailure } from "../src/integrations/jenkins/jenkins-failure-parser.js";

describe("Jenkins failure parsing", () => {
  it("compacts, classifies, deduplicates, and bounds logs", () => {
    const log =
      Array.from({ length: 500 }, (_, i) => `[2026-01-01 12:00:00] noise ${i}`).join("\n") +
      "\n[2026-01-01 12:00:01] src/a.ts:12: error TS2322: bad type\nFAIL checkout: expected success";
    const failure = parseJenkinsFailure(
      { buildId: "42", stage: "test", log },
      { maxExcerptBytes: 300, contextLines: 3 },
    );
    expect(failure.category).toBe("compilation");
    expect(Buffer.byteLength(failure.logExcerpt)).toBeLessThanOrEqual(300);
    expect(failure.compilerErrors[0]).toMatchObject({ file: "src/a.ts", line: 12 });
    expect(failure.removedLineCount).toBeGreaterThan(400);
  });

  it("generates stable fingerprints despite timestamps and build ids", () => {
    const left = parseJenkinsFailure({
      buildId: "1",
      log: "2026-01-01 12:00:00 src/a.ts:4 error: broken",
    });
    const right = parseJenkinsFailure({
      buildId: "2",
      log: "2026-01-02 12:00:00 src/a.ts:4 error: broken",
    });
    expect(left.fingerprint).toBe(right.fingerprint);
  });

  it("recognizes infrastructure failures", () =>
    expect(parseJenkinsFailure({ buildId: "3", log: "Jenkins agent was offline" }).category).toBe(
      "infrastructure",
    ));
});
