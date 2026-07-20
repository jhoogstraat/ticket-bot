import { MergeRequest } from "../../domain/merge-request.js";
import { CLI } from "./cli-runner.js";
import { CreateMergeRequestInput, WaitForChecksOutput } from "./forge.js";

export class GitHubClient {
  constructor(private readonly gh: CLI) {}

  async createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest> {
    const existing = await this.gh.run(["pr", "view", "--json"], input.repositoryPath);
    if (existing.exitCode == 0) throw Error("PR already exists");

    await this.gh.run(
      [
        "pr",
        "create",
        "--base",
        input.targetBranch,
        "--title",
        input.title,
        "--body",
        input.description,
        "--draft",
        "--assignee",
        "@me",
        "--label",
        "LHIND",
      ],
      input.repositoryPath,
    );

    const pr = await this.gh.run(
      ["pr", "view", "--json", "number,title,url,state,author"],
      input.repositoryPath,
    );

    if (pr.exitCode != 0) throw new Error("gh created a pull request that could not be resolved");

    return MergeRequest.parse(JSON.parse(pr.stdout));
  }

  async waitForChecks(
    commit: string,
    name: string,
    repositoryPath: string,
  ): Promise<WaitForChecksOutput> {
    const result = await this.gh.run(["pr", "checks", "--watch", "--fail-fast"], repositoryPath);

    return {
      targetUrl: null,
      success: result.exitCode == 0,
    };
  }
}
