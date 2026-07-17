import { describe, expect, it } from "bun:test";
import { validateJiraWebhook } from "../src/webhooks/jira-webhook.js";
import { validateJenkinsWebhook } from "../src/webhooks/jenkins-webhook.js";
describe("webhook validation", () => {
  it("accepts a ready bug", () =>
    expect(
      validateJiraWebhook({
        webhookEvent: "jira:issue_updated",
        issue: { key: "ABC-1", fields: { issuetype: { name: "Bug" }, status: { name: "Open" } } },
      }).issue.key,
    ).toBe("ABC-1"));
  it("rejects non-bugs", () =>
    expect(() =>
      validateJiraWebhook({
        webhookEvent: "x",
        issue: { key: "ABC-1", fields: { issuetype: { name: "Task" }, status: { name: "Open" } } },
      }),
    ).toThrow());
  it("rejects oversized Jenkins logs", () =>
    expect(() =>
      validateJenkinsWebhook({
        workflowId: "x",
        buildId: "1",
        status: "failed",
        log: "x".repeat(2_000_001),
      }),
    ).toThrow());
});
