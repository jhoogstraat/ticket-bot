import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { jira, forges, codingHarness, workspaces, limits, allowList } from "./dependencies.js";
import { normalizeJiraIssue } from "../integrations/jira/jira-normalizer.js";
import { applyConfidenceGate } from "./tasks/analysis.js";

const Input = z.object({
  issueKey: z.string().regex(/^[A-Za-z]+-\d+$/),
  forge: z.enum(["github", "gitlab"]),
  url: z.url(),
});

const Output = z.object({
  state: z.enum(["DONE", "HUMAN_REQUIRED"]),
  detail: z.string(),
});

export type BugFixWorkflowInput = z.infer<typeof Input>;
export type BugFixWorkflowResult = z.infer<typeof Output>;

export const BugFixWorkflow = restate.workflow({
  name: "BugFixWorkflow",
  options: {
    inactivityTimeout: 60_000,
  },
  handlers: {
    run: restate.handlers.workflow.workflow(
      {
        input: restate.serde.schema(Input),
        output: restate.serde.schema(Output),
      },
      async (ctx: restate.WorkflowContext, input) => {
        if (!allowList.some((prefix) => input.url.startsWith(prefix))) {
          throw new restate.TerminalError(`Repository URL is not trusted: ${input.url}`);
        }

        const ticketDto = await ctx.run(
          "fetch-ticket",
          async () => await jira.fetchIssue(input.issueKey),
        );

        const ticket = await ctx.run("normalize-ticket", () => normalizeJiraIssue(ticketDto));

        const workspace = await ctx.run(
          "create-workspace",
          () => workspaces.create(input.issueKey, ticket.key, ticket.summary, input.url),
          { maxRetryAttempts: 3 },
        );

        const analysis = await ctx.run(
          "investigate-ticket",
          async () => {
            const result = await codingHarness.analyzeTask({
              ticket,
              workspacePath: workspace.path,
            });

            if (result.issueKey !== ticket.key)
              throw new restate.TerminalError(
                `Analysis returned ${result.issueKey} for ${ticket.key}`,
              );

            return result;
          },
          { maxRetryAttempts: 2 },
        );

        const gate = applyConfidenceGate(analysis);
        if (!gate.actionable) {
          return {
            state: "HUMAN_REQUIRED",
            detail: gate.reason,
          };
        }

        await ctx.run("claim-jira-ticket", () => jira.claimIssue(ticket.key), {
          maxRetryAttempts: 3,
        });

        await ctx.run("activate-focused-branch", () => workspaces.activateBranch(workspace), {
          maxRetryAttempts: 2,
        });

        const harnessResult = await ctx.run(
          "implement-ticket",
          () =>
            codingHarness.startTask({
              ticket,
              approvedAnalysis: analysis,
              workspacePath: workspace.path,
            }),
          { maxRetryAttempts: 2 },
        );

        await ctx.run(
          "validate-and-commit",
          async () => {
            if (harnessResult.status !== "completed")
              throw new restate.TerminalError(harnessResult.summary);

            if (harnessResult.validation.failures.length > 0)
              throw new restate.TerminalError(harnessResult.validation.failures.join("; "));

            const changedFiles = await workspaces.inspectPendingChanges(workspace);
            if (changedFiles.length === 0)
              throw new restate.TerminalError("Harness completed without changing files");

            if (changedFiles.length > limits.maxChangedFiles)
              throw new restate.TerminalError(
                `Patch changed ${changedFiles.length} files; limit is ${limits.maxChangedFiles}`,
              );

            await workspaces.commitChanges(workspace, `fix(${ticket.key}): ${ticket.summary}`);
          },
          { maxRetryAttempts: 1 },
        );

        for (let round = 1; round <= limits.maxRepairAttempts; round++) {
          const review = await ctx.run(
            `independent-review-${round}`,
            async () => {
              const { diff } = await workspaces.inspectChangesSinceBase(workspace);
              return await codingHarness.review({
                ticket,
                analysis,
                workspacePath: workspace.path,
                diff,
              });
            },
            { maxRetryAttempts: 2 },
          );

          if (review.verdict === "accept") break;

          if (review.verdict === "re-investigate") {
            return {
              state: "HUMAN_REQUIRED",
              detail: `Review invalidated the analysis: ${review.summary}`,
            };
          }

          await ctx.run(
            `address-review-${round}`,
            async () => {
              const { diffSummary } = await workspaces.inspectChangesSinceBase(workspace);
              const result = await codingHarness.reviseTask(harnessResult.sessionId, {
                workspacePath: workspace.path,
                ticketSummary: {
                  key: ticket.key,
                  summary: ticket.summary,
                  ...(ticket.expectedBehavior ? { expectedBehavior: ticket.expectedBehavior } : {}),
                  ...(ticket.actualBehavior ? { actualBehavior: ticket.actualBehavior } : {}),
                },
                diffSummary,
                review,
              });

              if (result.status !== "completed") throw new restate.TerminalError(result.summary);

              if (result.validation.failures.length > 0)
                throw new restate.TerminalError(result.validation.failures.join("; "));

              const changedFiles = await workspaces.inspectPendingChanges(workspace);
              if (changedFiles.length === 0)
                throw new restate.TerminalError("Harness completed without changing files");

              if (changedFiles.length > limits.maxChangedFiles)
                throw new restate.TerminalError(
                  `Patch changed ${changedFiles.length} files; limit is ${limits.maxChangedFiles}`,
                );

              await workspaces.commitChanges(
                workspace,
                `fix(${ticket.key}): repair review findings`,
              );
            },
            { maxRetryAttempts: 1 },
          );
        }

        await ctx.run("push-branch", () => workspaces.pushBranch(workspace), {
          maxRetryAttempts: 3,
        });

        await ctx.run(
          "create-draft-merge-request",
          () =>
            forges[input.forge].createMergeRequest({
              repositoryPath: workspace.path,
              sourceBranch: workspace.branchName,
              targetBranch: workspace.defaultBranch,
              title: `${ticket.key}: ${ticket.summary}`,
              description: `## What\n${harnessResult.summary}\n\n## Why\n${analysis.rootCause}\n\n## How\nFocused automated patch for ${ticket.key}.\n\n## Verification\n${harnessResult.validation.commandsRun.join("\n")}\n\n## Scope\nNo unrelated changes.\n\nFixes ${ticket.key}`,
            }),
          { maxRetryAttempts: 3 },
        );

        for (let round = 1; round <= limits.maxRepairAttempts; round++) {
          await ctx.sleep({ minutes: 30 });

          const commit = await workspaces.getHeadCommitSha(workspace);

          const check = await ctx.run(`await-ci-${round}`, async () =>
            await forges[input.forge].waitForChecks(commit, "build", workspace.path),
          );

          if (check.success) break;

          else if (check.targetUrl) {

            // Read ci feedback (jenkins + sonarqube)
            await ctx.run(`fetch-jenkins-${round}`, async () => console.log("TODO"));

            // Ask coding agent to fix found issues
            await ctx.run(`fix-issues-${round}`, async () => console.log("TODO"));

            // commit and push fix
            await ctx.run(`commit-push-fix-${round}`, async () => console.log("TODO"));
          }
        }

        await ctx.run("jira-ready-to-merge", () => jira.transition(ticket.key, "Ready to merge"), {
          maxRetryAttempts: 3,
        });

        return {
          state: "DONE",
          detail: "Ready to merge; merge remains a human action",
        };
      },
    ),
  },
});
