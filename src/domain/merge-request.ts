import { z } from "zod";

export const MergeRequest = z.object({
  id: z.string(),
  url: z.url()
})

export type MergeRequest = z.infer<typeof MergeRequest>
