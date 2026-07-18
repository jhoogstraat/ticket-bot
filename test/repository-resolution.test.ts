import { describe, expect, it } from "bun:test";
import { resolveRepository } from "../src/app/repository-configs.js";
import type { RepositoryConfig } from "../src/domain/repository.js";
import type { NormalizedBugTicket } from "../src/domain/ticket.js";

const config: RepositoryConfig = {
  id: "checkout",
  jiraComponents: ["Payments"],
  cloneUrl: "/repo",
  gitlabProjectId: "1",
  defaultBranch: "main",
  buildCommands: [],
  testCommands: [],
  lintCommands: [],
  harness: "codex",
  limits: { maxAgentTurns: 10, maxChangedFiles: 15, maxRepairAttempts: 3, maxExecutionMinutes: 45 },
};

const ticket = (component?: string): NormalizedBugTicket => ({
  key: "ABC-1",
  summary: "Bug",
  reproductionSteps: [],
  status: "Open",
  affectedVersions: [],
  statusHistory: [],
  labels: [],
  relevantComments: [],
  linkedIssues: [],
  attachments: [],
  ...(component ? { component } : {}),
});

describe("resolveRepository", () => {
  it("maps a Jira component", () =>
    expect(resolveRepository(ticket("Payments"), [config])).toBe(config));

  it("fails explicitly without a mapping", () =>
    expect(() => resolveRepository(ticket("Other"), [config])).toThrow(Error));
});
