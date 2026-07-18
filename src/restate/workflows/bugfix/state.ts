import * as restate from "@restatedev/restate-sdk";
import type { BugFixWorkflowState } from "../../../domain/workflow.js";

export interface WorkflowStateStore {
  workflowState?: BugFixWorkflowState;
}

export type BugFixWorkflowContext = restate.WorkflowContext<WorkflowStateStore>;
export type BugFixWorkflowSharedContext = restate.WorkflowSharedContext<WorkflowStateStore>;

export function saveWorkflowState(
  ctx: BugFixWorkflowContext,
  state: BugFixWorkflowState,
): BugFixWorkflowState {
  ctx.set("workflowState", state);
  return state;
}
