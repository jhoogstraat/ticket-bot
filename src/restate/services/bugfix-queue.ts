import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixQueueCapture } from "../../application/bugfix-queue-capture.js";
import type { BugFixRestateWorkflow } from "../workflows/bugfix/definition.js";
import { workflowId } from "../workflows/bugfix/definition.js";
import { runApplicationStep } from "../application-step.js";

const inputSchema = z.object({
  filterUrl: z.url(),
  generation: z.number().int().positive().default(1),
});

export function createBugFixQueueRestateService(
  queueService: BugFixQueueCapture,
  workflow: BugFixRestateWorkflow,
) {
  return restate.service({
    name: "BugFixQueue",
    options: { ingressPrivate: true },
    handlers: {
      run: async (ctx: restate.Context, raw: unknown) => {
        const input = inputSchema.parse(raw);
        const queue = await runApplicationStep(ctx, "capture-fixed-jira-queue", () =>
          queueService.capture(input.filterUrl, input.generation),
        );
        for (const entry of queue.entries) {
          ctx.workflowSendClient(workflow, workflowId(entry.issueKey, entry.generation)).run(entry);
        }
        return queue;
      },
    },
  });
}
