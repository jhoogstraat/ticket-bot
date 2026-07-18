import { describe, expect, it } from "bun:test";
import { validateJiraWebhook } from "../src/restate/webhooks/jira-webhook.js";
import { validateJenkinsWebhook } from "../src/restate/webhooks/jenkins-webhook.js";
describe("webhook validation", () => {
  it("accepts a ready bug", () =>
    expect(
      validateJiraWebhook({
        webhookEvent: "jira:issue_updated",
        providerEventId: "jira-delivery-1",
        issue: { key: "ABC-1", fields: { issuetype: { name: "Bug" }, status: { name: "Open" } } },
      }).issue.key,
    ).toBe("ABC-1"));
  it("rejects non-bugs", () =>
    expect(() =>
      validateJiraWebhook({
        webhookEvent: "x",
        providerEventId: "jira-delivery-2",
        issue: { key: "ABC-1", fields: { issuetype: { name: "Task" }, status: { name: "Open" } } },
      }),
    ).toThrow());
  it("rejects oversized Jenkins logs", () =>
    expect(() =>
      validateJenkinsWebhook({
        workflowId: "x",
        providerEventId: "jenkins-delivery-1",
        attempt: 0,
        buildId: "1",
        status: "failed",
        commitSha: "abc123",
        log: "x".repeat(2_000_001),
      }),
    ).toThrow());
});
