import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { RepositoryConfig } from "../domain/repository.js";
import type { Workspace } from "./execution-runner.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceInspection {
  changedFiles: string[];
  diff: string;
  diffSummary: string;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  constructor(
    private readonly root: string,
    private readonly keepWorkspaces: boolean,
  ) {}

  async create(
    workflowId: string,
    issueKey: string,
    shortSlug: string,
    repository: RepositoryConfig,
  ): Promise<Workspace> {
    const root = resolve(this.root);
    await mkdir(root, { recursive: true });
    const suffix = createHash("sha256").update(workflowId).digest("hex").slice(0, 12);
    const path = resolve(root, `${sanitize(issueKey)}-${suffix}`);
    if (!path.startsWith(`${root}/`))
      throw new DomainError("WORKSPACE_FAILURE", "Resolved workspace escaped its root");
    const branchName = `agent/${issueKey.toLowerCase()}/${slug(shortSlug)}`;
    try {
      if (await pathExists(path)) {
        const { stdout: existingBranch } = await execFileAsync(
          "git",
          ["branch", "--show-current"],
          { cwd: path },
        );
        const { stdout: existingBase } = await execFileAsync(
          "git",
          ["merge-base", "HEAD", repository.defaultBranch],
          { cwd: path },
        );
        const resolvedPath = await realpath(path);
        const workspace = {
          id: resolvedPath,
          path: resolvedPath,
          branchName:
            existingBranch.trim() === repository.defaultBranch ? branchName : existingBranch.trim(),
          baseCommitSha: existingBase.trim(),
        };
        this.workspaces.set(resolvedPath, workspace);
        return workspace;
      }
      await execFileAsync("git", ["clone", "--no-hardlinks", repository.cloneUrl, path], {
        timeout: 120_000,
      });
      await execFileAsync("git", ["checkout", repository.defaultBranch], {
        cwd: path,
        timeout: 30_000,
      });
      const { stdout: base } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: path,
        timeout: 10_000,
      });
      const resolvedPath = await realpath(path);
      const workspace = {
        id: resolvedPath,
        path: resolvedPath,
        branchName,
        baseCommitSha: base.trim(),
      };
      this.workspaces.set(resolvedPath, workspace);
      return workspace;
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw new DomainError(
        "WORKSPACE_FAILURE",
        `Could not create workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async activateBranch(workspace: Workspace): Promise<Workspace> {
    this.assertKnown(workspace.id);
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
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  async inspect(workspace: Workspace): Promise<WorkspaceInspection> {
    this.assertKnown(workspace.id);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: workspace.path,
      maxBuffer: 2_000_000,
    });
    const changedFiles = status
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").at(-1) ?? "");
    const { stdout: diff } = await execFileAsync(
      "git",
      ["diff", "--no-ext-diff", "--binary", "HEAD"],
      { cwd: workspace.path, maxBuffer: 10_000_000 },
    );
    const { stdout: summary } = await execFileAsync("git", ["diff", "--stat", "HEAD"], {
      cwd: workspace.path,
      maxBuffer: 1_000_000,
    });
    return { changedFiles, diff, diffSummary: summary };
  }

  async writeArtifact(workspace: Workspace, relativePath: string, content: string): Promise<void> {
    this.assertKnown(workspace.id);
    const target = resolve(workspace.path, relativePath);
    if (!target.startsWith(`${resolve(workspace.path)}/`))
      throw new DomainError("WORKSPACE_FAILURE", "Artifact path escaped its workspace");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async inspectFromBase(workspace: Workspace): Promise<WorkspaceInspection> {
    this.assertKnown(workspace.id);
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

  async commit(workspace: Workspace, message: string): Promise<string> {
    this.assertKnown(workspace.id);
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

  async push(workspace: Workspace): Promise<void> {
    this.assertKnown(workspace.id);
    try {
      await execFileAsync("git", ["push", "--set-upstream", "origin", workspace.branchName], {
        cwd: workspace.path,
        timeout: 120_000,
      });
    } catch (error) {
      throw new DomainError("PUSH_FAILURE", error instanceof Error ? error.message : String(error));
    }
  }

  async destroy(id: string): Promise<void> {
    const workspace = this.workspaces.get(id);
    this.workspaces.delete(id);
    if (!this.keepWorkspaces && this.isWithinRoot(id))
      await rm(workspace?.path ?? id, { recursive: true, force: true });
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }
  private assertKnown(id: string): void {
    if (!this.workspaces.has(id) && !this.isWithinRoot(id))
      throw new DomainError("WORKSPACE_FAILURE", `Unknown workspace ${id}`);
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
      .slice(0, 48) || "bug-fix"
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
