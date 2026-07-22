import type { CiFailureReport, CiFeedbackReader } from "../../domain/ci.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONSOLE_BYTES = 1_048_576;
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const TIMESTAMP_PREFIX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\s*/;
const SENSITIVE_LOG_LINE = /authorization|api[ _-]?(?:key|token)/i;
const REDACTED = "[REDACTED]";

type FetchFunction = (input: URL, init?: RequestInit) => Promise<Response>;

export class JenkinsClient implements CiFeedbackReader {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly username: string,
    private readonly apiKey: string,
    private readonly fetchFunction: FetchFunction = fetch,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (hasCredentials(this.baseUrl)) {
      throw new Error("Jenkins base URL must not contain embedded credentials");
    }
  }

  async readFailure(buildUrl: string): Promise<CiFailureReport> {
    const targetUrl = new URL(buildUrl);
    if (hasCredentials(targetUrl)) {
      throw new Error("Jenkins build URL must not contain embedded credentials");
    }

    if (!this.isAllowedBuildUrl(targetUrl))
      throw new Error("Jenkins build URL is outside the configured base URL");

    const response = await this.fetchFunction(consoleUrl(targetUrl), {
      headers: { authorization: `Basic ${btoa(`${this.username}:${this.apiKey}`)}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`Jenkins returned ${response.status}`);

    return {
      buildUrl: targetUrl.toString(),
      logExcerpt: createFailureExcerpt(await readBoundedText(response), [
        this.username,
        this.apiKey,
      ]),
    };
  }

  private isAllowedBuildUrl(targetUrl: URL): boolean {
    if (targetUrl.origin !== this.baseUrl.origin) return false;
    const basePath = this.baseUrl.pathname.endsWith("/")
      ? this.baseUrl.pathname.slice(0, -1)
      : this.baseUrl.pathname;

    return (
      basePath === "" ||
      targetUrl.pathname === basePath ||
      targetUrl.pathname.startsWith(`${basePath}/`)
    );
  }
}

function consoleUrl(buildUrl: URL): URL {
  const directory = new URL(buildUrl);
  if (!directory.pathname.endsWith("/")) directory.pathname += "/";
  directory.search = "";
  directory.hash = "";
  return new URL("consoleText", directory);
}

function hasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

async function readBoundedText(response: Response): Promise<string> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) throw new Error("Jenkins console response had no body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CONSOLE_BYTES) {
        await reader.cancel();
        throw new Error(`Jenkins console response exceeded ${MAX_CONSOLE_BYTES} bytes`);
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function createFailureExcerpt(consoleText: string, secrets: readonly string[]): string {
  return consoleText
    .split(/\r?\n/)
    .map((line) =>
      redactSecrets(line.replace(ANSI_ESCAPE, "").replace(TIMESTAMP_PREFIX, "").trimEnd(), secrets),
    )
    .filter((line) => !SENSITIVE_LOG_LINE.test(line))
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .slice(-200)
    .join("\n")
    .slice(-24_000);
}

function redactSecrets(line: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join(REDACTED), line);
}
