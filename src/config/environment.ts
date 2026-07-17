import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(9080),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  ADAPTER_MODE: z.enum(["fake", "real"]).default("fake"),
  HARNESS_MODE: z.enum(["fake", "codex"]).default("fake"),
  RUNNER_MODE: z.enum(["local", "docker"]).default("local"),
  WORKSPACE_ROOT: z.string().default(".ticket-bot-workspaces"),
  KEEP_WORKSPACES: z.stringbool().default(true),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_TIMEOUT_MINUTES: z.coerce.number().positive().default(45),
  RESTATE_INGRESS_URL: z.url().default("http://localhost:8080"),
  JIRA_BASE_URL: z.url().optional(),
  JIRA_TOKEN: z.string().optional(),
  GITLAB_BASE_URL: z.url().optional(),
  GITLAB_TOKEN: z.string().optional(),
  ACTIONABLE_REPOSITORY_ID: z.string().default("invoicing-outbound"),
});

export type Environment = z.infer<typeof schema>;
export const loadEnvironment = (
  source: Record<string, string | undefined> = process.env,
): Environment => schema.parse(source);
