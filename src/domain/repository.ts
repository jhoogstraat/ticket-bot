import { z } from "zod";

export const forgeSchema = z.enum(["github", "gitlab"]);

export const repositoryTargetSchema = z.object({
  forge: forgeSchema,
  url: z.url(),
});

export type Forge = z.infer<typeof forgeSchema>;
export type RepositoryTarget = z.infer<typeof repositoryTargetSchema>;

export function assertTrustedRepository(
  repository: RepositoryTarget,
  trustedUrlPrefixes: readonly string[],
): RepositoryTarget {
  if (!trustedUrlPrefixes.some((prefix) => repository.url.startsWith(prefix))) {
    throw new Error(`Repository URL is not trusted: ${repository.url}`);
  }

  return repository;
}

export function repositoryProjectPath(repository: RepositoryTarget): string {
  const path = new URL(repository.url).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path) throw new Error(`Repository URL has no project path: ${repository.url}`);
  return path;
}
