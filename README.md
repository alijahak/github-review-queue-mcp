# github-review-queue-mcp

[![ci](https://github.com/alijahak/github-review-queue-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alijahak/github-review-queue-mcp/actions/workflows/ci.yml)

An MCP server for your GitHub review queue. From Claude, ChatGPT or any MCP client, you can find the pull requests waiting on you, read them, check CI, comment, and submit reviews.

It runs two ways:

- **Locally over stdio**, with your token.
- **As a remote server with its own OAuth 2.1 authorization server**: PKCE, dynamic client registration, a consent screen per client, audience-bound tokens and refresh-token rotation. GitHub is used only to sign the user in.

```
> What's waiting on my review?
  list_review_requests -> 3 pull requests
> Summarize alice-org/app#7 and tell me why CI is red.
  get_pull_request, list_pull_request_files, get_pull_request_checks
  -> "test" failed: 2 failed (test_a, test_b)
```

## Tools

| Tool | What it does | readOnly | destructive | idempotent | openWorld |
|---|---|:-:|:-:|:-:|:-:|
| `list_review_requests` | Open PRs where your review is requested (optionally one repo) | yes | no | yes | yes |
| `get_pull_request` | Title, author, branches, size, mergeability, latest review per reviewer, description | yes | no | yes | yes |
| `list_pull_request_files` | Changed files with +/- counts, optional diffs (capped per file) | yes | no | yes | yes |
| `get_pull_request_checks` | CI on the head commit: overall state, counts, each failing check with link and summary | yes | no | yes | yes |
| `comment_on_pull_request` | Posts a comment as you | no | no | no | yes |
| `submit_pull_request_review` | APPROVE / REQUEST_CHANGES / COMMENT as you | no | **yes** | no | yes |

- Reads and writes are separate tools.
- Every tool has a title, all four hints, validated input and structured output.
- An approval is marked destructive on purpose: it can satisfy branch protection and start an auto-merge, so clients always ask before submitting one.
- Errors say what to do next: "GitHub's rate limit for this account is used up. It resets at ...", "Not found: owner/repo#7. Either it doesn't exist or this GitHub account can't see it."

## Local use (stdio)

Create a [fine-grained token](https://github.com/settings/personal-access-tokens) with **Pull requests: read and write**, **Commit statuses: read** and **Checks: read**, or use `gh auth token`.

Claude Code:

```bash
claude mcp add review-queue -e GITHUB_TOKEN=github_pat_... -- npx -y github:alijahak/github-review-queue-mcp
```

Claude Desktop, Cursor and others (`mcpServers` config):

```json
{
  "mcpServers": {
    "review-queue": {
      "command": "npx",
      "args": ["-y", "github:alijahak/github-review-queue-mcp"],
      "env": { "GITHUB_TOKEN": "github_pat_..." }
    }
  }
}
```

## Remote server (OAuth)

```
MCP client ──OAuth 2.1 + PKCE──▶ this server ──"Sign in with GitHub"──▶ github.com
     │                              │ (its own authorization server)
     └── Bearer <this server's token> ──▶ /mcp ──▶ api.github.com (with the user's GitHub token, server-side only)
```

1. Create a [GitHub OAuth App](https://github.com/settings/developers). Set its callback URL to `https://<your-host>/github/callback`.
2. Run the server:

```bash
docker build -t review-queue-mcp .
docker run -p 3000:3000 \
  -e PUBLIC_URL=https://<your-host> \
  -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  -e TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e TRUST_PROXY=1 \
  review-queue-mcp
```

3. Add `https://<your-host>/mcp` as a custom connector in Claude or ChatGPT.

| Variable | |
|---|---|
| `PUBLIC_URL` | Public origin. The MCP endpoint is `$PUBLIC_URL/mcp`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From the OAuth App |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64; encrypts stored GitHub tokens |
| `GITHUB_SCOPE` | Default `repo` (private repos too); `public_repo` limits it to public ones |
| `GITHUB_OAUTH_URL`, `GITHUB_API_URL` | For GitHub Enterprise Server |
| `TRUST_PROXY` | Number of proxies in front, for per-IP rate limiting |
| `PORT` | Default 3000 |

State is in memory: restarting signs everyone out, which fails safe. For several replicas, put the store (`src/http/store.ts`) in Redis or Postgres.

## Security model

- **No token passthrough.**
  - Clients get this server's own tokens: random, stored only as SHA-256 hashes, valid for 1 hour, and bound to `$PUBLIC_URL/mcp` (RFC 8707 `resource`; any other audience is refused).
  - The user's GitHub token never leaves the server, and it is stored encrypted (AES-256-GCM).
- **Consent per client.** Any client can register itself (that's how MCP clients connect), and every one of them gets this server's consent screen before the user is sent to GitHub. Without it, a malicious client could ride on an earlier GitHub approval of this server's single OAuth App: the confused-deputy problem in the [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices).
- **The OAuth details:**
  - PKCE S256 between client and server, and again between server and GitHub.
  - Exact redirect-URI matching.
  - Authorization codes that work once.
  - A one-time `state` toward GitHub.
  - A CSRF token on the consent form.
  - Registration accepts only `https` or loopback redirect URIs.
- **Refresh rotation with reuse detection.** Each refresh issues a new pair. Presenting a used refresh token revokes everything issued from that sign-in.
- **Tenant isolation by construction.** A tool can only get a GitHub client from the user ID inside the verified access token. Tests sign in two users and check that every GitHub call carries the right user's token.
- **Bounded calls.**
  - Explicit timeouts.
  - One retry for reads on 502/503/504, and none for writes, since a timed-out POST may have succeeded.
  - Capped output sizes.
  - Rate limits on the OAuth endpoints.

## Directory readiness

It passes [mcp-readiness](https://github.com/alijahak/mcp-readiness) with no findings, both for its tool definitions and for its OAuth discovery (401 with `resource_metadata`, RFC 9728 and RFC 8414 metadata, S256, DCR, refresh):

```
$ npm run readiness
Verdict
  Claude Connectors Directory  ready (0 errors, 0 warnings)
  ChatGPT app directory        ready (0 errors, 0 warnings)
  MCP spec and hygiene         ready (0 errors, 0 warnings)
```

The test suite runs the same checks. A directory listing still needs things outside the code: a hosted instance, a privacy policy, a support contact, and a reviewer test account.

## Tests

`npm test` runs 27 tests against a fake GitHub (OAuth with PKCE verification, plus REST) and two users:

- the whole sign-in: discovery, registration, consent, GitHub, callback, token, tools;
- tenant isolation;
- no passthrough, and encryption at rest;
- wrong PKCE verifier, code reuse, a token for another resource;
- refresh rotation and reuse revocation;
- revocation and expiry;
- consent denial, a forged CSRF value, HTML escaping of a hostile client name, insecure redirect URIs;
- GitHub error mapping, and the retry policy.

`scripts/smoke.mjs` is a read-only check against the real GitHub API:

```
$ GITHUB_TOKEN=$(gh auth token) node scripts/smoke.mjs modelcontextprotocol/typescript-sdk 2943
list_review_requests: N open review request(s)
get_pull_request: [v1.x] fix(stdio): release consumed ReadBuffer storage | +50/-1 in 2 files | reviews: 0
list_pull_request_files: src/shared/stdio.ts, test/shared/stdio.test.ts
get_pull_request_checks: success {"success":9,"failure":0,"pending":0,"skipped":1,"neutral":0}
error path: Not found: octocat/this-repo-does-not-exist#1. Either it doesn't exist or this GitHub account can't see it.
```

## License

MIT
