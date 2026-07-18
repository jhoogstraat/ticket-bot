import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixRestateWorkflow } from "../bugfix.restate-workflow.js";

const finding = z.object({
  rule: z.string(),
  severity: z.string(),
  file: z.string(),
  line: z.number().int().positive().optional(),
  message: z.string().max(1_000),
  remediation: z.string().max(500).optional(),
  isNewCode: z.boolean(),
  qualityGateFailure: z.boolean().optional(),
});

const schema = z.object({
  workflowId: z.string(),
  providerEventId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  commitSha: z.string().min(1),
  qualityGate: z.enum(["passed", "failed"]),
  findings: z.array(finding).max(20),
});

export function createSonarQubeWebhookIngressService(workflow: BugFixRestateWorkflow) {
  return restate.service({
    name: "SonarQubeWebhook",
    options: {
      asTerminalError: (error) =>
        error instanceof z.ZodError
          ? new restate.TerminalError(error.message, { errorCode: 400 })
          : undefined,
    },
    handlers: {
      receive: async (ctx: restate.Context, raw: unknown) => {
        const event = schema.parse(raw);
        const findings = event.findings.map((item) => ({
          rule: item.rule,
          severity: item.severity,
          file: item.file,
          message: item.message,
          isNewCode: item.isNewCode,
          ...(item.line ? { line: item.line } : {}),
          ...(item.remediation ? { remediation: item.remediation } : {}),
          ...(item.qualityGateFailure !== undefined
            ? { qualityGateFailure: item.qualityGateFailure }
            : {}),
        }));

        await ctx.workflowClient(workflow, event.workflowId).onSonarQube({
          correlation: {
            attempt: event.attempt,
            commitSha: event.commitSha,
            providerEventId: event.providerEventId,
          },
          qualityGate: event.qualityGate,
          findings,
        });

        return { accepted: true };
      },
    },
  });
}
