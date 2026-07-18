import { createHash } from "node:crypto";
import type { CiFailureCategory, CompactCiFailure } from "../../domain/ci.js";

export interface JenkinsParseInput {
  buildId: string;
  stage?: string;
  log: string;
  repositoryPathPrefixes?: string[];
}

export interface JenkinsParserLimits {
  maxExcerptBytes: number;
  contextLines: number;
}

const defaults: JenkinsParserLimits = { maxExcerptBytes: 8 * 1024, contextLines: 20 };

const timestamp = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ][^\] ]+\]?|\[?\d{2}:\d{2}:\d{2}(?:\.\d+)?\]?)\s*/;
const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function sanitize(line: string): string {
  return line
    .replace(ansi, "")
    .replace(timestamp, "")
    .replace(/^\s*\[[A-Z]+\]\s*/, "")
    .trimEnd();
}

function classify(log: string): CiFailureCategory {
  const lower = log.toLowerCase();
  if (
    /agent (?:was )?offline|no space left|connection reset|could not resolve host|unauthorized|authentication failed|executor.*lost/.test(
      lower,
    )
  )
    return "infrastructure";

  if (/timed? out|timeout exceeded/.test(lower)) return "timeout";
  if (/quality gate.*fail|sonarqube.*fail/.test(lower)) return "quality_gate";
  if (/eslint|lint (?:error|failed)|checkstyle/.test(lower)) return "lint";
  if (/compilation failed|compiler error|error ts\d+|cannot find symbol/.test(lower))
    return "compilation";

  if (/tests? failed|assertionerror|\bfail(?:ed|ure)\b/.test(lower)) return "test";
  return "unknown";
}

export function failureFingerprint(failure: Omit<CompactCiFailure, "fingerprint">): string {
  const stable = JSON.stringify({
    category: failure.category,
    stage: failure.stage ?? "",
    tests: failure.failedTests.map((test) => [test.name, normalizeMessage(test.message)]).sort(),
    errors: failure.compilerErrors
      .map((error) => [error.file ?? "", error.line ?? 0, normalizeMessage(error.message)])
      .sort(),
    excerpt: normalizeMessage(failure.logExcerpt).slice(0, 1_000),
  });

  return createHash("sha256").update(stable).digest("hex").slice(0, 20);
}

function normalizeMessage(value: string): string {
  return value
    .replace(/0x[\da-f]+/gi, "<address>")
    .replace(/\b\d{4,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseJenkinsFailure(
  input: JenkinsParseInput,
  limits: JenkinsParserLimits = defaults,
): CompactCiFailure {
  const rawLines = input.log.split(/\r?\n/);
  const lines = rawLines
    .map(sanitize)
    .filter((line, index, all) => line.trim() && line !== all[index - 1]);

  const meaningful = lines.findIndex((line) =>
    /error|fail|exception|timeout|offline|unauthorized|cannot find/i.test(line),
  );

  const start = Math.max(0, (meaningful < 0 ? 0 : meaningful) - limits.contextLines);
  const selected = lines.slice(start, start + limits.contextLines * 2 + 1);
  let excerpt = selected.join("\n");
  while (Buffer.byteLength(excerpt) > limits.maxExcerptBytes)
    excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));

  const compilerErrors = dedupe(
    lines.flatMap((line) => {
      const match = line.match(
        /(?<file>[\w./\\-]+\.(?:ts|tsx|js|jsx|java|kt|py|go|cs|cpp|c|h))(?::|\()(?<line>\d+)(?::\d+|,\d+\))?\s*(?:-|:)?\s*(?:error(?:\s+TS\d+)?:?\s*)?(?<message>.+)/i,
      );

      if (!match?.groups || !/error|cannot|expected|undefined|failed/i.test(line)) return [];
      return [
        {
          ...(match.groups.file ? { file: match.groups.file } : {}),
          line: Number(match.groups.line),
          message: (match.groups.message ?? "").trim(),
        },
      ];
    }),
    (error) => `${error.file}:${error.line}:${normalizeMessage(error.message)}`,
  ).slice(0, 20);

  const failedTests = dedupe(
    lines.flatMap((line) => {
      const match = line.match(/(?:FAIL(?:ED)?|Test failed:|✕|×)\s+(.+?)(?:\s+-\s+|:\s+)(.+)/i);
      if (!match?.[1] || !match[2]) return [];
      return [{ name: match[1].trim(), message: match[2].trim(), repositoryFrames: [] }];
    }),
    (test) => `${test.name}:${normalizeMessage(test.message)}`,
  ).slice(0, 20);

  const base: Omit<CompactCiFailure, "fingerprint"> = {
    provider: "jenkins",
    buildId: input.buildId,
    category: classify(lines.join("\n")),
    ...(input.stage ? { stage: input.stage } : {}),
    failedTests,
    compilerErrors,
    logExcerpt: excerpt,
    removedLineCount: Math.max(0, rawLines.length - selected.length),
  };

  return { ...base, fingerprint: failureFingerprint(base) };
}

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
