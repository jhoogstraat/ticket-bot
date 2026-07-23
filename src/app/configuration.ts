import { resolve } from "node:path";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const httpsUrl = (field: string) => {
  const error = `${field} must be a valid HTTPS URL`;

  return z
    .string({ error })
    .trim()
    .pipe(z.url({ protocol: /^https$/, normalize: true, error }));
};

const optionalSecret = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const jiraSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("fake") }),
    z.strictObject({
      mode: z.literal("real"),
      base_url: httpsUrl("jira.base_url"),
    }),
  ])
  .prefault({ mode: "fake" })
  .transform((jira) =>
    jira.mode === "real"
      ? { mode: jira.mode, baseUrl: jira.base_url }
      : { mode: jira.mode },
  );

const ciSettings = {
  check_name: nonEmptyString.default("build"),
  poll_interval_minutes: z.number().positive().default(5),
  max_poll_attempts: z.int().positive().default(72),
};

const ciSchema = z
  .discriminatedUnion("provider", [
    z.strictObject({ provider: z.literal("fake"), ...ciSettings }),
    z.strictObject({
      provider: z.literal("jenkins"),
      base_url: httpsUrl("ci.base_url"),
      ...ciSettings,
    }),
  ])
  .prefault({ provider: "fake" })
  .transform((ci) => {
    const settings = {
      checkName: ci.check_name,
      pollIntervalMinutes: ci.poll_interval_minutes,
      maxPollAttempts: ci.max_poll_attempts,
    };

    return ci.provider === "jenkins"
      ? { provider: ci.provider, baseUrl: ci.base_url, ...settings }
      : { provider: ci.provider, ...settings };
  });

const tomlConfigurationSchema = z.strictObject({
  server: z
    .strictObject({
      port: z.int().min(1).max(65_535).default(9_080),
    })
    .prefault({}),
  restate: z
    .strictObject({
      identity_keys: z
        .array(nonEmptyString)
        .min(1, {
          error: "At least one Restate identity key is required",
        })
        .prefault([]),
    })
    .prefault({})
    .transform(({ identity_keys }) => ({ identityKeys: identity_keys })),
  jira: jiraSchema,
  coding: z
    .strictObject({
      provider: z.enum(["fake", "codex"]).default("fake"),
      timeout_minutes: z.number().positive().default(45),
    })
    .prefault({})
    .transform(({ provider, timeout_minutes }) => ({
      provider,
      timeoutMinutes: timeout_minutes,
    })),
  workspace: z
    .strictObject({
      root: nonEmptyString.default(".bug-bot-workspaces"),
      trusted_repository_url_prefixes: z.array(nonEmptyString).default([]),
    })
    .prefault({})
    .transform(({ root, trusted_repository_url_prefixes }) => ({
      root,
      trustedRepositoryUrlPrefixes: trusted_repository_url_prefixes,
    })),
  ci: ciSchema,
  limits: z
    .strictObject({
      max_changed_files: z.int().positive().default(15),
      max_repair_attempts: z.int().nonnegative().default(3),
    })
    .prefault({})
    .transform(({ max_changed_files, max_repair_attempts }) => ({
      maxChangedFiles: max_changed_files,
      maxRepairAttempts: max_repair_attempts,
    })),
});

const secretEnvironmentSchema = z.strictObject({
  JIRA_TOKEN: optionalSecret,
  JENKINS_USERNAME: optionalSecret,
  JENKINS_API_KEY: optionalSecret,
});

const applicationConfigurationSchema = z
  .strictObject({
    configuration: tomlConfigurationSchema,
    secrets: secretEnvironmentSchema,
  })
  .transform(({ configuration, secrets }, context) => {
    const jiraToken =
      configuration.jira.mode === "real"
        ? requiredSecret(secrets.JIRA_TOKEN, "JIRA_TOKEN", context)
        : undefined;

    const jenkinsUsername =
      configuration.ci.provider === "jenkins"
        ? requiredSecret(
            secrets.JENKINS_USERNAME,
            "JENKINS_USERNAME",
            context,
          )
        : undefined;

    const jenkinsApiKey =
      configuration.ci.provider === "jenkins"
        ? requiredSecret(
            secrets.JENKINS_API_KEY,
            "JENKINS_API_KEY",
            context,
          )
        : undefined;

    const jira =
      configuration.jira.mode === "real" && jiraToken !== undefined
        ? { ...configuration.jira, token: jiraToken }
        : configuration.jira.mode === "fake"
          ? configuration.jira
          : undefined;

    const ci =
      configuration.ci.provider === "jenkins" &&
      jenkinsUsername !== undefined &&
      jenkinsApiKey !== undefined
        ? {
            ...configuration.ci,
            username: jenkinsUsername,
            apiKey: jenkinsApiKey,
          }
        : configuration.ci.provider === "fake"
          ? configuration.ci
          : undefined;

    if (!jira || !ci) return z.NEVER;

    return {
      server: configuration.server,
      restate: configuration.restate,
      jira,
      coding: configuration.coding,
      workspace: configuration.workspace,
      ci,
      limits: configuration.limits,
    };
  });

export type ApplicationConfiguration = z.infer<
  typeof applicationConfigurationSchema
>;

export type ConfigurationEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface LoadConfigurationOptions {
  cwd?: string;
  environment?: ConfigurationEnvironment;
}

export function parseConfiguration(
  source: unknown,
  environment: ConfigurationEnvironment = process.env,
): ApplicationConfiguration {
  return applicationConfigurationSchema.parse({
    configuration: source,
    secrets: {
      JIRA_TOKEN: environment.JIRA_TOKEN,
      JENKINS_USERNAME: environment.JENKINS_USERNAME,
      JENKINS_API_KEY: environment.JENKINS_API_KEY,
    },
  });
}

export async function loadConfiguration(
  options: LoadConfigurationOptions = {},
): Promise<ApplicationConfiguration> {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const configuredPath = environment.BUG_BOT_CONFIG?.trim() || "bug-bot.toml";
  const path = resolve(cwd, configuredPath);

  let contents: string;
  try {
    contents = await Bun.file(path).text();
  } catch (error) {
    throw new Error(
      `Failed to read configuration ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let source: unknown;
  try {
    source = Bun.TOML.parse(contents);
  } catch (error) {
    throw new Error(
      `Failed to parse configuration ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    return parseConfiguration(source, environment);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid configuration ${path}:\n${z.prettifyError(error)}`,
        { cause: error },
      );
    }

    throw new Error(
      `Invalid configuration ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function requiredSecret(
  value: string | undefined,
  name: string,
  context: z.RefinementCtx,
): string | undefined {
  if (value !== undefined) return value;

  context.addIssue({
    code: "custom",
    path: ["secrets", name],
    message: `${name} is required`,
  });

  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
