/**
 * A deliberately small GitHub REST client: only the endpoints the tools use, explicit timeouts, one retry for
 * idempotent reads on gateway errors, and errors written for the person reading them in a chat.
 */

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const USER_AGENT = "github-review-queue-mcp/0.1.0";
const RETRYABLE = new Set([502, 503, 504]);

export interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  updated_at: string;
  repository_url: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  mergeable_state?: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  created_at: string;
  updated_at: string;
  requested_reviewers?: Array<{ login: string }>;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface Review {
  user: { login: string } | null;
  state: string;
  submitted_at?: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null };
}

export interface CommitStatus {
  context: string;
  state: string;
  target_url?: string | null;
}

export class GitHubClient {
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown; what?: string } = {}): Promise<T> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };

    // Only reads are retried: a POST that timed out may still have created a comment or a review.
    const attempts = method === "GET" ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        lastError = err;
        if (attempt < attempts) continue;
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw new GitHubError(timedOut ? `GitHub didn't answer within ${this.timeoutMs / 1000} s. Try again.` : `Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (RETRYABLE.has(res.status) && attempt < attempts) {
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (!res.ok) throw await toError(res, opts.what ?? path);
      return (await res.json()) as T;
    }
    throw new GitHubError(`GitHub request failed: ${String(lastError)}`);
  }

  async searchReviewRequests(limit: number, repo?: string): Promise<SearchItem[]> {
    const q = ["is:pr", "is:open", "review-requested:@me", "archived:false", ...(repo ? [`repo:${repo}`] : [])].join(" ");
    const res = await this.request<{ items: SearchItem[] }>("GET", "/search/issues", {
      query: { q, per_page: limit, sort: "updated", order: "desc" },
      what: "your review requests",
    });
    return res.items;
  }

  getPull(repo: string, number: number): Promise<PullRequest> {
    return this.request("GET", `/repos/${repo}/pulls/${number}`, { what: `${repo}#${number}` });
  }

  listPullFiles(repo: string, number: number, limit: number): Promise<PullFile[]> {
    return this.request("GET", `/repos/${repo}/pulls/${number}/files`, { query: { per_page: limit }, what: `${repo}#${number}` });
  }

  listReviews(repo: string, number: number): Promise<Review[]> {
    return this.request("GET", `/repos/${repo}/pulls/${number}/reviews`, { query: { per_page: 100 }, what: `${repo}#${number}` });
  }

  async listCheckRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const res = await this.request<{ check_runs: CheckRun[] }>("GET", `/repos/${repo}/commits/${sha}/check-runs`, {
      query: { per_page: 100 },
      what: `checks for ${repo}@${sha.slice(0, 7)}`,
    });
    return res.check_runs;
  }

  async getCombinedStatus(repo: string, sha: string): Promise<CommitStatus[]> {
    const res = await this.request<{ statuses: CommitStatus[] }>("GET", `/repos/${repo}/commits/${sha}/status`, {
      what: `statuses for ${repo}@${sha.slice(0, 7)}`,
    });
    return res.statuses;
  }

  createIssueComment(repo: string, number: number, body: string): Promise<{ id: number; html_url: string; created_at: string }> {
    return this.request("POST", `/repos/${repo}/issues/${number}/comments`, { body: { body }, what: `${repo}#${number}` });
  }

  createReview(repo: string, number: number, event: string, body?: string): Promise<{ id: number; html_url: string; state: string; submitted_at?: string }> {
    return this.request("POST", `/repos/${repo}/pulls/${number}/reviews`, {
      body: body ? { event, body } : { event },
      what: `${repo}#${number}`,
    });
  }
}

async function toError(res: Response, what: string): Promise<GitHubError> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> };
    detail = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ");
  } catch {
    // Non-JSON error bodies carry nothing worth showing.
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 429 || (res.status === 403 && remaining === "0")) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` It resets at ${new Date(reset * 1000).toISOString()}.` : "";
    return new GitHubError(`GitHub's rate limit for this account is used up.${when}`, res.status);
  }
  switch (res.status) {
    case 401:
      return new GitHubError("GitHub rejected the sign-in (expired or revoked). Reconnect this server to sign in again.", 401);
    case 403:
      return new GitHubError(`This GitHub account can't access ${what}. It may need the repo scope, or SSO authorization for the organization.${detail ? ` GitHub said: ${detail}` : ""}`, 403);
    case 404:
      return new GitHubError(`Not found: ${what}. Either it doesn't exist or this GitHub account can't see it.`, 404);
    case 422:
      return new GitHubError(`GitHub refused the request for ${what}: ${detail || "validation failed"}.`, 422);
    default:
      return new GitHubError(`GitHub returned HTTP ${res.status} for ${what}.${detail ? ` ${detail}` : ""}`, res.status);
  }
}
