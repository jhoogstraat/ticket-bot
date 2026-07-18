import type { CreateMergeRequestInput, MergeRequest } from "../../domain/merge-request.js";
import type { ForgeClient } from "../forge/forge-client.js";

export class HttpGitHubClient implements ForgeClient {
  constructor(private readonly token: string | undefined) {}

  async createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest> {
    if (!this.token) throw new Error("GITHUB_TOKEN is required for GitHub repositories");
    const apiBase = githubApiBase(input.repositoryUrl);
    const projectPath = input.projectId
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    const response = await fetch(`${apiBase}/repos/${projectPath}/pulls`, {
      method: "POST",
      headers: this.headers(input.idempotencyKey),
      body: JSON.stringify({
        head: input.sourceBranch,
        base: input.targetBranch,
        title: input.title,
        body: input.description,
        draft: input.draft,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const body = (await response.json()) as { number: number; html_url: string };

    if (input.labels.length > 0 || input.assignToCurrentUser) {
      const assignees = input.assignToCurrentUser ? [await this.currentLogin(apiBase)] : [];
      const issueResponse = await fetch(`${apiBase}/repos/${projectPath}/issues/${body.number}`, {
        method: "PATCH",
        headers: this.headers(input.idempotencyKey),
        body: JSON.stringify({ labels: input.labels, assignees }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!issueResponse.ok) throw new Error(`GitHub returned ${issueResponse.status}`);
    }

    return { projectId: input.projectId, iid: body.number, url: body.html_url };
  }

  private async currentLogin(apiBase: string): Promise<string> {
    const response = await fetch(`${apiBase}/user`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return ((await response.json()) as { login: string }).login;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
    };
  }
}

export class FakeGitHubClient implements ForgeClient {
  readonly created: CreateMergeRequestInput[] = [];

  async createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest> {
    const existing = this.created.findIndex((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing >= 0)
      return {
        projectId: input.projectId,
        iid: existing + 1,
        url: `https://github.example/${input.projectId}/pull/${existing + 1}`,
      };

    this.created.push(structuredClone(input));
    const iid = this.created.length;
    return {
      projectId: input.projectId,
      iid,
      url: `https://github.example/${input.projectId}/pull/${iid}`,
    };
  }
}

function githubApiBase(repositoryUrl: string): string {
  const url = new URL(repositoryUrl);
  return url.hostname === "github.com" ? "https://api.github.com" : `${url.origin}/api/v3`;
}
