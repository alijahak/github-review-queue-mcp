import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkAuth, checkTools, probeAuth } from "mcp-readiness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { hashToken } from "../src/http/crypto.js";
import { FakeGitHub, USERS } from "./fake-github.js";

const REDIRECT = "http://127.0.0.1:9/callback";
const fake = new FakeGitHub();
let server: Server;
let base = "";
let mcpUrl = "";
let provider: ReturnType<typeof createApp>["provider"];

beforeAll(async () => {
  await fake.start();
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const built = createApp({
    publicUrl: base,
    encryptionKey: randomBytes(32).toString("base64"),
    rateLimits: false,
    github: { clientId: fake.clientId, clientSecret: fake.clientSecret, oauthUrl: fake.url, apiUrl: fake.url, scope: "repo" },
  });
  provider = built.provider;
  mcpUrl = built.mcpUrl.href;
  server.on("request", built.app);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.stop();
});

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

async function register(name = "Test Client", redirectUris = [REDIRECT]) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
}

/** Walks the browser part of the flow: authorize -> consent -> GitHub -> callback -> client redirect. */
async function authorize(user: string, opts: { decision?: "approve" | "deny"; resource?: string; clientName?: string } = {}) {
  const reg = (await (await register(opts.clientName)).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authUrl = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: s256(verifier),
    code_challenge_method: "S256", state: "client-state", scope: "pulls", resource: opts.resource ?? mcpUrl,
  })) authUrl.searchParams.set(k, v);

  const consent = await fetch(authUrl, { redirect: "manual" });
  const html = await consent.text();
  if (consent.status !== 200) return { clientId: reg.client_id, verifier, consentStatus: consent.status, location: consent.headers.get("location"), html };
  const pending = /name="pending" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

  const decided = await fetch(`${base}/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, csrf, decision: opts.decision ?? "approve" }),
  });
  let location = decided.headers.get("location") ?? "";
  if (opts.decision === "deny") return { clientId: reg.client_id, verifier, location, html };

  fake.nextUser = user;
  const atGitHub = await fetch(location, { redirect: "manual" }); // fake GitHub "approves" and redirects back
  const callback = await fetch(atGitHub.headers.get("location") ?? "", { redirect: "manual" });
  location = callback.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code") ?? "";
  return { clientId: reg.client_id, verifier, code, location, html, pending, csrf };
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function signIn(user: string) {
  const a = await authorize(user);
  const t = await token({ grant_type: "authorization_code", code: a.code ?? "", code_verifier: a.verifier, client_id: a.clientId, redirect_uri: REDIRECT, resource: mcpUrl });
  expect(t.status).toBe(200);
  return { clientId: a.clientId, access: t.body.access_token!, refresh: t.body.refresh_token! };
}

async function mcp(access: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${access}` } } }));
  return client;
}

describe("discovery", () => {
  it("passes mcp-readiness's OAuth discovery checks", async () => {
    const probe = await probeAuth(mcpUrl);
    expect(probe.initializeStatus).toBe(401);
    expect(probe.prmSource).toBe("header");
    expect(probe.asMetadata?.code_challenge_methods_supported).toEqual(["S256"]);
    const errors = checkAuth(probe, ["claude", "chatgpt", "core"]).filter((f) => f.severity !== "info");
    expect(errors).toEqual([]);
  });
});

describe("sign-in and tools", () => {
  it("signs alice in and lists her review queue with her GitHub token only", async () => {
    const { access } = await signIn("alice");
    const before = fake.calls.length;
    const client = await mcp(access);
    const res = await client.callTool({ name: "list_review_requests", arguments: {} });
    const data = res.structuredContent as { pull_requests: Array<{ repo: string; number: number }> };
    expect(data.pull_requests).toEqual([expect.objectContaining({ repo: "alice-org/app", number: 7 })]);
    const used = fake.calls.slice(before);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((c) => c.user === "alice")).toBe(true);
    await client.close();
  });

  it("never passes its own tokens through to GitHub, or GitHub's to the client", async () => {
    const { access, refresh } = await signIn("alice");
    const client = await mcp(access);
    await client.callTool({ name: "get_pull_request", arguments: { repo: "alice-org/app", number: 7 } });
    await client.close();
    expect(fake.calls.some((c) => c.token === access || c.token === refresh)).toBe(false);
    expect(access.startsWith("gho_")).toBe(false);
    // And the stored GitHub token is encrypted, not plain.
    const grant = provider.store.upstream.get(`github:${USERS.alice!.id}`);
    expect(grant?.sealedToken.startsWith("v1.")).toBe(true);
    expect(grant?.sealedToken).not.toContain("gho_");
  });

  it("keeps tenants apart: bob cannot read alice's pull request", async () => {
    const { access } = await signIn("bob");
    const before = fake.calls.length;
    const client = await mcp(access);
    const res = await client.callTool({ name: "get_pull_request", arguments: { repo: "alice-org/app", number: 7 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("Not found: alice-org/app#7");
    expect(fake.calls.slice(before).every((c) => c.user === "bob")).toBe(true);
    await client.close();
  });

  it("summarizes a pull request, its files and its CI", async () => {
    const { access } = await signIn("alice");
    const client = await mcp(access);
    const pr = (await client.callTool({ name: "get_pull_request", arguments: { repo: "alice-org/app", number: 7 } })).structuredContent as Record<string, unknown>;
    expect(pr).toMatchObject({ head_sha: "abc1234def5678", body_truncated: true, reviews: [{ reviewer: "carol", state: "APPROVED" }] });
    expect((pr.body as string).length).toBe(4000);

    const files = (await client.callTool({ name: "list_pull_request_files", arguments: { repo: "alice-org/app", number: 7, include_patch: true } })).structuredContent as { files: Array<{ patch?: string; patch_truncated?: boolean }> };
    expect(files.files[0]).toMatchObject({ patch_truncated: true });
    expect(files.files[0]?.patch?.length).toBe(3000);

    const checks = (await client.callTool({ name: "get_pull_request_checks", arguments: { repo: "alice-org/app", number: 7 } })).structuredContent as Record<string, unknown>;
    expect(checks).toMatchObject({ overall: "failure", counts: { success: 1, failure: 1, pending: 1 }, failing: [{ name: "test", conclusion: "failure" }] });
    await client.close();
  });

  it("posts comments and reviews as the signed-in user", async () => {
    const { access } = await signIn("alice");
    const client = await mcp(access);
    await client.callTool({ name: "comment_on_pull_request", arguments: { repo: "alice-org/app", number: 7, body: "Looks good" } });
    await client.callTool({ name: "submit_pull_request_review", arguments: { repo: "alice-org/app", number: 7, event: "APPROVE" } });
    expect(fake.posted.slice(-2)).toEqual([
      expect.objectContaining({ user: "alice", kind: "comment", body: "Looks good" }),
      expect.objectContaining({ user: "alice", kind: "review", event: "APPROVE" }),
    ]);
    const missing = await client.callTool({ name: "submit_pull_request_review", arguments: { repo: "alice-org/app", number: 7, event: "REQUEST_CHANGES" } });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it("rejects bad input before calling GitHub", async () => {
    const { access } = await signIn("alice");
    const client = await mcp(access);
    const before = fake.calls.length;
    const res = await client.callTool({ name: "get_pull_request", arguments: { repo: "not a repo", number: 7 } });
    expect(res.isError).toBe(true);
    expect(fake.calls.length).toBe(before);
    await client.close();
  });

  it("its tool definitions pass mcp-readiness with no findings", async () => {
    const { access } = await signIn("alice");
    const client = await mcp(access);
    const { tools } = await client.listTools();
    expect(checkTools(tools, ["claude", "chatgpt", "core"]).findings).toEqual([]);
    await client.close();
  });
});

describe("OAuth hardening", () => {
  it("requires a valid token, and says where to find the metadata", async () => {
    const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("rejects a wrong PKCE verifier", async () => {
    const a = await authorize("alice");
    const t = await token({ grant_type: "authorization_code", code: a.code ?? "", code_verifier: "wrong".repeat(10), client_id: a.clientId, redirect_uri: REDIRECT });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe("invalid_grant");
  });

  it("uses each authorization code once", async () => {
    const a = await authorize("alice");
    const params = { grant_type: "authorization_code", code: a.code ?? "", code_verifier: a.verifier, client_id: a.clientId, redirect_uri: REDIRECT };
    expect((await token(params)).status).toBe(200);
    expect((await token(params)).body.error).toBe("invalid_grant");
  });

  it("only issues tokens for this server (RFC 8707)", async () => {
    const atAuthorize = await authorize("alice", { resource: "https://other.example/mcp" });
    expect(atAuthorize.consentStatus).toBe(302);
    expect(atAuthorize.location).toContain("error=invalid_target");

    const a = await authorize("alice");
    const t = await token({ grant_type: "authorization_code", code: a.code ?? "", code_verifier: a.verifier, client_id: a.clientId, redirect_uri: REDIRECT, resource: "https://other.example/mcp" });
    expect(t.body.error).toBe("invalid_target");
  });

  it("rotates refresh tokens, and a reused one revokes the whole grant", async () => {
    const s = await signIn("alice");
    const first = await token({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(s.refresh);

    const replay = await token({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId });
    expect(replay.body.error).toBe("invalid_grant");

    // The tokens minted by the legitimate refresh are gone too.
    const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.body.access_token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("revokes an access token", async () => {
    const s = await signIn("alice");
    const r = await fetch(`${base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: s.access, client_id: s.clientId }) });
    expect(r.status).toBe(200);
    const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.access}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired access token", async () => {
    const s = await signIn("alice");
    provider.store.access.get(hashToken(s.access))!.expiresAt = Date.now() - 1;
    const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.access}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("asks for consent per client, honors a denial, and checks the form's CSRF value", async () => {
    const denied = await authorize("alice", { decision: "deny" });
    expect(denied.location).toContain("error=access_denied");
    expect(denied.location).toContain("state=client-state");

    const a = await authorize("alice", { clientName: "Tamper Test" });
    // pending + csrf were consumed by the approved flow; craft a fresh pending and forge its CSRF value
    const reg = (await (await register()).json()) as { client_id: string };
    const page = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: s256("v".repeat(43)), code_challenge_method: "S256" })}`);
    const pending = /name="pending" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const forged = await fetch(`${base}/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ pending, csrf: "forged", decision: "approve" }) });
    expect(forged.status).toBe(403);
    expect(a.code).toBeTruthy();
  });

  it("escapes a hostile client name on the consent page", async () => {
    const a = await authorize("alice", { clientName: '<script>alert("x")</script>' });
    expect(a.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(a.html).not.toContain("<script>");
  });

  it("refuses registrations with insecure redirect URIs", async () => {
    const res = await register("Bad", ["http://evil.example/cb"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });

  it("refuses a GitHub callback that wasn't approved on the consent page", async () => {
    const res = await fetch(`${base}/github/callback?code=x&state=never-issued`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});
