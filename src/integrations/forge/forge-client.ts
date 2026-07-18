import type { Forge } from "../../domain/repository.js";
import type { CreateMergeRequestInput, MergeRequest } from "../../domain/merge-request.js";

export interface ForgeClient {
  createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequest>;
}

export type ForgeClients = Record<Forge, ForgeClient>;
