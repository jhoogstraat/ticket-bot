import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface EngineeringContextProvider {
  getRelatedTickets(issueKey: string, limit: number): Promise<unknown[]>;
  getCiFailure(buildId: string): Promise<unknown>;
  getQualityFindings(
    projectId: string,
    commitSha: string,
    files: string[],
    limit: number,
  ): Promise<unknown[]>;
  getMergeRequest(projectId: string, iid: number): Promise<unknown>;
}

export function createEngineeringContextServer(provider: EngineeringContextProvider): McpServer {
  const server = new McpServer({ name: "engineering-context", version: "0.1.0" });
  server.registerTool(
    "ticket.get_related",
    {
      description: "Get a bounded list of related normalized tickets",
      inputSchema: { issueKey: z.string(), limit: z.number().int().min(1).max(5).default(5) },
    },
    async ({ issueKey, limit }) => result(await provider.getRelatedTickets(issueKey, limit)),
  );
  server.registerTool(
    "ci.get_failure_details",
    { description: "Get one compact parsed CI failure", inputSchema: { buildId: z.string() } },
    async ({ buildId }) => result(await provider.getCiFailure(buildId)),
  );
  server.registerTool(
    "quality.get_changed_file_findings",
    {
      description: "Get new-code findings for changed files",
      inputSchema: {
        projectId: z.string(),
        commitSha: z.string(),
        files: z.array(z.string()).max(15),
        limit: z.number().int().min(1).max(20).default(20),
      },
    },
    async ({ projectId, commitSha, files, limit }) =>
      result(await provider.getQualityFindings(projectId, commitSha, files, limit)),
  );
  server.registerTool(
    "gitlab.get_merge_request_context",
    {
      description: "Get compact merge request context",
      inputSchema: { projectId: z.string(), iid: z.number().int().positive() },
    },
    async ({ projectId, iid }) => result(await provider.getMergeRequest(projectId, iid)),
  );
  return server;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value).slice(0, 16_000) }] };
}

if (
  process.argv[1]?.endsWith("engineering-context-server.ts") ||
  process.argv[1]?.endsWith("engineering-context-server.js")
) {
  const emptyProvider: EngineeringContextProvider = {
    getRelatedTickets: async () => [],
    getCiFailure: async () => ({ available: false }),
    getQualityFindings: async () => [],
    getMergeRequest: async () => ({ available: false }),
  };
  await createEngineeringContextServer(emptyProvider).connect(new StdioServerTransport());
}
