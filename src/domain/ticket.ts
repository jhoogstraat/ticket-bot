export type AttachmentClassification = "log" | "screenshot" | "document" | "unknown";

export interface NormalizedBugTicket {
  key: string;
  summary: string;
  description?: string;
  acceptanceCriteria?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  reproductionSteps: string[];
  status: string;
  priority?: string;
  component?: string;
  environment?: string;
  affectedVersions: string[];
  statusHistory: Array<{ from?: string; to: string; changedAt?: string; author?: string }>;
  labels: string[];
  relevantComments: Array<{ author?: string; createdAt?: string; body: string }>;
  linkedIssues: Array<{ key: string; relationship: string; summary: string }>;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType?: string;
    classification: AttachmentClassification;
  }>;
  repositoryHint?: string;
}

export interface JiraWebhookEvent {
  webhookEvent: string;
  issue: { key: string; fields: { issuetype: { name: string }; status: { name: string } } };
}
