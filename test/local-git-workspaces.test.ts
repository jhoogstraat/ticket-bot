import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepositoryTarget } from "../src/domain/repository.js";
import { LocalGitWorkspaces } from "../src/integrations/git/local-git-workspaces.js";

const exec = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalGitWorkspaces", () => {
  it("creates, activates, and reopens the expected repository workspace", async () => {
    const root = await createRepositoryFixture();
    const source = join(root, "source");
    const workspaces = new LocalGitWorkspaces(join(root, "workspaces"));
    const repository = repositoryConfig(source);

    const workspace = await workspaces.create(
      "bugfix/ABC-1/1",
      "ABC-1",
      "Fix the thing",
      repository,
    );

    await workspaces.activateBranch(workspace);

    const { stdout: activeBranch } = await exec("git", [
      "-C",
      workspace.path,
      "branch",
      "--show-current",
    ]);

    expect(activeBranch.trim()).toBe(workspace.branchName);

    const reopened = await workspaces.create(
      "bugfix/ABC-1/1",
      "ABC-1",
      "Fix the thing",
      repository,
    );

    expect(reopened).toEqual(workspace);
  });

  it("preserves an existing checkout when reopening it fails", async () => {
    const root = await createRepositoryFixture();
    const source = join(root, "source");
    const workspaces = new LocalGitWorkspaces(join(root, "workspaces"));
    const repository = repositoryConfig(source);

    const workspace = await workspaces.create(
      "bugfix/ABC-1/1",
      "ABC-1",
      "Keep existing workspace",
      repository,
    );

    await rm(join(workspace.path, ".git"), { recursive: true, force: true });

    let reopenError: unknown;
    try {
      await workspaces.create("bugfix/ABC-1/1", "ABC-1", "Keep existing workspace", repository);
    } catch (error) {
      reopenError = error;
    }

    expect(reopenError).toHaveProperty(
      "message",
      expect.stringContaining("Could not create workspace"),
    );

    expect((await stat(workspace.path)).isDirectory()).toBe(true);
  });

  it("rejects an existing checkout from a different origin without deleting it", async () => {
    const root = await createRepositoryFixture();
    const source = join(root, "source");
    const workspaces = new LocalGitWorkspaces(join(root, "workspaces"));
    const repository = repositoryConfig(source);
    const workspace = await workspaces.create("bugfix/ABC-1", "ABC-1", "Wrong origin", repository);
    await exec("git", ["-C", workspace.path, "remote", "set-url", "origin", join(root, "other")]);

    expect(workspaces.create("bugfix/ABC-1", "ABC-1", "Wrong origin", repository)).rejects.toThrow(
      "does not match",
    );

    expect((await stat(workspace.path)).isDirectory()).toBe(true);
  });

  it("rejects an existing checkout on an unrelated branch", async () => {
    const root = await createRepositoryFixture();
    const source = join(root, "source");
    const workspaces = new LocalGitWorkspaces(join(root, "workspaces"));
    const repository = repositoryConfig(source);
    const workspace = await workspaces.create(
      "bugfix/ABC-1",
      "ABC-1",
      "Expected branch",
      repository,
    );

    await exec("git", ["-C", workspace.path, "checkout", "-b", "agent/unrelated"]);

    expect(
      workspaces.create("bugfix/ABC-1", "ABC-1", "Expected branch", repository),
    ).rejects.toThrow("unexpected branch");
  });

  it("reports renamed and untracked files without corrupting unusual names", async () => {
    const root = await createRepositoryFixture();
    const source = join(root, "source");
    const workspaces = new LocalGitWorkspaces(join(root, "workspaces"));
    const workspace = await workspaces.create(
      "bugfix/ABC-1",
      "ABC-1",
      "Odd filenames",
      repositoryConfig(source),
    );

    const renamedFile = "renamed -> file\n.txt";
    const untrackedFile = "new\nfile ->.txt";
    await exec("git", ["-C", workspace.path, "mv", "README.md", renamedFile]);
    await writeFile(join(workspace.path, untrackedFile), "fixture\n", "utf8");

    const inspection = await workspaces.inspectPendingChanges(workspace);

    expect(inspection.changedFiles.toSorted()).toEqual([renamedFile, untrackedFile].toSorted());

    await workspaces.activateBranch(workspace);
    await workspaces.commitChanges(workspace, "test: preserve unusual names");
    const committedInspection = await workspaces.inspectChangesSinceBase(workspace);

    expect(committedInspection.changedFiles.toSorted()).toEqual(
      [renamedFile, untrackedFile].toSorted(),
    );
  });

  it("rejects a workspace symlink that resolves outside the configured root", async () => {
    const root = await createRepositoryFixture();
    const workspaceRoot = join(root, "workspaces");
    const workspaces = new LocalGitWorkspaces(workspaceRoot);
    const workspace = await workspaces.create(
      "bugfix/ABC-1",
      "ABC-1",
      "Contained",
      repositoryConfig(join(root, "source")),
    );

    const outside = join(root, "outside");
    const linkedWorkspace = join(workspaceRoot, "linked-workspace");
    await mkdir(outside);
    await symlink(outside, linkedWorkspace, "dir");

    expect(
      workspaces.inspectPendingChanges({ ...workspace, path: linkedWorkspace }),
    ).rejects.toThrow("Workspace escaped its configured root");
  });

  it("removes its reserved directory when cloning fails", async () => {
    const root = await createRepositoryFixture();
    const workspaceRoot = join(root, "workspaces");
    const workspaces = new LocalGitWorkspaces(workspaceRoot);

    expect(
      workspaces.create(
        "bugfix/ABC-1",
        "ABC-1",
        "Clone fails",
        repositoryConfig(join(root, "missing")),
      ),
    ).rejects.toThrow("Could not create workspace");

    expect(await readdir(workspaceRoot)).toEqual([]);
  });
});

async function createRepositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bug-bot-workspaces-"));
  temporaryRoots.push(root);
  const source = join(root, "source");

  await exec("git", ["init", "-b", "main", source]);
  await writeFile(join(source, "README.md"), "fixture\n", "utf8");
  await exec("git", ["-C", source, "add", "README.md"]);
  await exec("git", [
    "-C",
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial",
  ]);

  return root;
}

function repositoryConfig(source: string): RepositoryTarget {
  return {
    forge: "gitlab",
    url: source,
  };
}
