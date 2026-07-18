import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";

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
