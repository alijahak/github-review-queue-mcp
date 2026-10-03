import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ClientResolver } from "./tools.js";

export const SERVER_NAME = "github-review-queue";
export const SERVER_VERSION = "0.1.0";

export function createServer(resolve: ClientResolver): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "GitHub Review Queue" },
    {
      instructions:
        "Tools for working through your GitHub review queue: find pull requests waiting on you, read them, check CI, comment, and submit reviews. Reads are safe to run; comments and reviews are posted as the signed-in user.",
    },
  );
  registerTools(server, resolve);
  return server;
}
