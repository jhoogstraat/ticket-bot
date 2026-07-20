import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_WRITE_TIMEOUT_MS = 60_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;

const DEFAULT_MAX_BUFFER_BYTES = 2_000_000;
const DIFF_MAX_BUFFER_BYTES = 10_000_000;

export interface RepositoryWorkspace {
  path: string;
  branchName: string;
  baseCommitSha: string;
  defaultBranch: string;
}

interface RootPaths {
  logical: string;
  real: string;
}

interface GitResult {
  stdout: string;
  exitCode: number;
}

interface GitOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  acceptedExitCodes?: readonly number[];
  redact?: readonly string[];
}

interface GitFailure {
  code: number | string | undefined;
  killed: boolean;
  stderr: string;
  stdout: string;
}

export class LocalGitWorkspaces {
  constructor(private readonly root: string) {}

  async create(
    workflowId: string,
    issueKey: string,
    shortSlug: string,
    url: string,
  ): Promise<RepositoryWorkspace> {
    const root = await this.resolveRoot(true);
    const suffix = workflowSuffix(workflowId);
    const issueSegment = safeSegment(issueKey, "issue", 40);
    const workspacePath = resolve(root.logical, `${issueSegment}-${suffix}`);
    const branchName = `agent/${issueSegment.toLowerCase()}/${safeSegment(shortSlug.toLowerCase(), "bugfix", 48)}-${suffix}`;

    assertChildPath(root.logical, workspacePath, "Workspace path escaped its configured root");
    await assertValidBranchName(branchName);

    try {
      if (await pathExists(workspacePath)) {
        return await this.loadExistingWorkspace(workspacePath, branchName, url);
      }

      return await this.cloneWorkspaceAtomically(root, workspacePath, branchName, url, suffix);
    } catch (error) {
      throw new Error(
        `Could not create workspace: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  async activateBranch(workspace: RepositoryWorkspace): Promise<void> {
    const cwd = await this.assertUsableWorkspace(workspace);
    const currentBranch = await currentBranchName(cwd);

    if (currentBranch === workspace.branchName) return;

    const branchRef = `refs/heads/${workspace.branchName}`;
    const branchExists =
      (
        await runGit(["show-ref", "--verify", "--quiet", branchRef], {
          cwd,
          acceptedExitCodes: [0, 1],
        })
      ).exitCode === 0;

    await runGit(
      branchExists
        ? ["switch", "--", workspace.branchName]
        : ["switch", "-c", workspace.branchName, "--"],
      { cwd, timeout: GIT_WRITE_TIMEOUT_MS },
    );
  }

  async inspectPendingChanges(workspace: RepositoryWorkspace): Promise<string[]> {
    const cwd = await this.assertUsableWorkspace(workspace);
    const { stdout } = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      timeout: GIT_READ_TIMEOUT_MS,
    });

    return parsePorcelainV1Z(stdout);
  }

  /** Inspects committed changes between the recorded base commit and HEAD. */
  async inspectChangesSinceBase(workspace: RepositoryWorkspace) {
    const cwd = await this.assertUsableWorkspace(workspace);
    await runGit(["cat-file", "-e", `${workspace.baseCommitSha}^{commit}`], {
      cwd,
      maxBuffer: 64_000,
    });

    const revisions = [workspace.baseCommitSha, "HEAD", "--"];
    const [diff, summary] = await Promise.all([
      runGit(["diff", "--no-ext-diff", "--no-textconv", ...revisions], {
        cwd,
        maxBuffer: DIFF_MAX_BUFFER_BYTES,
        timeout: GIT_READ_TIMEOUT_MS,
      }),
      runGit(["diff", "--stat", "--no-ext-diff", ...revisions], {
        cwd,
        maxBuffer: 1_000_000,
        timeout: GIT_READ_TIMEOUT_MS,
      }),
    ]);

    return {
      diff: diff.stdout,
      diffSummary: summary.stdout,
    };
  }

  async commitChanges(workspace: RepositoryWorkspace, message: string): Promise<void> {
    const cwd = await this.assertUsableWorkspace(workspace);
    await assertActiveBranch(cwd, workspace.branchName);

    await runGit(["add", "--all", "--"], {
      cwd,
      timeout: GIT_WRITE_TIMEOUT_MS,
    });

    const stagedDiff = await runGit(["diff", "--cached", "--quiet", "--"], {
      cwd,
      timeout: GIT_READ_TIMEOUT_MS,
      acceptedExitCodes: [0, 1],
    });

    if (stagedDiff.exitCode === 0) throw new Error("There are no changes to commit");

    await runGit(
      [
        "-c",
        "user.name=Bug Agent",
        "-c",
        "user.email=bug-agent@localhost",
        "commit",
        "--no-gpg-sign",
        "-m",
        message,
      ],
      { cwd, timeout: GIT_WRITE_TIMEOUT_MS },
    );
  }

  async getHeadCommitSha(workspace: RepositoryWorkspace): Promise<string> {
    const cwd = await this.assertUsableWorkspace(workspace);
    await assertActiveBranch(cwd, workspace.branchName);

    const { stdout } = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      timeout: GIT_READ_TIMEOUT_MS,
    });

    return stdout.trim();
  }

  async pushBranch(workspace: RepositoryWorkspace): Promise<void> {
    const cwd = await this.assertUsableWorkspace(workspace);
    await assertActiveBranch(cwd, workspace.branchName);

    const branchRef = `refs/heads/${workspace.branchName}`;
    await runGit(["push", "--set-upstream", "origin", `${branchRef}:${branchRef}`], {
      cwd,
      timeout: GIT_NETWORK_TIMEOUT_MS,
    });
  }

  private async cloneWorkspaceAtomically(
    root: RootPaths,
    workspacePath: string,
    branchName: string,
    url: string,
    suffix: string,
  ): Promise<RepositoryWorkspace> {
    const temporaryPath = await mkdtemp(resolve(root.logical, `.creating-${suffix}-`));
    assertChildPath(root.logical, temporaryPath, "Temporary workspace escaped its root");

    let operationFailed = false;
    let operationError: unknown;

    try {
      await runGit(["clone", "--no-hardlinks", "--", url, temporaryPath], {
        timeout: GIT_NETWORK_TIMEOUT_MS,
        redact: [url],
      });

      const temporaryRoot = await this.assertUsableWorkspacePath(temporaryPath);
      const defaultBranch = await resolveDefaultBranch(temporaryRoot);
      const baseCommitSha = (
        await runGit(["rev-parse", "--verify", "HEAD^{commit}"], {
          cwd: temporaryRoot,
          maxBuffer: 64_000,
        })
      ).stdout.trim();

      try {
        await rename(temporaryPath, workspacePath);
      } catch (error) {
        // Another process may have published the same deterministic workspace first.
        if (!(await pathExists(workspacePath))) throw error;
        return await this.loadExistingWorkspace(workspacePath, branchName, url);
      }

      return { path: workspacePath, branchName, baseCommitSha, defaultBranch };
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      await removeTemporaryWorkspace(temporaryPath, operationFailed, operationError);
    }
  }

  private async loadExistingWorkspace(
    workspacePath: string,
    branchName: string,
    url: string,
  ): Promise<RepositoryWorkspace> {
    const cwd = await this.assertUsableWorkspacePath(workspacePath);

    const [fetchOrigin, pushOrigin, currentBranch] = await Promise.all([
      runGit(["remote", "get-url", "origin"], { cwd }),
      runGit(["remote", "get-url", "--push", "origin"], { cwd }),
      currentBranchName(cwd),
    ]);

    if (fetchOrigin.stdout.trim() !== url || pushOrigin.stdout.trim() !== url) {
      throw new Error("Existing workspace origin does not match the submitted repository");
    }

    const defaultBranch = await resolveDefaultBranch(cwd);
    if (currentBranch !== defaultBranch && currentBranch !== branchName) {
      throw new Error(`Existing workspace is on unexpected branch ${currentBranch || "HEAD"}`);
    }

    const baseCommitSha = (
      await runGit(["merge-base", "HEAD", `refs/remotes/origin/${defaultBranch}`], { cwd })
    ).stdout.trim();

    return { path: workspacePath, branchName, baseCommitSha, defaultBranch };
  }

  private async assertUsableWorkspace(workspace: RepositoryWorkspace): Promise<string> {
    await assertValidBranchName(workspace.branchName);
    return await this.assertUsableWorkspacePath(workspace.path);
  }

  private async assertUsableWorkspacePath(workspacePath: string): Promise<string> {
    const workspaceRoot = await this.assertWorkspaceContained(workspacePath);
    await assertGitLayout(workspaceRoot);
    return workspaceRoot;
  }

  private async assertWorkspaceContained(workspacePath: string): Promise<string> {
    const root = await this.resolveRoot(false);
    const logicalWorkspace = resolve(workspacePath);
    assertChildPath(root.logical, logicalWorkspace, "Workspace escaped its configured root");

    const realWorkspace = await realpath(logicalWorkspace);
    assertChildPath(root.real, realWorkspace, "Workspace escaped its configured root");
    return realWorkspace;
  }

  private async resolveRoot(create: boolean): Promise<RootPaths> {
    const logical = resolve(this.root);
    if (create) await mkdir(logical, { recursive: true });
    return { logical, real: await realpath(logical) };
  }
}

async function runGit(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];

  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GCM_INTERACTIVE: "Never",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES,
      timeout: options.timeout ?? GIT_READ_TIMEOUT_MS,
      windowsHide: true,
    });

    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = gitFailure(error);

    const exitCode = typeof failure.code === "number" ? failure.code : undefined;

    if (exitCode !== undefined && acceptedExitCodes.includes(exitCode)) {
      return {
        stdout: failure.stdout,
        exitCode,
      };
    }

    const subcommand = args[0] ?? "command";
    const stderr = redactSecrets(failure.stderr.trim().slice(0, 4_000), options.redact ?? []);

    const reason = failure.killed
      ? "timed out or was terminated"
      : failure.code === "ENOENT"
        ? "Git executable was not found"
        : `failed${exitCode === undefined ? "" : ` with exit code ${exitCode}`}`;

    throw new Error(`git ${subcommand} ${reason}${stderr.length > 0 ? `: ${stderr}` : ""}`);
  }
}

async function removeTemporaryWorkspace(
  temporaryPath: string,
  operationFailed: boolean,
  operationError: unknown,
): Promise<void> {
  try {
    await rm(temporaryPath, { recursive: true, force: true });
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Workspace operation and cleanup both failed",
      );
    }

    throw cleanupError;
  }
}

function gitFailure(error: unknown): GitFailure {
  if (!isRecord(error)) {
    return { code: undefined, killed: false, stderr: "", stdout: "" };
  }

  const code = error.code;
  return {
    code: typeof code === "number" || typeof code === "string" ? code : undefined,
    killed: error.killed === true,
    stderr: processOutput(error.stderr),
    stdout: processOutput(error.stdout),
  };
}

function processOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString() : "";
}

async function assertValidBranchName(branchName: string): Promise<void> {
  try {
    await runGit(["check-ref-format", "--branch", branchName], {
      maxBuffer: 64_000,
    });
  } catch {
    throw new Error(`Invalid Git branch name: ${JSON.stringify(branchName)}`);
  }
}

async function assertGitLayout(workspaceRoot: string): Promise<void> {
  const [topLevel, gitDirectory] = await Promise.all([
    runGit(["rev-parse", "--show-toplevel"], { cwd: workspaceRoot }),
    runGit(["rev-parse", "--absolute-git-dir"], { cwd: workspaceRoot }),
  ]);

  const realTopLevel = await realpath(topLevel.stdout.trim());
  if (realTopLevel !== workspaceRoot) {
    throw new Error("Git worktree root does not match the workspace root");
  }

  const realGitDirectory = await realpath(gitDirectory.stdout.trim());
  assertChildPath(workspaceRoot, realGitDirectory, "Git metadata directory escaped its workspace");
}

async function assertActiveBranch(cwd: string, expectedBranch: string): Promise<void> {
  const currentBranch = await currentBranchName(cwd);
  if (currentBranch !== expectedBranch) {
    throw new Error(
      `Expected active branch ${expectedBranch}, found ${currentBranch || "detached HEAD"}`,
    );
  }
}

async function currentBranchName(cwd: string): Promise<string> {
  return (
    await runGit(["branch", "--show-current"], {
      cwd,
      maxBuffer: 64_000,
    })
  ).stdout.trim();
}

async function resolveDefaultBranch(cwd: string): Promise<string> {
  const ref = (
    await runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      maxBuffer: 64_000,
    })
  ).stdout.trim();

  const prefix = "origin/";
  if (!ref.startsWith(prefix)) throw new Error("Could not resolve the remote default branch");

  const branch = ref.slice(prefix.length);
  await assertValidBranchName(branch);
  return branch;
}

function parsePorcelainV1Z(status: string): string[] {
  const records = status.split("\0");
  const changedFiles = new Set<string>();

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Unexpected git status --porcelain=v1 -z output");
    }

    const state = record.slice(0, 2);
    changedFiles.add(record.slice(3));

    // With -z, rename/copy records contain the destination first and source second.
    if (state.includes("R") || state.includes("C")) {
      index++;
      if (!records[index]) {
        throw new Error("Incomplete rename/copy entry in git status output");
      }
    }
  }

  return [...changedFiles];
}

function assertChildPath(root: string, candidate: string, message: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(message);
  }
}

function workflowSuffix(workflowId: string): string {
  return new Bun.CryptoHasher("sha256").update(workflowId).digest("hex").slice(0, 12);
}

function safeSegment(value: string, fallback: string, maxLength: number): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

  return sanitized || fallback;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@");
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  return redacted;
}
