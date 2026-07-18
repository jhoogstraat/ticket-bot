import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(9080),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  ADAPTER_MODE: z.enum(["fake", "real"]).default("fake"),
  HARNESS_MODE: z.enum(["fake", "codex"]).default("fake"),
  WORKSPACE_ROOT: z.string().default(".bug-bot-workspaces"),
  CODEX_TIMEOUT_MINUTES: z.coerce.number().positive().default(45),
  RESTATE_INGRESS_URL: z.url().default("http://localhost:8080"),
  RESTATE_IDENTITY_KEYS: z
    .string()
    .optional()
    .transform((value) => {
      const keys = value
        ?.split(",")
        .map((key) => key.trim())
        .filter(Boolean);

      return keys?.length ? keys : undefined;
    }),
  WEBHOOK_SIGNING_SECRET: z.string().min(32).optional(),
  CALLBACK_TIMEOUT_MINUTES: z.coerce.number().positive().default(90),
  JIRA_BASE_URL: z.url().optional(),
  JIRA_TOKEN: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  TRUSTED_REPOSITORY_URL_PREFIXES: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((prefix) => prefix.trim())
        .filter(Boolean),
    ),
  MAX_AGENT_TURNS: z.coerce.number().int().positive().default(30),
  MAX_CHANGED_FILES: z.coerce.number().int().positive().default(15),
  MAX_REPAIR_ATTEMPTS: z.coerce.number().int().nonnegative().default(3),
  MAX_EXECUTION_MINUTES: z.coerce.number().positive().default(45),
});

export type Environment = z.infer<typeof schema>;
export const loadEnvironment = (
  source: Record<string, string | undefined> = process.env,
): Environment => {
  const environment = schema.parse(source);
  if (environment.ADAPTER_MODE === "real" && !environment.WEBHOOK_SIGNING_SECRET)
    throw new Error("WEBHOOK_SIGNING_SECRET is required in real adapter mode");

  return environment;
};
