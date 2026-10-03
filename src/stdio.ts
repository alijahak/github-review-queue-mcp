#!/usr/bin/env node
// Local mode: one user, a token from the environment, stdio transport.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GitHubClient } from "./github.js";
import { createServer } from "./server.js";

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!token) {
  process.stderr.write(
    "github-review-queue-mcp: set GITHUB_TOKEN (a fine-grained token with Pull requests: read/write, or `gh auth token`).\n",
  );
  process.exit(1);
}

const client = new GitHubClient({ token, apiUrl: process.env.GITHUB_API_URL });
const server = createServer(() => client);
await server.connect(new StdioServerTransport());
