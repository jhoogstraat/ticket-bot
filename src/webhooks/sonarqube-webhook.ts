import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { BugFixWorkflow } from "../workflows/bug-fix-workflow.js";

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
  qualityGate: z.enum(["passed", "failed"]),
  findings: z.array(finding).max(20),
});

export function createSonarQubeWebhookService(workflow: BugFixWorkflow) {
  return restate.service({
    name: "SonarQubeWebhook",
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
        await ctx
          .workflowClient(workflow, event.workflowId)
          .onSonarQube({ qualityGate: event.qualityGate, findings });
        return { accepted: true };
      },
    },
  });
}
