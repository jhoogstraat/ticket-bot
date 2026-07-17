export interface BugFixQueueEntry {
  issueKey: string;
  generation: number;
}

export interface BugFixQueue {
  filterUrl: string;
  capturedAt: string;
  entries: BugFixQueueEntry[];
}
