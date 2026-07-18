import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  jira,
  forges,
  codingHarness,
  workspaces,
  limits,
  trustedRepositoryUrlPrefixes,
} from "./dependencies.js";
import {
  assertTrustedRepository,
  repositoryTargetSchema,
  type RepositoryTarget,
} from "../../domain/repository.js";
import { normalizeJiraIssue } from "../../integrations/jira/jira-normalizer.js";
import { AnalysisTask } from "./tasks/analysis.js";
import { CodingTask } from "./tasks/coding.js";
import { PublicationTask } from "./tasks/publication.js";

const workflowInputSchema = repositoryTargetSchema.extend({
  issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  generation: z.number().int().positive(),
});

export type BugFixWorkflowInput = z.infer<typeof workflowInputSchema>;

export const workflowId = (issueKey: string, generation: number): string =>
  `bugfix/${issueKey}/${generation}`;

export interface BugFixWorkflowResult {
  runId: string;
  state: "DONE" | "HUMAN_REQUIRED";
  detail: string;
}

export const BugFixWorkflow = restate.workflow({
  name: "BugFixWorkflow",
  options: {
    inactivityTimeout: 60_000,
  },
  handlers: {
    run: async (ctx: restate.WorkflowContext, raw: unknown) => {
      const input = validateWorkflowInput(raw, trustedRepositoryUrlPrefixes);
      const repository: RepositoryTarget = { forge: input.forge, url: input.url };
      const analysisTask = new AnalysisTask(codingHarness, workspaces, limits);
      const codingTask = new CodingTask(codingHarness, workspaces, limits);
      const publicationTask = new PublicationTask(forges, jira);

      const runId = workflowId(input.issueKey, input.generation);

      const ticketDto = await ctx.run(
        "fetch-ticket",
        async () => await jira.getIssue(input.issueKey),
      );

      const ticket = await ctx.run("normalize-ticket", () => normalizeJiraIssue(ticketDto));

      const investigationWorkspace = await ctx.run(
        "create-workspace",
        () => workspaces.create(runId, ticket.key, ticket.summary, repository),
        { maxRetryAttempts: 3 },
      );

      const investigation = await ctx.run(
        "investigate-ticket",
        () => analysisTask.investigateTicket(ticket, repository, investigationWorkspace),
        { maxRetryAttempts: 2 },
      );

      if (!investigation.gate.actionable) {
        return {
          runId,
          state: "HUMAN_REQUIRED",
          detail: investigation.gate.reason,
        } satisfies BugFixWorkflowResult;
      }

      await ctx.run("claim-jira-ticket", () => jira.claimIssue(ticket.key), {
        maxRetryAttempts: 3,
      });

      const workspace = await ctx.run(
        "activate-focused-branch",
        () => workspaces.activateBranch(investigationWorkspace),
        { maxRetryAttempts: 2 },
      );

      const harnessResult = await ctx.run(
        "start-codex",
        () => codingTask.implementTicket(ticket, workspace, investigation.analysis),
        { maxRetryAttempts: 2 },
      );

      await ctx.run(
        "validate-and-commit",
        () => codingTask.commitImplementation(workspace, ticket, harnessResult),
        { maxRetryAttempts: 1 },
      );

      let reviewAttempt = 0;
      for (;;) {
        const review = await ctx.run(
          `independent-review-${reviewAttempt}`,
          () => codingTask.reviewPatch(workspace, ticket, investigation.analysis, []),
          { maxRetryAttempts: 2 },
        );

        if (review.verdict === "accept") break;

        if (review.verdict === "re-investigate") {
          return {
            runId,
            state: "HUMAN_REQUIRED",
            detail: `Review invalidated the analysis: ${review.summary}`,
          } satisfies BugFixWorkflowResult;
        }

        await ctx.run(
          `address-review-${reviewAttempt + 1}`,
          () =>
            codingTask.revisePatch(
              workspace,
              harnessResult.sessionId,
              reviewAttempt,
              ticket,
              review,
            ),
          { maxRetryAttempts: 1 },
        );

        reviewAttempt++;
      }

      await ctx.run("push-branch", () => workspaces.pushBranch(workspace), {
        maxRetryAttempts: 3,
      });

      const mergeRequest = await ctx.run(
        "create-draft-merge-request",
        () =>
          publicationTask.createMergeRequest(
            runId,
            ticket,
            repository,
            workspace.branchName,
            workspace.defaultBranch,
            harnessResult,
          ),
        { maxRetryAttempts: 3 },
      );

      await ctx.run(
        "jira-link-merge-request",
        () => publicationTask.linkMergeRequestInJira(ticket.key, mergeRequest.url),
        { maxRetryAttempts: 3 },
      );

      await ctx.run("jira-ready-to-merge", () => publicationTask.markJiraReadyToMerge(ticket.key), {
        maxRetryAttempts: 3,
      });

      return {
        runId,
        state: "DONE",
        detail: "Ready to merge; merge remains a human action",
      } satisfies BugFixWorkflowResult;
    },
  },
});

export function validateWorkflowInput(
  raw: unknown,
  trustedUrlPrefixes: readonly string[],
): BugFixWorkflowInput {
  try {
    const input = workflowInputSchema.parse(raw);
    assertTrustedRepository(input, trustedUrlPrefixes);
    return input;
  } catch (error) {
    throw new restate.TerminalError(error instanceof Error ? error.message : String(error), {
      errorCode: 400,
    });
  }
}
