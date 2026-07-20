import z from "zod";
import { MergeRequest } from "../../domain/merge-request.js";
import { CLI } from "./cli-runner.js";
import { CreateMergeRequestInput, WaitForChecksOutput } from "./forge.js";

export class GitLabClient {
  constructor(private readonly glab: CLI) {}

  async createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest> {
    const existing = await this.glab.run(["mr", "view", "--output", "json"], input.repositoryPath);
    if (existing.exitCode == 0) throw Error("MR already exists");

    await this.glab.run(
      [
        "mr",
        "create",
        "--target-branch",
        input.targetBranch,
        "--title",
        input.title,
        "--description",
        input.description,
        "--no-editor",
        "--yes",
        "--draft",
        "--assignee",
        "@me",
        "--label",
        "LHIND",
      ],
      input.repositoryPath,
    );

    const result = await this.glab.run(["mr", "view", "--output", "json"], input.repositoryPath);
    if (result.exitCode != 0) {
      throw new Error("glab created a merge request that could not be resolved");
    }

    return MergeRequest.parse(JSON.parse(result.stderr));
  }

  async waitForChecks(
    commit: string,
    name: string,
    repositoryPath: string,
  ): Promise<WaitForChecksOutput> {
    await this.glab.run(["ci", "status", "--wait"], repositoryPath);

    const result = await this.glab.run(
      ["api", `projects/:id/repository/commits/${commit}/statuses?all=true&sort=desc&order_by=id`],
      repositoryPath,
    );

    if (result.exitCode != 0) {
      throw new Error("glab failed to fetch commit statuses");
    }

    const statuses = CommitStatusesResponse.parse(JSON.parse(result.stdout));

    // list sorted desc by monotonous id, latest comes first.
    const target = statuses.find((status) => status.name == name);

    if (!target) {
      throw new Error("glab failed to find check with name");
    }

    return {
      targetUrl: target.target_url,
      success: target.status == "success",
    };
  }
}

const CommitStatusesResponse = z
  .object({
    name: z.string().nullish(),
    pipeline_id: z.int().nullish(),
    target_url: z.url().nullish(),
    status: z.string(),
  })
  .array();
