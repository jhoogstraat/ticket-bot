import type { BugFixWorkflowState } from "../domain/workflow.js";
export function publicWorkflowStatus(
  state: BugFixWorkflowState | null,
): BugFixWorkflowState | { state: "RECEIVED"; statusDetail: string } {
  return (
    state ?? { state: "RECEIVED", statusDetail: "Workflow has not initialized durable state yet" }
  );
}
