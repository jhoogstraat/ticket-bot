import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { RepositoryConfig } from "../../../domain/repository.js";

const execFileAsync = promisify(execFile);

export interface RepositoryWorkspace {
  path: string;
  branchName: string;
  baseCommitSha: string;
}

export interface CreateRepositoryWorkspaceInput {
  workflowId: string;
  issueKey: string;
  shortSlug: string;
  repository: RepositoryConfig;
}

export interface WorkspaceChanges {
  changedFiles: string[];
}

export interface WorkspaceInspection extends WorkspaceChanges {
  diff: string;
  diffSummary: string;
}

export class LocalGitWorkspaces {
  constructor(private readonly root: string) {}

  async create(input: CreateRepositoryWorkspaceInput): Promise<RepositoryWorkspace> {
    const root = resolve(this.root);
    await mkdir(root, { recursive: true });
    const suffix = createHash("sha256").update(input.workflowId).digest("hex").slice(0, 12);
    const path = resolve(root, `${sanitize(input.issueKey)}-${suffix}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Resolved workspace escaped its root");

    const branchName = `agent/${input.issueKey.toLowerCase()}/${slug(input.shortSlug)}`;
    let createdWorkspace = false;
    try {
      if (await pathExists(path)) {
        const { stdout: existingBranch } = await execFileAsync(
          "git",
          ["branch", "--show-current"],
          { cwd: path },
        );

        const { stdout: existingBase } = await execFileAsync(
          "git",
          ["merge-base", "HEAD", input.repository.defaultBranch],
          { cwd: path },
        );

        const workspace = {
          path,
          branchName:
            existingBranch.trim() === input.repository.defaultBranch
              ? branchName
              : existingBranch.trim(),
          baseCommitSha: existingBase.trim(),
        };

        return workspace;
      }

      createdWorkspace = true;
      await execFileAsync("git", ["clone", "--no-hardlinks", input.repository.cloneUrl, path], {
        timeout: 120_000,
      });

      await execFileAsync("git", ["checkout", input.repository.defaultBranch], {
        cwd: path,
        timeout: 30_000,
      });

      const { stdout: base } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: path,
        timeout: 10_000,
      });

      const workspace = {
        path,
        branchName,
        baseCommitSha: base.trim(),
      };

      return workspace;
    } catch (error) {
      if (createdWorkspace) await rm(path, { recursive: true, force: true });
      throw new Error(
        `Could not create workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async activateBranch(workspace: RepositoryWorkspace): Promise<RepositoryWorkspace> {
    this.assertContained(workspace);
    const { stdout: current } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: workspace.path,
    });

    if (current.trim() !== workspace.branchName) {
      try {
        await execFileAsync("git", ["checkout", "-b", workspace.branchName], {
          cwd: workspace.path,
          timeout: 30_000,
        });
      } catch {
        await execFileAsync("git", ["checkout", workspace.branchName], {
          cwd: workspace.path,
          timeout: 30_000,
        });
      }
    }

    return workspace;
  }

  async inspectPendingChanges(workspace: RepositoryWorkspace): Promise<WorkspaceChanges> {
    this.assertContained(workspace);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: workspace.path,
      maxBuffer: 2_000_000,
    });

    const changedFiles = status
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").at(-1) ?? "");

    return { changedFiles };
  }

  async writeInvestigationReport(
    workspace: RepositoryWorkspace,
    issueKey: string,
    content: string,
  ): Promise<void> {
    this.assertContained(workspace);
    const target = resolve(workspace.path, "ticket-analysis", sanitize(issueKey), "ANALYSIS.md");
    if (!target.startsWith(`${resolve(workspace.path)}/`))
      throw new Error("Artifact path escaped its workspace");

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async inspectChangesSinceBase(workspace: RepositoryWorkspace): Promise<WorkspaceInspection> {
    this.assertContained(workspace);
    const { stdout: names } = await execFileAsync(
      "git",
      ["diff", "--name-only", `${workspace.baseCommitSha}..HEAD`],
      { cwd: workspace.path, maxBuffer: 2_000_000 },
    );

    const { stdout: diff } = await execFileAsync(
      "git",
      ["diff", "--no-ext-diff", "--binary", `${workspace.baseCommitSha}..HEAD`],
      { cwd: workspace.path, maxBuffer: 10_000_000 },
    );

    const { stdout: summary } = await execFileAsync(
      "git",
      ["diff", "--stat", `${workspace.baseCommitSha}..HEAD`],
      { cwd: workspace.path, maxBuffer: 1_000_000 },
    );

    return { changedFiles: names.split(/\r?\n/).filter(Boolean), diff, diffSummary: summary };
  }

  async commitChanges(workspace: RepositoryWorkspace, message: string): Promise<string> {
    this.assertContained(workspace);
    await execFileAsync("git", ["add", "--all"], { cwd: workspace.path });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Bug Agent",
        "-c",
        "user.email=bug-agent@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message,
      ],
      { cwd: workspace.path, timeout: 60_000 },
    );

    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.path });
    return stdout.trim();
  }

  async pushBranch(workspace: RepositoryWorkspace): Promise<void> {
    this.assertContained(workspace);
    try {
      await execFileAsync("git", ["push", "--set-upstream", "origin", workspace.branchName], {
        cwd: workspace.path,
        timeout: 120_000,
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  private assertContained(workspace: RepositoryWorkspace): void {
    if (!this.isWithinRoot(workspace.path))
      throw new Error("Workspace escaped its configured root");
  }
  private isWithinRoot(path: string): boolean {
    const root = resolve(this.root);
    return resolve(path).startsWith(`${root}/`);
  }
}

function sanitize(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "bugfix"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
