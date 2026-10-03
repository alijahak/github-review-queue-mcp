import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GitHubError, type CheckRun, type CommitStatus, type GitHubClient, type Review } from "./github.js";

/** Thrown by a client resolver when the caller has no usable GitHub sign-in. */
export class SignInRequiredError extends Error {}

export type ClientResolver = (extra: { authInfo?: { extra?: Record<string, unknown> } }) => Promise<GitHubClient> | GitHubClient;

const repo = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/, 'Use "owner/name", for example "octocat/hello-world".')
  .describe('Repository as "owner/name", for example "octocat/hello-world"');
const number = z.number().int().min(1).max(1_000_000_000).describe("Pull request number");
const body = z.string().min(1).max(65_536);

const BODY_LIMIT = 4_000;
const PATCH_LIMIT = 3_000;
const SUMMARY_LIMIT = 500;

function cut(text: string | null | undefined, limit: number): { text: string; truncated: boolean } {
  const t = text ?? "";
  return t.length > limit ? { text: t.slice(0, limit), truncated: true } : { text: t, truncated: false };
}

function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turns expected failures into messages the user can act on; logs and hides anything unexpected. */
async function run(resolve: ClientResolver, extra: Parameters<ClientResolver>[0], fn: (gh: GitHubClient) => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn(await resolve(extra));
  } catch (err) {
    if (err instanceof GitHubError || err instanceof SignInRequiredError) return fail(err.message);
    console.error("unexpected tool error", err);
    return fail("Something went wrong on the server while talking to GitHub. Try again; if it keeps happening, reconnect the server.");
  }
}

function latestReviewByReviewer(reviews: Review[]): Array<{ reviewer: string; state: string; submitted_at?: string }> {
  const byUser = new Map<string, Review>();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login) continue;
    // A plain comment doesn't replace an approval or a change request.
    if (r.state === "COMMENTED" && byUser.has(login)) continue;
    byUser.set(login, r);
  }
  return [...byUser].map(([reviewer, r]) => ({ reviewer, state: r.state, submitted_at: r.submitted_at }));
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function summarizeChecks(runs: CheckRun[], statuses: CommitStatus[]) {
  const counts = { success: 0, failure: 0, pending: 0, skipped: 0, neutral: 0 };
  const failing: Array<{ name: string; conclusion: string; details_url?: string; summary?: string }> = [];
  for (const r of runs) {
    if (r.status !== "completed") counts.pending++;
    else if (r.conclusion === "success") counts.success++;
    else if (r.conclusion && FAILED.has(r.conclusion)) {
      counts.failure++;
      const summary = cut(r.output?.summary ?? r.output?.title ?? "", SUMMARY_LIMIT).text || undefined;
      failing.push({ name: r.name, conclusion: r.conclusion, details_url: r.details_url ?? undefined, summary });
    } else if (r.conclusion === "skipped") counts.skipped++;
    else counts.neutral++;
  }
  for (const s of statuses) {
    if (s.state === "success") counts.success++;
    else if (s.state === "pending") counts.pending++;
    else {
      counts.failure++;
      failing.push({ name: s.context, conclusion: s.state, details_url: s.target_url ?? undefined });
    }
  }
  const total = runs.length + statuses.length;
  const overall = total === 0 ? "none" : counts.failure > 0 ? "failure" : counts.pending > 0 ? "pending" : counts.success > 0 ? "success" : "neutral";
  return { overall, counts, failing };
}

const readHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, resolve: ClientResolver): void {
  server.registerTool(
    "list_review_requests",
    {
      title: "List my review requests",
      description: "Lists open pull requests where your review is requested, most recently updated first. Optionally limited to one repository.",
      inputSchema: {
        repo: repo.optional(),
        limit: z.number().int().min(1).max(50).default(20).describe("How many pull requests to return (1-50, default 20)"),
      },
      outputSchema: {
        count: z.number(),
        pull_requests: z.array(z.object({
          repo: z.string(), number: z.number(), title: z.string(), author: z.string().optional(),
          url: z.string(), draft: z.boolean(), updated_at: z.string(), labels: z.array(z.string()),
        })),
      },
      annotations: { title: "List my review requests", ...readHints },
    },
    async ({ repo: r, limit }, extra) =>
      run(resolve, extra, async (gh) => {
        const items = await gh.searchReviewRequests(limit, r);
        const prs = items.map((i) => ({
          repo: i.repository_url.split("/repos/")[1] ?? i.repository_url,
          number: i.number,
          title: i.title,
          author: i.user?.login,
          url: i.html_url,
          draft: i.draft ?? false,
          updated_at: i.updated_at,
          labels: i.labels.map((l) => l.name),
        }));
        return ok({ count: prs.length, pull_requests: prs });
      }),
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "Get a pull request",
      description: "Returns a pull request's summary: title, author, branches, size, mergeability, requested reviewers, each reviewer's latest review, and the description (first 4,000 characters).",
      inputSchema: { repo, number },
      outputSchema: {
        repo: z.string(), number: z.number(), title: z.string(), state: z.string(), draft: z.boolean(), merged: z.boolean(),
        author: z.string().optional(), url: z.string(), base: z.string(), head: z.string(), head_sha: z.string(),
        mergeable_state: z.string().optional(), additions: z.number(), deletions: z.number(), changed_files: z.number(),
        commits: z.number(), created_at: z.string(), updated_at: z.string(), requested_reviewers: z.array(z.string()),
        reviews: z.array(z.object({ reviewer: z.string(), state: z.string(), submitted_at: z.string().optional() })),
        body: z.string(), body_truncated: z.boolean(),
      },
      annotations: { title: "Get a pull request", ...readHints },
    },
    async ({ repo: r, number: n }, extra) =>
      run(resolve, extra, async (gh) => {
        const [pr, reviews] = await Promise.all([gh.getPull(r, n), gh.listReviews(r, n)]);
        const desc = cut(pr.body, BODY_LIMIT);
        return ok({
          repo: r, number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged,
          author: pr.user?.login, url: pr.html_url, base: pr.base.ref, head: pr.head.ref, head_sha: pr.head.sha,
          mergeable_state: pr.mergeable_state, additions: pr.additions, deletions: pr.deletions,
          changed_files: pr.changed_files, commits: pr.commits, created_at: pr.created_at, updated_at: pr.updated_at,
          requested_reviewers: (pr.requested_reviewers ?? []).map((u) => u.login),
          reviews: latestReviewByReviewer(reviews),
          body: desc.text, body_truncated: desc.truncated,
        });
      }),
  );

  server.registerTool(
    "list_pull_request_files",
    {
      title: "List changed files",
      description: "Lists the files a pull request changes, with additions and deletions per file. Set include_patch to also get each file's diff (first 3,000 characters per file).",
      inputSchema: {
        repo,
        number,
        include_patch: z.boolean().default(false).describe("Include each file's diff (default false)"),
        limit: z.number().int().min(1).max(100).default(50).describe("How many files to return (1-100, default 50)"),
      },
      outputSchema: {
        count: z.number(),
        files: z.array(z.object({
          filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number(),
          patch: z.string().optional(), patch_truncated: z.boolean().optional(),
        })),
      },
      annotations: { title: "List changed files", ...readHints },
    },
    async ({ repo: r, number: n, include_patch, limit }, extra) =>
      run(resolve, extra, async (gh) => {
        const files = await gh.listPullFiles(r, n, limit);
        return ok({
          count: files.length,
          files: files.map((f) => {
            const base = { filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
            if (!include_patch) return base;
            const p = cut(f.patch, PATCH_LIMIT);
            return { ...base, patch: p.text, patch_truncated: p.truncated };
          }),
        });
      }),
  );

  server.registerTool(
    "get_pull_request_checks",
    {
      title: "Get CI status",
      description: "Returns the CI result for a pull request's latest commit: an overall state, counts per outcome, and every failing check with its link and summary.",
      inputSchema: { repo, number },
      outputSchema: {
        head_sha: z.string(),
        overall: z.string(),
        counts: z.object({ success: z.number(), failure: z.number(), pending: z.number(), skipped: z.number(), neutral: z.number() }),
        failing: z.array(z.object({ name: z.string(), conclusion: z.string(), details_url: z.string().optional(), summary: z.string().optional() })),
      },
      annotations: { title: "Get CI status", ...readHints },
    },
    async ({ repo: r, number: n }, extra) =>
      run(resolve, extra, async (gh) => {
        const pr = await gh.getPull(r, n);
        const [runs, statuses] = await Promise.all([gh.listCheckRuns(r, pr.head.sha), gh.getCombinedStatus(r, pr.head.sha)]);
        return ok({ head_sha: pr.head.sha, ...summarizeChecks(runs, statuses) });
      }),
  );

  server.registerTool(
    "comment_on_pull_request",
    {
      title: "Comment on a pull request",
      description: "Posts a comment on a pull request's conversation, as you. Everyone with access to the repository can see it.",
      inputSchema: { repo, number, body: body.describe("Comment text (Markdown)") },
      outputSchema: { id: z.number(), url: z.string(), created_at: z.string() },
      // Additive and editable afterwards, so not destructive; still a visible write, so not read-only.
      annotations: { title: "Comment on a pull request", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ repo: r, number: n, body: text }, extra) =>
      run(resolve, extra, async (gh) => {
        const c = await gh.createIssueComment(r, n, text);
        return ok({ id: c.id, url: c.html_url, created_at: c.created_at });
      }),
  );

  server.registerTool(
    "submit_pull_request_review",
    {
      title: "Submit a review",
      description: "Submits a review on a pull request, as you: APPROVE, REQUEST_CHANGES, or COMMENT. REQUEST_CHANGES and COMMENT need a body.",
      inputSchema: {
        repo,
        number,
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("The review verdict"),
        body: body.optional().describe("Review text (Markdown); required unless the event is APPROVE"),
      },
      outputSchema: { id: z.number(), url: z.string(), state: z.string(), submitted_at: z.string().optional() },
      // An approval can satisfy branch protection and start an auto-merge, so clients should always confirm.
      annotations: { title: "Submit a review", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ repo: r, number: n, event, body: text }, extra) => {
      if (event !== "APPROVE" && !text) return fail(`A ${event} review needs a body explaining it.`);
      return run(resolve, extra, async (gh) => {
        const review = await gh.createReview(r, n, event, text);
        return ok({ id: review.id, url: review.html_url, state: review.state, submitted_at: review.submitted_at });
      });
    },
  );
}
