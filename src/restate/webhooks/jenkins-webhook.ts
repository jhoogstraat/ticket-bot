import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { parseJenkinsFailure } from "../../integrations/jenkins/jenkins-failure-parser.js";
import type { BugFixRestateWorkflow } from "../workflows/bugfix/definition.js";

const schema = z.object({
  workflowId: z.string().min(1),
  providerEventId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  buildId: z.string().min(1),
  status: z.enum(["success", "failed"]),
  branch: z.string().optional(),
  commitSha: z.string().min(1),
  stage: z.string().optional(),
  log: z.string().max(2_000_000).default(""),
});
export const validateJenkinsWebhook = (value: unknown) => schema.parse(value);

export function createJenkinsWebhookIngressService(workflow: BugFixRestateWorkflow) {
  return restate.service({
    name: "JenkinsWebhook",
    options: {
      asTerminalError: (error) =>
        error instanceof z.ZodError
          ? new restate.TerminalError(error.message, { errorCode: 400 })
          : undefined,
    },
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = validateJenkinsWebhook(raw);
        const result = {
          provider: "jenkins" as const,
          buildId: event.buildId,
          status: event.status,
          ...(event.branch ? { branch: event.branch } : {}),
          commitSha: event.commitSha,
        };
        await ctx.workflowClient(workflow, event.workflowId).onJenkins({
          correlation: {
            attempt: event.attempt,
            commitSha: event.commitSha,
            providerEventId: event.providerEventId,
          },
          result,
          ...(event.status === "failed"
            ? {
                failure: parseJenkinsFailure({
                  buildId: event.buildId,
                  log: event.log,
                  ...(event.stage ? { stage: event.stage } : {}),
                }),
              }
            : {}),
        });
        return { accepted: true };
      },
    },
  });
}
