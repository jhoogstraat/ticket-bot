export type DomainErrorCode =
  | "UNSUPPORTED_TICKET"
  | "MISSING_REPOSITORY_MAPPING"
  | "WORKSPACE_FAILURE"
  | "HARNESS_TIMEOUT"
  | "HARNESS_BLOCKED"
  | "NO_CODE_CHANGES"
  | "VALIDATION_FAILURE"
  | "PUSH_FAILURE"
  | "MR_CREATION_FAILURE"
  | "DUPLICATE_WORKFLOW"
  | "INVALID_WEBHOOK"
  | "CI_INFRASTRUCTURE_FAILURE"
  | "REPAIR_LIMIT_REACHED"
  | "REPEATED_FAILURE"
  | "HUMAN_INPUT_REQUIRED";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
