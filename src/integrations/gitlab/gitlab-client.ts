import type { CreateMergeRequestInput, MergeRequest } from "../../domain/merge-request.js";
import type { ForgeClient } from "../forge/forge-client.js";

export class HttpGitLabClient implements ForgeClient {
  constructor(private readonly token: string | undefined) {}
  async createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest> {
    if (!this.token) throw new Error("GITLAB_TOKEN is required for GitLab repositories");
    const baseUrl = new URL(input.repositoryUrl).origin;
    const assigneeId = input.assignToCurrentUser
      ? await this.currentUserId(baseUrl, this.token)
      : undefined;

    const response = await fetch(
      `${baseUrl}/api/v4/projects/${encodeURIComponent(input.projectId)}/merge_requests`,
      {
        method: "POST",
        headers: {
          "private-token": this.token,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify({
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          title: input.title,
          description: input.description,
          draft: input.draft,
          labels: input.labels.join(","),
          ...(assigneeId ? { assignee_id: assigneeId } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) throw new Error(`GitLab returned ${response.status}`);
    const body = (await response.json()) as { iid: number; web_url: string };
    return { projectId: input.projectId, iid: body.iid, url: body.web_url };
  }
  private async currentUserId(baseUrl: string, token: string): Promise<number> {
    const response = await fetch(`${baseUrl}/api/v4/user`, {
      headers: { "private-token": token },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`GitLab returned ${response.status}`);
    return ((await response.json()) as { id: number }).id;
  }
}

export class FakeGitLabClient implements ForgeClient {
  readonly created: CreateMergeRequestInput[] = [];
  async createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest> {
    const existing = this.created.findIndex((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing >= 0)
      return {
        projectId: input.projectId,
        iid: existing + 1,
        url: `https://gitlab.example/${input.projectId}/-/merge_requests/${existing + 1}`,
      };

    this.created.push(structuredClone(input));
    const iid = this.created.length;
    return {
      projectId: input.projectId,
      iid,
      url: `https://gitlab.example/${input.projectId}/-/merge_requests/${iid}`,
    };
  }
}
