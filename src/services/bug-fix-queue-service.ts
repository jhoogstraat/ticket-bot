import type { BugFixQueue } from "../domain/queue.js";
import type { JiraClient } from "../integrations/jira/jira-client.js";

export class BugFixQueueService {
  constructor(
    private readonly jira: JiraClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async capture(filterUrl: string, generation = 1): Promise<BugFixQueue> {
    const issueKeys: string[] = [];
    const seen = new Set<string>();
    let nextPageToken: string | undefined;
    do {
      const page = await this.jira.searchOpenBugs(filterUrl, nextPageToken);
      for (const issue of page.issues) {
        if (!seen.has(issue.key)) {
          seen.add(issue.key);
          issueKeys.push(issue.key);
        }
      }
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
      if (!page.isLast && !nextPageToken)
        throw new Error("Jira pagination did not provide a next-page token");
    } while (nextPageToken);
    return {
      filterUrl,
      capturedAt: this.now().toISOString(),
      entries: issueKeys.map((issueKey) => ({ issueKey, generation })),
    };
  }
}
