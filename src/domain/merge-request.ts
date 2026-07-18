export interface MergeRequest {
  projectId: string;
  iid: number;
  url: string;
}

export interface CreateMergeRequestInput {
  idempotencyKey: string;
  projectId: string;
  repositoryUrl: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  draft: boolean;
  assignToCurrentUser: boolean;
  labels: string[];
}
