import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixQueueService } from "../services/bug-fix-queue-service.js";
import type { BugFixWorkflow } from "./bug-fix-workflow.js";
import { workflowId } from "./bug-fix-workflow.js";

const inputSchema = z.object({
  filterUrl: z.url(),
  generation: z.number().int().positive().default(1),
});

export function createBugFixQueueWorkflow(
  queueService: BugFixQueueService,
  workflow: BugFixWorkflow,
) {
  return restate.service({
    name: "BugFixQueue",
    handlers: {
      run: async (ctx: restate.Context, raw: unknown) => {
        const input = inputSchema.parse(raw);
        const queue = await ctx.run("capture-fixed-jira-queue", () =>
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
