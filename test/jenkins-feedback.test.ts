import { describe, expect, test } from "bun:test";
import { JenkinsClient } from "../src/integrations/jenkins/jenkins-client.js";

const CONSOLE_OUTPUT = `Authorization: Basic should-not-leak
API key=should-not-leak
${Array.from(
  { length: 210 },
  (_, index) => `[2026-07-20T15:29:18.370Z] \u001B[31mline ${index}`,
).join("\n")}
Build command used build-bot with api-key`;

describe("JenkinsClient", () => {
  test("uses preemptive Basic auth and the predictable console endpoint", async () => {
    let requestedUrl = "";
    let authorization = "";
    const client = new JenkinsClient(
      "https://jenkins.example.test/jenkins",
      "build-bot",
      "api-key",
      async (url, init) => {
        requestedUrl = url.toString();
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(CONSOLE_OUTPUT);
      },
    );

    const report = await client.readFailure(
      "https://jenkins.example.test/jenkins/job/invoicing/42/",
    );

    expect(requestedUrl).toBe("https://jenkins.example.test/jenkins/job/invoicing/42/consoleText");
    expect(authorization).toBe(`Basic ${btoa("build-bot:api-key")}`);
    expect(report.logExcerpt).not.toContain("should-not-leak");
    expect(report.logExcerpt).not.toContain("build-bot");
    expect(report.logExcerpt).not.toContain("api-key");
    expect(report.logExcerpt).toContain("Build command used [REDACTED] with [REDACTED]");
    expect(report.logExcerpt).not.toContain("line 0\n");
    expect(report.logExcerpt.split("\n")).toHaveLength(200);
  });

  test("rejects build URLs outside the configured Jenkins path", async () => {
    const client = new JenkinsClient(
      "https://jenkins.example.test/jenkins",
      "build-bot",
      "api-key",
      async () => new Response("unused"),
    );

    expect(client.readFailure("https://jenkins.example.test/other/job/42/")).rejects.toThrow(
      "outside the configured base URL",
    );
  });

  test("rejects embedded credentials in Jenkins configuration and build URLs", async () => {
    expect(
      () =>
        new JenkinsClient(
          "https://bot:api-key@jenkins.example.test/jenkins",
          "build-bot",
          "api-key",
        ),
    ).toThrow("base URL must not contain embedded credentials");

    const client = new JenkinsClient(
      "https://jenkins.example.test/jenkins",
      "build-bot",
      "api-key",
      async () => new Response("unused"),
    );

    expect(
      client.readFailure("https://bot:smuggled@jenkins.example.test/jenkins/job/invoicing/42/"),
    ).rejects.toThrow("build URL must not contain embedded credentials");
  });

  test("rejects an oversized Jenkins console response", async () => {
    const client = new JenkinsClient(
      "https://jenkins.example.test/",
      "build-bot",
      "api-key",
      async () => new Response("x".repeat(1_048_577)),
    );

    expect(client.readFailure("https://jenkins.example.test/job/invoicing/42/")).rejects.toThrow(
      "exceeded 1048576 bytes",
    );
  });
});
