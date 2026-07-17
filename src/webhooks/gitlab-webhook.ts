import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixWorkflow } from "../workflows/bug-fix-workflow.js";

export const gitLabWebhookSchema = z.object({
  workflowId: z.string(),
  commitSha: z.string().optional(),
  requiredFeedbackResolved: z.boolean(),
  detail: z.string().max(4_000).optional(),
});

export function createGitLabWebhookService(workflow: BugFixWorkflow) {
  return restate.service({
    name: "GitLabWebhook",
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = gitLabWebhookSchema.parse(raw);
        await ctx.workflowClient(workflow, event.workflowId).onGitLabReview({
          requiredFeedbackResolved: event.requiredFeedbackResolved,
          ...(event.commitSha ? { commitSha: event.commitSha } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
        });
        return { accepted: true };
      },
    },
  });
}
