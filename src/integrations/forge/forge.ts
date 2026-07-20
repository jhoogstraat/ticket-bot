export interface CreateMergeRequestInput {
  repositoryPath: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface WaitForChecksOutput {
  targetUrl: string | null | undefined;
  success: boolean;
}
