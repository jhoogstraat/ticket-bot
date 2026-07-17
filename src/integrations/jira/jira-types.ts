export interface JiraIssueDto {
  key: string;
  changelog?: {
    histories: Array<{
      created?: string;
      author?: { displayName?: string };
      items: Array<{ field: string; fromString?: string; toString?: string }>;
    }>;
  };
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string };
    issuetype?: { name: string };
    priority?: { name: string };
    components?: Array<{ name: string }>;
    environment?: unknown;
    labels?: string[];
    comment?: { comments: JiraCommentDto[] };
    issuelinks?: JiraIssueLinkDto[];
    attachment?: JiraAttachmentDto[];
    versions?: Array<{ name: string }>;
    [field: string]: unknown;
  };
}

export interface JiraCommentDto {
  author?: { displayName?: string };
  created?: string;
  body: unknown;
}
export interface JiraIssueLinkDto {
  type: { inward: string; outward: string };
  inwardIssue?: { key: string; fields: { summary: string } };
  outwardIssue?: { key: string; fields: { summary: string } };
}
export interface JiraAttachmentDto {
  id: string;
  filename: string;
  mimeType?: string;
}
