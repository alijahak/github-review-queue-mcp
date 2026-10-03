#!/usr/bin/env node
// Remote mode: many users, OAuth via a GitHub OAuth App, Streamable HTTP on /mcp.
import { createApp } from "./app.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`github-review-queue-mcp: missing ${name}. See the README's "Remote server" section.\n`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.PORT ?? 3000);
const { app, mcpUrl } = createApp({
  publicUrl: required("PUBLIC_URL"),
  encryptionKey: required("TOKEN_ENCRYPTION_KEY"),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : undefined,
  github: {
    clientId: required("GITHUB_CLIENT_ID"),
    clientSecret: required("GITHUB_CLIENT_SECRET"),
    oauthUrl: process.env.GITHUB_OAUTH_URL ?? "https://github.com",
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    scope: process.env.GITHUB_SCOPE ?? "repo",
  },
});

app.listen(port, () => {
  process.stdout.write(`github-review-queue-mcp listening on :${port}; MCP endpoint ${mcpUrl.href}\n`);
});
