import { describe, expect, it } from "bun:test";
import { normalizeJiraIssue } from "../src/integrations/jira/jira-normalizer.js";
import type { JiraIssueDto } from "../src/integrations/jira/jira-types.js";

describe("normalizeJiraIssue", () => {
  it("removes markup and bounds comments and links", () => {
    const issue: JiraIssueDto = {
      key: "ABC-1",
      fields: {
        summary: "Broken checkout",
        description: "<p>Fails &amp; retries</p><script>secret()</script>",
        status: { name: "Open" },
        labels: ["bug", "bug"],
        components: [{ name: "Checkout" }],
        comment: {
          comments: Array.from({ length: 12 }, (_, index) => ({
            author: { displayName: "A" },
            body: `<b>comment ${index}</b>`,
          })),
        },
        issuelinks: Array.from({ length: 7 }, (_, index) => ({
          type: { inward: "blocks", outward: "is blocked by" },
          outwardIssue: { key: `ABC-${index + 2}`, fields: { summary: "Related" } },
        })),
        attachment: [{ id: "1", filename: "error.log", mimeType: "text/plain" }],
      },
    };
    const result = normalizeJiraIssue(issue);
    expect(result.description).toBe("Fails & retries");
    expect(result.relevantComments).toHaveLength(10);
    expect(result.relevantComments[0]?.body).toBe("comment 2");
    expect(result.linkedIssues).toHaveLength(5);
    expect(result.labels).toEqual(["bug"]);
    expect(result.attachments[0]?.classification).toBe("log");
  });
});
