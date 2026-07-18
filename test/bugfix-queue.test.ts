import { describe, expect, it } from "bun:test";
import type { JiraClient, JiraSearchPage } from "../src/integrations/jira/jira-client.js";
import type { JiraIssueDto } from "../src/integrations/jira/jira-types.js";
import { BugFixQueueCapture } from "../src/application/bugfix-queue-capture.js";

const issue = (key: string): JiraIssueDto => ({
  key,
  fields: { summary: key, status: { name: "Open" }, issuetype: { name: "Bug" } },
});

describe("fixed Jira queue", () => {
  it("captures every page exactly once and does not re-read the filter", async () => {
    const pages: JiraSearchPage[] = [
      { issues: [issue("ABC-1"), issue("ABC-2")], nextPageToken: "next", isLast: false },
      { issues: [issue("ABC-2"), issue("ABC-3")], isLast: true },
    ];
    let calls = 0;
    const jira: JiraClient = {
      getIssue: async (key) => issue(key),
      searchOpenBugs: async () => {
        const page = pages[calls++];
        if (!page) throw new Error("unexpected page request");
        return page;
      },
      claimIssue: async () => undefined,
      ensureMergeRequestLink: async () => undefined,
      ensureReadyToMerge: async () => undefined,
    };
    const queue = await new BugFixQueueCapture(
      jira,
      () => new Date("2026-01-02T03:04:05Z"),
    ).capture("https://jira.example/issues/?filter=123", 7);
    expect(calls).toBe(2);
    expect(queue.entries).toEqual([
      { issueKey: "ABC-1", generation: 7 },
      { issueKey: "ABC-2", generation: 7 },
      { issueKey: "ABC-3", generation: 7 },
    ]);
    expect(queue.capturedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});
