import { describe, expect, it } from "bun:test";
import { validateJiraWebhook } from "../src/entrypoints/jira-webhook.restate-service.js";
describe("webhook validation", () => {
  it("accepts a ready bug", () =>
    expect(
      validateJiraWebhook({
        webhookEvent: "jira:issue_updated",
        providerEventId: "jira-delivery-1",
        forge: "gitlab",
        url: "https://gitlab.example/group/project.git",
        issue: { key: "ABC-1", fields: { issuetype: { name: "Bug" }, status: { name: "Open" } } },
      }).issue.key,
    ).toBe("ABC-1"));

  it("rejects non-bugs", () =>
    expect(() =>
      validateJiraWebhook({
        webhookEvent: "x",
        providerEventId: "jira-delivery-2",
        forge: "gitlab",
        url: "https://gitlab.example/group/project.git",
        issue: { key: "ABC-1", fields: { issuetype: { name: "Task" }, status: { name: "Open" } } },
      }),
    ).toThrow());
});
