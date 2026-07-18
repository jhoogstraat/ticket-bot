import * as restate from "@restatedev/restate-sdk";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";

const domainCodeMetadataKey = "ticket-bot.domain-code";

/**
 * Journal an application operation while preserving the difference between a
 * permanent business outcome and a transient infrastructure failure.
 */
export function runApplicationStep<T>(
  ctx: restate.Context,
  name: string,
  action: () => Promise<T>,
  options?: restate.RunOptions<T>,
): restate.RestatePromise<T> {
  return options
    ? ctx.run(name, () => terminalizeDomainError(action), options)
    : ctx.run(name, () => terminalizeDomainError(action));
}

export function domainErrorCode(error: unknown): DomainErrorCode | undefined {
  if (error instanceof DomainError) return error.code;
  if (error instanceof restate.TerminalError) {
    const code = error.metadata?.[domainCodeMetadataKey];
    return code as DomainErrorCode | undefined;
  }
  return undefined;
}

async function terminalizeDomainError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DomainError)
      throw new restate.TerminalError(error.message, {
        errorCode: 422,
        metadata: { [domainCodeMetadataKey]: error.code },
      });
    throw error;
  }
}
