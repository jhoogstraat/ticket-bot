import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixRestateWorkflow } from "../workflows/bugfix/definition.js";
import { workflowId } from "../workflows/bugfix/definition.js";

const jiraWebhookSchema = z.object({
  webhookEvent: z.string(),
  providerEventId: z.string().min(1),
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
    throw new JiraWebhookValidationError("Only bug tickets are supported");
  if (
    !new Set(["ready for development", "ready for investigation", "open"]).has(
      event.issue.fields.status.name.toLowerCase(),
    )
  )
    throw new JiraWebhookValidationError("Ticket is not ready");
  return event;
}

export function createJiraWebhookIngressService(workflow: BugFixRestateWorkflow) {
  return restate.service({
    name: "JiraWebhook",
    options: {
      asTerminalError: (error) =>
        error instanceof z.ZodError || error instanceof JiraWebhookValidationError
          ? new restate.TerminalError(error.message, { errorCode: 400 })
          : undefined,
    },
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = validateJiraWebhook(raw);
        const id = workflowId(event.issue.key, event.generation);
        ctx
          .workflowSendClient(workflow, id)
          .run({ issueKey: event.issue.key, generation: event.generation });
        return { accepted: true, workflowId: id };
      },
    },
  });
}

class JiraWebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraWebhookValidationError";
  }
}
