import { describe, expect, it } from "bun:test";
import { DomainError } from "../src/domain/errors.js";
import { asTerminalDomainError, domainErrorCode } from "../src/restate/terminal-errors.js";

describe("Restate terminal domain errors", () => {
  it("marks permanent domain decisions as non-retryable and preserves their code", () => {
    const error = new DomainError("HARNESS_BLOCKED", "Harness cannot continue");
    const terminal = asTerminalDomainError(error);

    expect(terminal).toBeDefined();
    expect(terminal?.code).toBe(422);
    expect(domainErrorCode(terminal)).toBe("HARNESS_BLOCKED");
  });

  it("leaves unrelated errors retryable", () => {
    expect(asTerminalDomainError(new Error("temporary failure"))).toBeUndefined();
  });
});
