import { describe, expect, it } from "bun:test";
import { workflowId } from "../src/workflows/bug-fix-workflow.js";
describe("workflow identity", () => {
  it("is stable per ticket generation", () => {
    expect(workflowId("ABC-123", 1)).toBe("bug-fix/ABC-123/1");
    expect(workflowId("ABC-123", 1)).toBe(workflowId("ABC-123", 1));
  });
  it("changes for a new generation", () =>
    expect(workflowId("ABC-123", 2)).not.toBe(workflowId("ABC-123", 1)));
});
