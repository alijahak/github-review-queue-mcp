import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for github.com and api.github.com: OAuth authorize/token (with PKCE verification) and the REST
 * endpoints the tools call. Two users, each able to see only their own repository.
 */

interface User { id: number; login: string; repo: string; prNumber: number }

export const USERS: Record<string, User> = {
  alice: { id: 1001, login: "alice", repo: "alice-org/app", prNumber: 7 },
  bob: { id: 1002, login: "bob", repo: "bob-org/lib", prNumber: 3 },
};

export interface ApiCall { user: string | null; token: string | null; method: string; path: string }

export class FakeGitHub {
  readonly clientId = "gh-client-id";
  readonly clientSecret = "gh-client-secret";
  nextUser = "alice";
  readonly calls: ApiCall[] = [];
  readonly posted: Array<{ user: string; kind: "comment" | "review"; repo: string; number: number; body?: string; event?: string }> = [];
  private readonly codes = new Map<string, { user: string; challenge?: string; redirectUri: string }>();
  readonly tokens = new Map<string, string>();
  private server?: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.writeHead(500).end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);

    if (url.pathname === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== this.clientId) return this.json(res, 400, { error: "bad client" });
      const code = randomBytes(8).toString("hex");
      this.codes.set(code, {
        user: this.nextUser,
        challenge: url.searchParams.get("code_challenge") ?? undefined,
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.href }).end();
      return;
    }

    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const form = new URLSearchParams(await this.body(req));
      const rec = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) return this.json(res, 200, { error: "incorrect_client_credentials" });
      if (!rec || rec.redirectUri !== form.get("redirect_uri")) return this.json(res, 200, { error: "bad_verification_code" });
      const verifier = form.get("code_verifier") ?? "";
      if (rec.challenge && createHash("sha256").update(verifier).digest("base64url") !== rec.challenge) return this.json(res, 200, { error: "bad_verification_code" });
      const token = `gho_${rec.user}_${randomBytes(6).toString("hex")}`;
      this.tokens.set(token, rec.user);
      return this.json(res, 200, { access_token: token, token_type: "bearer", scope: "repo" });
    }

    // REST API
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const login = token ? this.tokens.get(token) ?? null : null;
    this.calls.push({ user: login, token, method: req.method ?? "GET", path: url.pathname + url.search });
    if (!login) return this.json(res, 401, { message: "Bad credentials" });
    const user = USERS[login]!;

    if (url.pathname === "/user") return this.json(res, 200, { id: user.id, login: user.login });

    if (url.pathname === "/search/issues") {
      const q = url.searchParams.get("q") ?? "";
      const repoFilter = /repo:(\S+)/.exec(q)?.[1];
      const items = repoFilter && repoFilter !== user.repo ? [] : [{
        number: user.prNumber, title: `Fix the thing in ${user.repo}`, html_url: `https://github.com/${user.repo}/pull/${user.prNumber}`,
        draft: false, updated_at: "2026-10-01T12:00:00Z", repository_url: `https://api.github.com/repos/${user.repo}`,
        user: { login: "contributor" }, labels: [{ name: "bug" }],
      }];
      return this.json(res, 200, { total_count: items.length, items });
    }

    const m = /^\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/]+)(?:\/(\w[\w-]*))?$/.exec(url.pathname);
    if (!m) return this.json(res, 404, { message: "Not Found" });
    const [, repo, kind, id, sub] = m;
    if (repo !== user.repo) return this.json(res, 404, { message: "Not Found" }); // GitHub hides private repos as 404

    if (kind === "pulls" && !sub && req.method === "GET") {
      return this.json(res, 200, {
        number: Number(id), title: "Fix the thing", state: "open", draft: false, merged: false,
        html_url: `https://github.com/${repo}/pull/${id}`, body: "Long description ".repeat(400),
        user: { login: "contributor" }, base: { ref: "main" }, head: { ref: "fix", sha: "abc1234def5678" },
        mergeable_state: "blocked", additions: 10, deletions: 2, changed_files: 2, commits: 1,
        created_at: "2026-09-30T10:00:00Z", updated_at: "2026-10-01T12:00:00Z", requested_reviewers: [{ login: user.login }],
      });
    }
    if (kind === "pulls" && sub === "reviews" && req.method === "GET") {
      return this.json(res, 200, [
        { user: { login: "carol" }, state: "APPROVED", submitted_at: "2026-10-01T09:00:00Z" },
        { user: { login: "carol" }, state: "COMMENTED", submitted_at: "2026-10-01T10:00:00Z" },
      ]);
    }
    if (kind === "pulls" && sub === "files") {
      return this.json(res, 200, [
        { filename: "src/a.ts", status: "modified", additions: 8, deletions: 2, patch: "@@ -1 +1 @@\n" + "+x\n".repeat(2000) },
        { filename: "README.md", status: "modified", additions: 2, deletions: 0, patch: "@@ -1 +1 @@\n+doc" },
      ]);
    }
    if (kind === "commits" && sub === "check-runs") {
      return this.json(res, 200, {
        check_runs: [
          { name: "test", status: "completed", conclusion: "failure", details_url: "https://ci.example/1", output: { title: "2 failed", summary: "test_a failed" } },
          { name: "lint", status: "completed", conclusion: "success" },
        ],
      });
    }
    if (kind === "commits" && sub === "status") return this.json(res, 200, { statuses: [{ context: "deploy/preview", state: "pending" }] });

    if (kind === "issues" && sub === "comments" && req.method === "POST") {
      const b = JSON.parse(await this.body(req)) as { body: string };
      this.posted.push({ user: login, kind: "comment", repo, number: Number(id), body: b.body });
      return this.json(res, 201, { id: 501, html_url: `https://github.com/${repo}/pull/${id}#issuecomment-501`, created_at: "2026-10-02T00:00:00Z" });
    }
    if (kind === "pulls" && sub === "reviews" && req.method === "POST") {
      const b = JSON.parse(await this.body(req)) as { event: string; body?: string };
      this.posted.push({ user: login, kind: "review", repo, number: Number(id), body: b.body, event: b.event });
      return this.json(res, 200, { id: 601, html_url: `https://github.com/${repo}/pull/${id}#pullrequestreview-601`, state: b.event === "APPROVE" ? "APPROVED" : b.event, submitted_at: "2026-10-02T00:00:00Z" });
    }
    return this.json(res, 404, { message: "Not Found" });
  }
}
