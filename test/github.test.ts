import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../src/github.js";
import { summarizeChecks } from "../src/tools.js";

function stub(responses: Array<() => Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof fetch;
  return { client: new GitHubClient({ token: "t", apiUrl: "https://api.test", fetchImpl }), calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("GitHubClient errors", () => {
  it("explains an expired sign-in", async () => {
    const { client } = stub([json(401, { message: "Bad credentials" })]);
    await expect(client.getPull("a/b", 1)).rejects.toThrow(/Reconnect this server/);
  });

  it("explains a used-up rate limit with the reset time", async () => {
    const { client } = stub([json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" })]);
    await expect(client.getPull("a/b", 1)).rejects.toThrow(/rate limit .* resets at 2026-/);
  });

  it("treats 404 as 'missing or not visible'", async () => {
    const { client } = stub([json(404, { message: "Not Found" })]);
    const err = await client.getPull("a/b", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toBe("Not found: a/b#1. Either it doesn't exist or this GitHub account can't see it.");
  });

  it("passes GitHub's validation message through on 422", async () => {
    const { client } = stub([json(422, { message: "Unprocessable", errors: [{ message: "Can not approve your own pull request" }] })]);
    await expect(client.createReview("a/b", 1, "APPROVE")).rejects.toThrow(/Can not approve your own pull request/);
  });
});

describe("GitHubClient retries", () => {
  it("retries a read once on a gateway error", async () => {
    const { client, calls } = stub([json(503, {}), json(200, { number: 1 })]);
    await expect(client.getPull("a/b", 1)).resolves.toMatchObject({ number: 1 });
    expect(calls).toHaveLength(2);
  });

  it("never retries a write: the first attempt may have succeeded", async () => {
    const { client, calls } = stub([json(503, {}), json(201, { id: 1 })]);
    await expect(client.createIssueComment("a/b", 1, "hi")).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(1);
  });
});

describe("summarizeChecks", () => {
  it("reports none when there are no checks", () => {
    expect(summarizeChecks([], []).overall).toBe("none");
  });

  it("failure beats pending beats success", () => {
    const ok = { name: "a", status: "completed", conclusion: "success" };
    const running = { name: "b", status: "in_progress", conclusion: null };
    const bad = { name: "c", status: "completed", conclusion: "timed_out", details_url: "u", output: { summary: "x".repeat(900) } };
    expect(summarizeChecks([ok], []).overall).toBe("success");
    expect(summarizeChecks([ok, running], []).overall).toBe("pending");
    const s = summarizeChecks([ok, running, bad], [{ context: "legacy", state: "error" }]);
    expect(s.overall).toBe("failure");
    expect(s.failing.map((f) => f.name)).toEqual(["c", "legacy"]);
    expect(s.failing[0]?.summary?.length).toBe(500);
  });
});
