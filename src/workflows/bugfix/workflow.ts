import * as restate from "@restatedev/restate-sdk";
import { dependencies } from "./dependencies.js";
import {
  done,
  humanRequired,
  implementationState,
  initialState,
  published,
  reviewReady,
  workflowResult,
} from "./workflow-state.js";
import { normalizeJiraIssue } from "../../integrations/jira/jira-normalizer.js";
import {
  commitImplementation,
  implementTicket,
  investigateTicket,
  reviewPatch,
  revisePatch,
} from "./tasks/coding.js";
import {
  createMergeRequest,
  linkMergeRequestInJira,
  markJiraReadyToMerge,
  pushReviewedBranch,
} from "./tasks/publication.js";

export const BugFixWorkflow = restate.workflow({
  name: "BugFixWorkflow",
  options: {
    inactivityTimeout: 60_000,
  },
  handlers: {
    run: async (ctx: restate.WorkflowContext, issueKey: string) => {
      const runId = workflowId(issueKey);

      const ticket = await ctx.run("load-normalized-ticket", async () =>
        normalizeJiraIssue(await dependencies.jira.getIssue(issueKey)),
      );

      const repository = dependencies.resolveRepository(ticket);

      const investigationWorkspace = await ctx.run(
        "create-workspace",
        () =>
          dependencies.workspaces.create({
            workflowId: runId,
            issueKey: ticket.key,
            shortSlug: ticket.summary,
            repository,
          }),
        { maxRetryAttempts: 3 },
      );

      const investigation = await ctx.run(
        "investigate-ticket",
        () => investigateTicket(ticket, repository, investigationWorkspace),
        { maxRetryAttempts: 2 },
      );

      if (!investigation.gate.actionable) {
        const blockedState = humanRequired(
          initialState(
            runId,
            1,
            ticket,
            repository,
            investigationWorkspace,
            investigation.analysis,
          ),
          investigation.gate.reason,
        );

        return workflowResult(runId, blockedState);
      }

      await ctx.run("claim-jira-ticket", () => dependencies.jira.claimIssue(ticket.key), {
        maxRetryAttempts: 3,
      });

      const workspace = await ctx.run(
        "activate-focused-branch",
        () => dependencies.workspaces.activateBranch(investigationWorkspace),
        { maxRetryAttempts: 2 },
      );

      const harnessResult = await ctx.run(
        "start-codex",
        () => implementTicket(ticket, repository, workspace, investigation.analysis),
        { maxRetryAttempts: 2 },
      );

      const commitSha = await ctx.run(
        "validate-and-commit",
        () => commitImplementation(workspace, ticket, repository, harnessResult),
        { maxRetryAttempts: 1 },
      );

      let reviewState = implementationState(
        runId,
        1,
        ticket,
        repository,
        workspace,
        investigation.analysis,
        harnessResult,
        commitSha,
      );

      for (;;) {
        const review = await ctx.run(
          `independent-review-${reviewState.reviewAttempt}`,
          () => reviewPatch(reviewState, ticket, []),
          { maxRetryAttempts: 2 },
        );

        if (review.verdict === "accept") {
          reviewState = reviewReady(review.state, review.summary);
          break;
        }

        if (review.verdict === "re-investigate") {
          reviewState = humanRequired(
            review.state,
            `Review invalidated the analysis: ${review.summary}`,
          );

          return workflowResult(runId, reviewState);
        }

        reviewState = await ctx.run(
          `address-review-${reviewState.reviewAttempt + 1}`,
          () => revisePatch(review.state, ticket, repository, review),
          { maxRetryAttempts: 1 },
        );
      }

      await ctx.run("push-branch", () => pushReviewedBranch(reviewState), {
        maxRetryAttempts: 3,
      });

      const mergeRequest = await ctx.run(
        "create-draft-merge-request",
        () => createMergeRequest(runId, ticket, repository, reviewState, harnessResult),
        { maxRetryAttempts: 3 },
      );

      const readyState = reviewReady(
        published(reviewState, mergeRequest),
        "Draft merge request created; merge remains a human action",
      );

      await ctx.run("jira-link-merge-request", () => linkMergeRequestInJira(readyState), {
        maxRetryAttempts: 3,
      });

      await ctx.run("jira-ready-to-merge", () => markJiraReadyToMerge(readyState), {
        maxRetryAttempts: 3,
      });

      return workflowResult(
        runId,
        done(readyState, "Ready to merge; merge remains a human action"),
      );
    },
  },
});

export const workflowId = (issueKey: string): string => `bugfix/${issueKey}`;
