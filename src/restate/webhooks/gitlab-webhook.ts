import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixRestateWorkflow } from "../workflows/bugfix/definition.js";

export const gitLabWebhookSchema = z.object({
  workflowId: z.string(),
  providerEventId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  commitSha: z.string().min(1),
  requiredFeedbackResolved: z.boolean(),
  detail: z.string().max(4_000).optional(),
});

export function createGitLabWebhookIngressService(workflow: BugFixRestateWorkflow) {
  return restate.service({
    name: "GitLabWebhook",
    options: {
      asTerminalError: (error) =>
        error instanceof z.ZodError
          ? new restate.TerminalError(error.message, { errorCode: 400 })
          : undefined,
    },
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = gitLabWebhookSchema.parse(raw);
        await ctx.workflowClient(workflow, event.workflowId).onGitLabReview({
          requiredFeedbackResolved: event.requiredFeedbackResolved,
          correlation: {
            attempt: event.attempt,
            commitSha: event.commitSha,
            providerEventId: event.providerEventId,
          },
          ...(event.detail ? { detail: event.detail } : {}),
        });
        return { accepted: true };
      },
    },
  });
}
