import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfiguration, parseConfiguration } from "../src/app/configuration.js";
import { CodexHarness } from "../src/coding/codex-coding-harness.js";
import { FakeCodingHarness } from "../src/coding/fake-coding-harness.js";
import { JenkinsClient } from "../src/integrations/jenkins/jenkins-client.js";
import { FakeJiraClient, HttpJiraClient } from "../src/integrations/jira/jira-client.js";
import { createProductionDependencies } from "../src/workflow/dependencies.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("configuration", () => {
  test("provides documented defaults in the nested application shape", () => {
    expect(parseConfiguration({}, {})).toEqual({
      server: { port: 9080 },
      restate: { identityKeys: [] },
      jira: { mode: "fake" },
      coding: { provider: "fake", timeoutMinutes: 45 },
      workspace: { root: ".bug-bot-workspaces", trustedRepositoryUrlPrefixes: [] },
      ci: {
        provider: "fake",
        checkName: "build",
        pollIntervalMinutes: 5,
        maxPollAttempts: 72,
      },
      limits: { maxChangedFiles: 15, maxRepairAttempts: 3 },
    });
  });

  test("maps complete TOML names to camel-cased component configuration", () => {
    const configuration = parseConfiguration(
      Bun.TOML.parse(`
        [server]
        port = 9090
        [restate]
        identity_keys = ["publickeyv1_first", "publickeyv1_second"]
        [jira]
        mode = "fake"
        [coding]
        provider = "codex"
        timeout_minutes = 12.5
        [workspace]
        root = "var/workspaces"
        trusted_repository_url_prefixes = ["https://github.com/acme/", "ssh://git/acme/"]
        [ci]
        provider = "fake"
        check_name = "verify"
        poll_interval_minutes = 2.5
        max_poll_attempts = 10
        [limits]
        max_changed_files = 7
        max_repair_attempts = 0
      `),
      {},
    );

    expect(configuration).toEqual({
      server: { port: 9090 },
      restate: { identityKeys: ["publickeyv1_first", "publickeyv1_second"] },
      jira: { mode: "fake" },
      coding: { provider: "codex", timeoutMinutes: 12.5 },
      workspace: {
        root: "var/workspaces",
        trustedRepositoryUrlPrefixes: ["https://github.com/acme/", "ssh://git/acme/"],
      },
      ci: {
        provider: "fake",
        checkName: "verify",
        pollIntervalMinutes: 2.5,
        maxPollAttempts: 10,
      },
      limits: { maxChangedFiles: 7, maxRepairAttempts: 0 },
    });
  });

  test("combines real Jira settings with its secret", () => {
    expect(
      parseConfiguration(
        { jira: { mode: "real", base_url: "https://example.atlassian.net" } },
        { JIRA_TOKEN: "jira-secret" },
      ).jira,
    ).toEqual({
      mode: "real",
      baseUrl: "https://example.atlassian.net",
      token: "jira-secret",
    });
  });

  test("requires the real Jira URL and non-empty token", () => {
    expect(() => parseConfiguration({ jira: { mode: "real" } }, {})).toThrow("jira.base_url");
    expect(() =>
      parseConfiguration(
        { jira: { mode: "real", base_url: "https://example.atlassian.net" } },
        { JIRA_TOKEN: "  " },
      ),
    ).toThrow("JIRA_TOKEN");
  });

  test("combines Jenkins settings with credentials", () => {
    expect(
      parseConfiguration(
        { ci: { provider: "jenkins", base_url: "https://jenkins.example.com" } },
        { JENKINS_USERNAME: "robot", JENKINS_API_KEY: "jenkins-secret" },
      ).ci,
    ).toEqual({
      provider: "jenkins",
      baseUrl: "https://jenkins.example.com",
      username: "robot",
      apiKey: "jenkins-secret",
      checkName: "build",
      pollIntervalMinutes: 5,
      maxPollAttempts: 72,
    });
  });

  test("requires every Jenkins setting and credential", () => {
    const source = { ci: { provider: "jenkins", base_url: "https://jenkins.example.com" } };
    expect(() => parseConfiguration({ ci: { provider: "jenkins" } }, {})).toThrow("ci.base_url");
    expect(() => parseConfiguration(source, { JENKINS_API_KEY: "key" })).toThrow(
      "JENKINS_USERNAME",
    );

    expect(() => parseConfiguration(source, { JENKINS_USERNAME: "robot" })).toThrow(
      "JENKINS_API_KEY",
    );
  });

  test("ignores empty integration secrets in fake modes", () => {
    expect(
      parseConfiguration(
        {},
        {
          JIRA_TOKEN: "",
          JENKINS_USERNAME: " ",
          JENKINS_API_KEY: "",
        },
      ),
    ).toMatchObject({ jira: { mode: "fake" }, ci: { provider: "fake" } });
  });

  test("rejects invalid URLs with nested field paths", () => {
    expect(() =>
      parseConfiguration(
        { jira: { mode: "real", base_url: "not-a-url" } },
        { JIRA_TOKEN: "secret" },
      ),
    ).toThrow("base_url");

    expect(() =>
      parseConfiguration(
        { ci: { provider: "jenkins", base_url: "not-a-url" } },
        { JENKINS_USERNAME: "robot", JENKINS_API_KEY: "secret" },
      ),
    ).toThrow("base_url");

    expect(() =>
      parseConfiguration(
        { jira: { mode: "real", base_url: "http://example.atlassian.net" } },
        { JIRA_TOKEN: "secret" },
      ),
    ).toThrow("HTTPS");

    expect(() =>
      parseConfiguration(
        { ci: { provider: "jenkins", base_url: "http://jenkins.example.com" } },
        { JENKINS_USERNAME: "robot", JENKINS_API_KEY: "secret" },
      ),
    ).toThrow("HTTPS");
  });

  test("enforces numeric bounds while allowing a zero repair budget", () => {
    const invalidSources = [
      { server: { port: 0 } },
      { coding: { timeout_minutes: 0 } },
      { ci: { poll_interval_minutes: 0 } },
      { ci: { max_poll_attempts: 0 } },
      { limits: { max_changed_files: 0 } },
      { limits: { max_repair_attempts: -1 } },
    ];

    for (const source of invalidSources) expect(() => parseConfiguration(source, {})).toThrow();
    expect(parseConfiguration({ limits: { max_repair_attempts: 0 } }, {}).limits).toEqual({
      maxChangedFiles: 15,
      maxRepairAttempts: 0,
    });
  });

  test("rejects unknown fields and preserves TOML arrays", () => {
    expect(() => parseConfiguration({ server: { prot: 9080 } }, {})).toThrow("prot");
    const prefixes = parseConfiguration(
      { workspace: { trusted_repository_url_prefixes: ["one", "two"] } },
      {},
    ).workspace.trustedRepositoryUrlPrefixes;

    expect(prefixes).toEqual(["one", "two"]);
  });

  test("reports invalid TOML and missing files with their resolved paths", async () => {
    const directory = await temporaryDirectory();
    const invalidPath = join(directory, "invalid.toml");
    await writeFile(invalidPath, "[server\nport = 9080");

    expect(
      loadConfiguration({ cwd: directory, environment: { BUG_BOT_CONFIG: "invalid.toml" } }),
    ).rejects.toThrow(invalidPath);

    expect(loadConfiguration({ cwd: directory, environment: {} })).rejects.toThrow(
      join(directory, "bug-bot.toml"),
    );
  });

  test("loads the BUG_BOT_CONFIG path relative to the working directory", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "alternate.toml"), "[server]\nport = 9191\n");

    const configuration = await loadConfiguration({
      cwd: directory,
      environment: { BUG_BOT_CONFIG: "alternate.toml" },
    });

    expect(configuration.server.port).toBe(9191);
  });

  test("does not expose secrets in validation errors", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "secret.toml");
    await writeFile(path, "[server]\nunknown = true\n");
    const secret = "must-not-appear-in-errors";

    try {
      await loadConfiguration({
        cwd: directory,
        environment: { BUG_BOT_CONFIG: path, JIRA_TOKEN: secret },
      });

      throw new Error("Expected configuration loading to fail");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain(path);
      expect(String(error)).toContain("unknown");
    }
  });

  test("selects production adapters from validated discriminants", () => {
    const fakeDependencies = createProductionDependencies(parseConfiguration({}, {}));
    expect(fakeDependencies.jira).toBeInstanceOf(FakeJiraClient);
    expect(fakeDependencies.codingHarness).toBeInstanceOf(FakeCodingHarness);
    expect(fakeDependencies.ciFeedbackReader).not.toBeInstanceOf(JenkinsClient);

    const realConfiguration = parseConfiguration(
      {
        jira: { mode: "real", base_url: "https://example.atlassian.net" },
        coding: { provider: "codex" },
        ci: { provider: "jenkins", base_url: "https://jenkins.example.com" },
      },
      {
        JIRA_TOKEN: "jira-secret",
        JENKINS_USERNAME: "robot",
        JENKINS_API_KEY: "jenkins-secret",
      },
    );

    const realDependencies = createProductionDependencies(realConfiguration);
    expect(realDependencies.jira).toBeInstanceOf(HttpJiraClient);
    expect(realDependencies.codingHarness).toBeInstanceOf(CodexHarness);
    expect(realDependencies.ciFeedbackReader).toBeInstanceOf(JenkinsClient);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bug-bot-configuration-"));
  temporaryDirectories.push(directory);
  return directory;
}
