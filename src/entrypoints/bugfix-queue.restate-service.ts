import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixQueue } from "../domain/queue.js";
import { repositoryTargetSchema } from "../domain/repository.js";
import type { JiraClient } from "../integrations/jira/jira-client.js";
import type { BugFixWorkflow } from "../workflows/bugfix/workflow.js";
import { workflowId } from "../workflows/bugfix/workflow.js";

const inputSchema = repositoryTargetSchema.extend({
  filterUrl: z.url(),
  generation: z.number().int().positive().default(1),
});

export function createBugFixQueueRestateService(jira: JiraClient, workflow: typeof BugFixWorkflow) {
  return restate.service({
    name: "BugFixQueue",
    options: {
      ingressPrivate: true,
    },
    handlers: {
      run: async (ctx: restate.Context, raw: unknown) => {
        const input = inputSchema.parse(raw);
        const queue = await ctx.run("capture-fixed-jira-queue", () =>
          captureBugFixQueue(jira, input.filterUrl, input.generation),
        );

        for (const entry of queue.entries) {
          ctx.workflowSendClient(workflow, workflowId(entry.issueKey, entry.generation)).run({
            issueKey: entry.issueKey,
            generation: entry.generation,
            forge: input.forge,
            url: input.url,
          });
        }

        return queue;
      },
    },
  });
}

export async function captureBugFixQueue(
  jira: JiraClient,
  filterUrl: string,
  generation = 1,
  now: () => Date = () => new Date(),
): Promise<BugFixQueue> {
  const issueKeys: string[] = [];
  const seen = new Set<string>();
  let nextPageToken: string | undefined;

  do {
    const page = await jira.searchOpenBugs(filterUrl, nextPageToken);
    for (const issue of page.issues) {
      if (!seen.has(issue.key)) {
        seen.add(issue.key);
        issueKeys.push(issue.key);
      }
    }

    nextPageToken = page.isLast ? undefined : page.nextPageToken;
    if (!page.isLast && !nextPageToken)
      throw new Error("Jira pagination did not provide a next-page token");
  } while (nextPageToken);

  return {
    filterUrl,
    capturedAt: now().toISOString(),
    entries: issueKeys.map((issueKey) => ({ issueKey, generation })),
  };
}
