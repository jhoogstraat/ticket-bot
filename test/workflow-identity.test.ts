import { describe, expect, it } from "bun:test";
import { validateWorkflowInput, workflowId } from "../src/workflows/bugfix/workflow.js";
describe("workflow identity", () => {
  it("is stable per ticket", () => {
    expect(workflowId("ABC-123", 1)).toBe("bugfix/ABC-123/1");
    expect(workflowId("ABC-123", 1)).toBe(workflowId("ABC-123", 1));
  });

  it("changes for a different ticket", () =>
    expect(workflowId("ABC-124", 1)).not.toBe(workflowId("ABC-123", 1)));

  it("rejects an untrusted repository before workflow side effects", () => {
    expect(() =>
      validateWorkflowInput(
        {
          issueKey: "ABC-123",
          generation: 1,
          forge: "github",
          url: "https://github.com/untrusted/project.git",
        },
        ["https://github.com/trusted/"],
      ),
    ).toThrow("Repository URL is not trusted");
  });
});
