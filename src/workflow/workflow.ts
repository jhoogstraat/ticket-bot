import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { CodingHarness, HarnessRunResult } from "../coding/coding-harness.js";
import { ForgeName, type ForgeClient } from "../integrations/forge/forge.js";
import type {
  LocalGitWorkspaces,
  RepositoryWorkspace,
} from "../integrations/git/local-git-workspaces.js";
import type { CiFeedbackReader } from "../domain/ci.js";
import type { JiraClient } from "../integrations/jira/jira-client.js";
import { normalizeJiraIssue } from "../integrations/jira/jira-normalizer.js";

const Input = z.object({
  issueKey: z.string().regex(/^[A-Za-z]+-\d+$/),
  forge: ForgeName,
  url: z.url(),
});

const Output = z.object({
  state: z.enum(["DONE", "HUMAN_REQUIRED"]),
  detail: z.string(),
});

export type BugFixWorkflowInput = z.infer<typeof Input>;
export type BugFixWorkflowResult = z.infer<typeof Output>;

export interface BugFixWorkflowDependencies {
  jira: JiraClient;
  forges: Record<ForgeName, ForgeClient>;
  codingHarness: CodingHarness;
  ciFeedbackReader: CiFeedbackReader;
  workspaces: LocalGitWorkspaces;
  allowList: string[];
  limits: {
    maxChangedFiles: number;
    maxRepairAttempts: number;
    ciCheckName: string;
    ciPollIntervalMinutes: number;
    maxCiPollAttempts: number;
  };
}

export function createBugFixWorkflow(dependencies: BugFixWorkflowDependencies) {
  return restate.workflow({
    name: "BugFixWorkflow",
    options: { inactivityTimeout: 60_000 },
    handlers: {
      run: restate.handlers.workflow.workflow(
        {
          input: restate.serde.schema(Input),
          output: restate.serde.schema(Output),
        },
        async (ctx: restate.WorkflowContext, input) => {
          if (!dependencies.allowList.some((prefix) => input.url.startsWith(prefix))) {
            throw new restate.TerminalError(`Repository URL is not trusted: ${input.url}`);
          }

          const ticketDto = await ctx.run("fetch-ticket", () =>
            dependencies.jira.fetchIssue(input.issueKey),
          );

          const ticket = normalizeJiraIssue(ticketDto);
          const workflowId = ctx.key;
          const workspace = await ctx.run(
            "create-workspace",
            () => dependencies.workspaces.create(workflowId, ticket.key, ticket.summary, input.url),
            { maxRetryAttempts: 3 },
          );

          const analysis = await ctx.run(
            "investigate-ticket",
            async () => {
              const result = await dependencies.codingHarness.analyzeTask({
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

          const blockers: string[] = [];
          if (analysis.rootCauseConfidence !== "high")
            blockers.push("root-cause confidence is not High");

          if (analysis.proposedFixConfidence !== "high")
            blockers.push("proposed-fix confidence is not High");

          if (analysis.expectedFiles.length === 0 || analysis.observableBehavior.length === 0)
            blockers.push("the proposed change is not focused and verifiable");

          if (
            analysis.repositoryEvidence.length === 0 ||
            analysis.reproductionEvidence.length === 0
          )
            blockers.push("repository or reproduction evidence is missing");

          if (analysis.missingInformation.length > 0)
            blockers.push(`missing information: ${analysis.missingInformation.join("; ")}`);

          if (blockers.length > 0) return { state: "HUMAN_REQUIRED", detail: blockers.join(". ") };

          await ctx.run("claim-jira-ticket", () => dependencies.jira.claimIssue(ticket.key), {
            maxRetryAttempts: 3,
          });

          await ctx.run(
            "activate-focused-branch",
            () => dependencies.workspaces.activateBranch(workspace),
            {
              maxRetryAttempts: 2,
            },
          );

          let harnessResult = await ctx.run(
            "implement-ticket",
            () =>
              dependencies.codingHarness.startTask({
                ticket,
                approvedAnalysis: analysis,
                workspacePath: workspace.path,
              }),
            { maxRetryAttempts: 2 },
          );

          let sessionId = harnessResult.sessionId;
          await commitCompletedPatch(
            ctx,
            "validate-and-commit",
            dependencies,
            workspace,
            harnessResult,
            `fix(${ticket.key}): ${ticket.summary}`,
          );

          let revisionsUsed = 0;
          for (;;) {
            const review = await reviewPatch(
              ctx,
              `independent-review-${revisionsUsed}`,
              dependencies,
              workspace,
              ticket,
              analysis,
            );

            if (review.verdict === "accept") {
              break;
            }

            if (review.verdict === "re-investigate") {
              return {
                state: "HUMAN_REQUIRED",
                detail: `Review invalidated the analysis: ${review.summary}`,
              };
            }

            if (revisionsUsed >= dependencies.limits.maxRepairAttempts)
              return {
                state: "HUMAN_REQUIRED",
                detail: "Review did not accept the patch within the configured repair budget",
              };

            harnessResult = await ctx.run(
              `address-review-${revisionsUsed}`,
              () =>
                dependencies.codingHarness.reviseTask(sessionId, {
                  workspacePath: workspace.path,
                  review,
                }),
              { maxRetryAttempts: 2 },
            );

            sessionId = harnessResult.sessionId;
            await commitCompletedPatch(
              ctx,
              `commit-review-repair-${revisionsUsed}`,
              dependencies,
              workspace,
              harnessResult,
              `fix(${ticket.key}): repair review findings`,
            );

            revisionsUsed += 1;
          }

          await ctx.run("push-branch", () => dependencies.workspaces.pushBranch(workspace), {
            maxRetryAttempts: 3,
          });

          await ctx.run(
            "create-draft-merge-request",
            () =>
              dependencies.forges[input.forge].createMergeRequest({
                repositoryPath: workspace.path,
                sourceBranch: workspace.branchName,
                targetBranch: workspace.defaultBranch,
                title: `${ticket.key}: ${ticket.summary}`,
                description: `## What\n${ticket.summary}\n\n## Why\n${analysis.rootCause}\n\n## How\nFocused automated patch for ${ticket.key}.\n\n## Verification\n${harnessResult.validation.commandsRun.join("\n")}\n\n## Scope\nNo unrelated changes.\n\nFixes ${ticket.key}`,
              }),
            { maxRetryAttempts: 3 },
          );

          let repairAttempt = 0;
          let pollAttempt = 0;
          for (;;) {
            const commitSha = await ctx.run(`read-ci-head-${repairAttempt}-${pollAttempt}`, () =>
              dependencies.workspaces.getHeadCommitSha(workspace),
            );

            const check = await ctx.run(`await-ci-${repairAttempt}-${pollAttempt}`, () =>
              dependencies.forges[input.forge].waitForChecks({
                commitSha,
                checkName: dependencies.limits.ciCheckName,
                repositoryPath: workspace.path,
              }),
            );

            if (check.state === "passed") break;

            if (check.state === "pending") {
              pollAttempt += 1;
              if (pollAttempt >= dependencies.limits.maxCiPollAttempts)
                return {
                  state: "HUMAN_REQUIRED",
                  detail: "CI did not complete within the configured polling limit",
                };

              await ctx.sleep({ minutes: dependencies.limits.ciPollIntervalMinutes });
              continue;
            }

            if (check.state === "canceled")
              return { state: "HUMAN_REQUIRED", detail: "CI was canceled" };

            if (!check.targetUrl)
              return {
                state: "HUMAN_REQUIRED",
                detail: "Failed CI check did not provide Jenkins feedback",
              };

            if (repairAttempt >= dependencies.limits.maxRepairAttempts)
              return { state: "HUMAN_REQUIRED", detail: "CI repair budget is exhausted" };

            const buildUrl = check.targetUrl;
            const failure = await ctx.run(`fetch-jenkins-${repairAttempt}`, () =>
              dependencies.ciFeedbackReader.readFailure(buildUrl),
            );

            harnessResult = await ctx.run(
              `repair-ci-${repairAttempt}`,
              () =>
                dependencies.codingHarness.continueTask(sessionId, {
                  workspacePath: workspace.path,
                  failure,
                }),
              { maxRetryAttempts: 2 },
            );

            sessionId = harnessResult.sessionId;
            await commitCompletedPatch(
              ctx,
              `commit-ci-repair-${repairAttempt}`,
              dependencies,
              workspace,
              harnessResult,
              `fix(${ticket.key}): repair CI failure`,
            );

            const repairReview = await reviewPatch(
              ctx,
              `independent-ci-review-${repairAttempt}`,
              dependencies,
              workspace,
              ticket,
              analysis,
            );

            if (repairReview.verdict !== "accept")
              return {
                state: "HUMAN_REQUIRED",
                detail: `CI repair was not accepted by independent review: ${repairReview.summary}`,
              };

            await ctx.run(
              `push-ci-repair-${repairAttempt}`,
              () => dependencies.workspaces.pushBranch(workspace),
              { maxRetryAttempts: 3 },
            );

            repairAttempt += 1;
            pollAttempt = 0;
          }

          await ctx.run(
            "jira-ready-to-merge",
            () => dependencies.jira.transition(ticket.key, "Ready to merge"),
            { maxRetryAttempts: 3 },
          );

          return { state: "DONE", detail: "Ready to merge; merge remains a human action" };
        },
      ),
    },
  });
}

async function commitCompletedPatch(
  ctx: restate.WorkflowContext,
  label: string,
  dependencies: BugFixWorkflowDependencies,
  workspace: RepositoryWorkspace,
  result: HarnessRunResult,
  message: string,
): Promise<void> {
  await ctx.run(
    label,
    async () => {
      if (result.status !== "completed") throw new restate.TerminalError(result.summary);
      if (result.validation.failures.length > 0)
        throw new restate.TerminalError(result.validation.failures.join("; "));

      const changedFiles = await dependencies.workspaces.inspectPendingChanges(workspace);
      if (changedFiles.length === 0)
        throw new restate.TerminalError("Harness completed without changing files");

      if (changedFiles.length > dependencies.limits.maxChangedFiles)
        throw new restate.TerminalError(
          `Patch changed ${changedFiles.length} files; limit is ${dependencies.limits.maxChangedFiles}`,
        );

      await dependencies.workspaces.commitChanges(workspace, message);
    },
    { maxRetryAttempts: 1 },
  );
}

async function reviewPatch(
  ctx: restate.WorkflowContext,
  label: string,
  dependencies: BugFixWorkflowDependencies,
  workspace: RepositoryWorkspace,
  ticket: Parameters<CodingHarness["startTask"]>[0]["ticket"],
  analysis: Parameters<CodingHarness["startTask"]>[0]["approvedAnalysis"],
) {
  return await ctx.run(
    label,
    async () => {
      const diff = await dependencies.workspaces.inspectChangesSinceBase(workspace);
      return await dependencies.codingHarness.review({
        ticket,
        analysis,
        workspacePath: workspace.path,
        diff,
      });
    },
    { maxRetryAttempts: 2 },
  );
}
