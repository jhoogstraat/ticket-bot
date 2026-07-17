import { describe, expect, it } from "bun:test";
import { parseHarnessRunResult } from "../src/harness/harness-result-parser.js";
describe("harness result validation", () => {
  it("accepts structured results", () =>
    expect(
      parseHarnessRunResult({
        status: "completed",
        summary: "ok",
        changedFiles: ["a.ts"],
        validation: { commandsRun: ["bun run test"], succeeded: true, failures: [] },
      }).status,
    ).toBe("completed"));
  it("rejects invalid statuses", () =>
    expect(() =>
      parseHarnessRunResult({
        status: "maybe",
        summary: "x",
        changedFiles: [],
        validation: { commandsRun: [], succeeded: true, failures: [] },
      }),
    ).toThrow());
});
