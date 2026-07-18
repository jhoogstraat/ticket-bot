import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";

const domainCodeMetadataKey = "ticket-bot.domain-code";

/** Maps permanent domain decisions to Restate's native no-retry error contract. */
export function asTerminalDomainError(error: unknown): restate.TerminalError | undefined {
  if (!(error instanceof DomainError)) return undefined;
  return new restate.TerminalError(error.message, {
    errorCode: 422,
    metadata: { [domainCodeMetadataKey]: error.code },
  });
}

export function domainErrorCode(error: unknown): DomainErrorCode | undefined {
  if (error instanceof DomainError) return error.code;
  if (!(error instanceof restate.TerminalError)) return undefined;
  return error.metadata?.[domainCodeMetadataKey] as DomainErrorCode | undefined;
}

/** Input failures are permanent: retrying a malformed webhook never makes it valid. */
export function asTerminalValidationError(error: unknown): restate.TerminalError | undefined {
  if (error instanceof z.ZodError || error instanceof WebhookValidationError)
    return new restate.TerminalError(error.message, { errorCode: 400 });
  return undefined;
}

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}
