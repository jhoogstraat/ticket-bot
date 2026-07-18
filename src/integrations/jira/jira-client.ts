import type { JiraIssueDto } from "./jira-types.js";

export interface JiraSearchPage {
  issues: JiraIssueDto[];
  nextPageToken?: string;
  isLast: boolean;
}
export interface JiraClient {
  getIssue(issueKey: string): Promise<JiraIssueDto>;
  searchOpenBugs(filterUrl: string, nextPageToken?: string): Promise<JiraSearchPage>;
  claimIssue(issueKey: string): Promise<void>;
  ensureMergeRequestLink(issueKey: string, mergeRequestUrl: string): Promise<void>;
  ensureReadyToMerge(issueKey: string): Promise<void>;
}

export class HttpJiraClient implements JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  async getIssue(issueKey: string): Promise<JiraIssueDto> {
    const response = await fetch(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=changelog`,
      {
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`Jira returned ${response.status}`);
    return (await response.json()) as JiraIssueDto;
  }
  async searchOpenBugs(filterUrl: string, nextPageToken?: string): Promise<JiraSearchPage> {
    const filterId = extractFilterId(filterUrl);
    const url = new URL(`${this.baseUrl}/rest/api/3/search/jql`);
    url.searchParams.set("jql", `filter=${filterId} AND issuetype=Bug AND statusCategory != Done`);
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("fields", "*all");
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    const response = await this.request(url, { headers: { accept: "application/json" } });
    const body = (await response.json()) as {
      issues: JiraIssueDto[];
      nextPageToken?: string;
      isLast?: boolean;
    };
    return {
      issues: body.issues,
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
      isLast: body.isLast ?? !body.nextPageToken,
    };
  }
  async claimIssue(issueKey: string): Promise<void> {
    const myself = await this.request(new URL(`${this.baseUrl}/rest/api/3/myself`), {
      headers: { accept: "application/json" },
    });
    const { accountId } = (await myself.json()) as { accountId: string };
    await this.request(
      new URL(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      },
    );
    await this.transition(issueKey, "In Progress");
  }
  async ensureMergeRequestLink(issueKey: string, mergeRequestUrl: string): Promise<void> {
    const url = new URL(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`,
    );
    const globalId = `ticket-bot:${mergeRequestUrl}`;
    const existing = (await (
      await this.request(url, { headers: { accept: "application/json" } })
    ).json()) as Array<{
      globalId?: string;
    }>;
    if (existing.some((link) => link.globalId === globalId)) return;
    await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalId, object: { url: mergeRequestUrl, title: "Merge request" } }),
    });
  }
  ensureReadyToMerge(issueKey: string): Promise<void> {
    return this.transition(issueKey, "Ready to merge");
  }
  private async transition(issueKey: string, targetName: string): Promise<void> {
    const issue = await this.getIssue(issueKey);
    if (issue.fields.status.name.toLowerCase() === targetName.toLowerCase()) return;
    const url = new URL(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    const available = await this.request(url, { headers: { accept: "application/json" } });
    const body = (await available.json()) as { transitions: Array<{ id: string; name: string }> };
    const transition = body.transitions.find(
      (item) => item.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (!transition) {
      const refreshed = await this.getIssue(issueKey);
      if (refreshed.fields.status.name.toLowerCase() === targetName.toLowerCase()) return;
      throw new Error(`Jira transition ${targetName} is unavailable for ${issueKey}`);
    }
    await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }
  private async request(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Jira returned ${response.status}`);
    return response;
  }
}

export class FakeJiraClient implements JiraClient {
  readonly claimed: string[] = [];
  readonly linkedMergeRequests: Array<{ issueKey: string; mergeRequestUrl: string }> = [];
  readonly readyToMerge: string[] = [];
  constructor(private readonly issues: ReadonlyMap<string, JiraIssueDto>) {}
  async getIssue(issueKey: string): Promise<JiraIssueDto> {
    const issue = this.issues.get(issueKey);
    if (!issue) throw new Error(`Fake Jira issue ${issueKey} does not exist`);
    return structuredClone(issue);
  }
  async searchOpenBugs(_filterUrl: string, nextPageToken?: string): Promise<JiraSearchPage> {
    if (nextPageToken) return { issues: [], isLast: true };
    return {
      issues: [...this.issues.values()]
        .filter(
          (issue) =>
            issue.fields.issuetype?.name.toLowerCase() === "bug" &&
            issue.fields.status.name.toLowerCase() !== "done",
        )
        .map((issue) => structuredClone(issue)),
      isLast: true,
    };
  }
  claimIssue(issueKey: string): Promise<void> {
    this.claimed.push(issueKey);
    return Promise.resolve();
  }
  ensureMergeRequestLink(issueKey: string, mergeRequestUrl: string): Promise<void> {
    if (
      !this.linkedMergeRequests.some(
        (item) => item.issueKey === issueKey && item.mergeRequestUrl === mergeRequestUrl,
      )
    )
      this.linkedMergeRequests.push({ issueKey, mergeRequestUrl });
    return Promise.resolve();
  }
  ensureReadyToMerge(issueKey: string): Promise<void> {
    if (!this.readyToMerge.includes(issueKey)) this.readyToMerge.push(issueKey);
    return Promise.resolve();
  }
}

function extractFilterId(filterUrl: string): string {
  const url = new URL(filterUrl);
  const filter = url.searchParams.get("filter") ?? url.pathname.match(/\/filters?\/(\d+)/)?.[1];
  if (!filter || !/^\d+$/.test(filter))
    throw new Error("Jira filter URL does not contain a numeric filter ID");
  return filter;
}
