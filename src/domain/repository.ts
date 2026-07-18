export interface RepositoryConfig {
  id: string;
  jiraComponents: string[];
  cloneUrl: string;
  gitlabProjectId: string;
  defaultBranch: string;
  buildCommands: string[];
  testCommands: string[];
  lintCommands: string[];
  harness: "codex";
  limits: {
    maxAgentTurns: number;
    maxChangedFiles: number;
    maxRepairAttempts: number;
    maxExecutionMinutes: number;
  };
}
