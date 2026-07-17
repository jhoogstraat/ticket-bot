import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { parseJenkinsFailure } from "../integrations/jenkins/jenkins-failure-parser.js";
import type { BugFixWorkflow } from "../workflows/bug-fix-workflow.js";

const schema = z.object({
  workflowId: z.string().min(1),
  buildId: z.string().min(1),
  status: z.enum(["success", "failed"]),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  stage: z.string().optional(),
  log: z.string().max(2_000_000).default(""),
});
export const validateJenkinsWebhook = (value: unknown) => schema.parse(value);

export function createJenkinsWebhookService(workflow: BugFixWorkflow) {
  return restate.service({
    name: "JenkinsWebhook",
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = validateJenkinsWebhook(raw);
        const result = {
          provider: "jenkins" as const,
          buildId: event.buildId,
          status: event.status,
          ...(event.branch ? { branch: event.branch } : {}),
          ...(event.commitSha ? { commitSha: event.commitSha } : {}),
        };
        await ctx.workflowClient(workflow, event.workflowId).onJenkins({
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
