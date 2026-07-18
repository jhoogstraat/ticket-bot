import type { RepositoryConfig } from "../domain/repository.js";
import type { NormalizedBugTicket } from "../domain/ticket.js";

export const repositoryConfigs: RepositoryConfig[] = [
  {
    id: "ticket-bot",
    jiraComponents: ["Ticket Bot", "Automation"],
    cloneUrl: process.cwd(),
    gitlabProjectId: "local/ticket-bot",
    defaultBranch: "main",
    buildCommands: ["bun run build"],
    testCommands: ["bun run test"],
    lintCommands: ["bun run lint"],
    harness: "codex",
    limits: {
      maxAgentTurns: 30,
      maxChangedFiles: 15,
      maxRepairAttempts: 3,
      maxExecutionMinutes: 45,
    },
  },
];

export function resolveRepository(
  ticket: NormalizedBugTicket,
  configs: RepositoryConfig[] = repositoryConfigs,
): RepositoryConfig {
  const hint = ticket.repositoryHint?.toLowerCase();
  const component = ticket.component?.toLowerCase();
  const match = configs.find(
    (config) =>
      config.id.toLowerCase() === hint ||
      config.cloneUrl.toLowerCase() === hint ||
      config.jiraComponents.some((value) => value.toLowerCase() === component),
  );

  if (!match) throw new Error(`No repository is configured for ${ticket.key}`);

  return match;
}
