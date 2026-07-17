import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixWorkflow } from "../workflows/bug-fix-workflow.js";

const jiraWebhookSchema = z.object({
  webhookEvent: z.string(),
  generation: z.number().int().positive().default(1),
  issue: z.object({
    key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
    fields: z.object({
      issuetype: z.object({ name: z.string() }),
      status: z.object({ name: z.string() }),
    }),
  }),
});

export function validateJiraWebhook(value: unknown): z.infer<typeof jiraWebhookSchema> {
  const event = jiraWebhookSchema.parse(value);
  if (event.issue.fields.issuetype.name.toLowerCase() !== "bug")
    throw new Error("Only bug tickets are supported");
  if (
    !new Set(["ready for development", "ready for investigation", "open"]).has(
      event.issue.fields.status.name.toLowerCase(),
    )
  )
    throw new Error("Ticket is not ready");
  return event;
}

export function createJiraWebhookService(workflow: BugFixWorkflow) {
  return restate.service({
    name: "JiraWebhook",
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = validateJiraWebhook(raw);
        const workflowId = `bug-fix/${event.issue.key}/${event.generation}`;
        ctx
          .workflowSendClient(workflow, workflowId)
          .run({ issueKey: event.issue.key, generation: event.generation });
        return { accepted: true, workflowId };
      },
    },
  });
}
