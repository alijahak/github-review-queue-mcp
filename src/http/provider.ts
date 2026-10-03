import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GitHubClient } from "../github.js";
import { SignInRequiredError } from "../tools.js";
import { CONSENT_HEADERS, renderConsent } from "./consent.js";
import { hashToken, newToken, pkceS256, safeEqual, Sealer } from "./crypto.js";
import { MemoryStore, type TokenRecord } from "./store.js";

export const SCOPE = "pulls";

export interface ProviderConfig {
  publicUrl: URL;
  mcpUrl: URL;
  github: {
    clientId: string;
    clientSecret: string;
    /** https://github.com, or a GitHub Enterprise host. */
    oauthUrl: string;
    apiUrl: string;
    /** GitHub OAuth scope requested for the upstream token. `repo` covers private repositories. */
    scope: string;
  };
  sealer: Sealer;
  store?: MemoryStore;
  ttl?: Partial<{ pendingMs: number; codeMs: number; accessMs: number; refreshMs: number }>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** RFC 8707 resource comparison, ignoring a fragment and one trailing slash (as the SDK's bearer check does). */
function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => {
    const u = new URL(s);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

function isLoopback(u: URL): boolean {
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

/**
 * This server is its own OAuth authorization server, and uses GitHub only to sign the user in.
 *
 * - MCP clients get this server's own tokens: short-lived, bound to this server's URL (RFC 8707), and stored
 *   only as hashes. GitHub's token never leaves the server (no token passthrough), and is encrypted at rest.
 * - Every dynamically registered client gets a consent screen before the user is sent to GitHub. With a
 *   single upstream OAuth app, skipping it would let any registered client ride on an earlier GitHub
 *   approval (the confused-deputy problem the MCP security guidance describes).
 * - Refresh tokens rotate on every use; presenting a used one revokes the whole grant.
 */
export class GitHubFederatedProvider implements OAuthServerProvider {
  readonly store: MemoryStore;
  private readonly ttl: { pendingMs: number; codeMs: number; accessMs: number; refreshMs: number };
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly callbackUrl: string;

  constructor(private readonly cfg: ProviderConfig) {
    this.store = cfg.store ?? new MemoryStore();
    this.ttl = { pendingMs: 10 * 60_000, codeMs: 60_000, accessMs: 60 * 60_000, refreshMs: 30 * 24 * 60 * 60_000, ...cfg.ttl };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.callbackUrl = new URL("/github/callback", cfg.publicUrl).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.clients.get(id),
      registerClient: (client) => {
        for (const uri of client.redirect_uris) {
          const u = new URL(uri);
          if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u))) {
            throw new InvalidClientMetadataError("redirect_uris must use https, or http on a loopback address");
          }
        }
        const full = client as OAuthClientInformationFull;
        this.store.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  private grantedScopes(requested: string[] | undefined): string[] {
    const scopes = requested?.length ? requested : [SCOPE];
    const unknown = scopes.filter((s) => s !== SCOPE);
    if (unknown.length) throw new InvalidScopeError(`unsupported scope: ${unknown.join(" ")}`);
    return scopes;
  }

  private checkResource(resource: string | undefined): string {
    const target = resource ?? this.cfg.mcpUrl.href;
    if (!sameResource(target, this.cfg.mcpUrl.href)) throw new InvalidTargetError(`tokens here are only issued for ${this.cfg.mcpUrl.href}`);
    return this.cfg.mcpUrl.href;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = this.grantedScopes(params.scopes);
    const resource = this.checkResource(params.resource?.href);
    this.store.sweep();
    const pending = {
      id: newToken(),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource,
      csrf: newToken(),
      githubVerifier: newToken(48),
      approved: false,
      expiresAt: Date.now() + this.ttl.pendingMs,
    };
    this.store.pending.set(pending.id, pending);
    res.status(200).set(CONSENT_HEADERS).type("html").send(
      renderConsent({
        clientName: client.client_name ?? client.client_id,
        redirectUri: params.redirectUri,
        pendingId: pending.id,
        csrf: pending.csrf,
        githubScope: this.cfg.github.scope,
      }),
    );
  }

  /** POST /consent: the user approved or denied on the consent page. */
  readonly handleConsent = (req: Request, res: Response): void => {
    const { pending: id, csrf, decision } = (req.body ?? {}) as Record<string, string | undefined>;
    const pending = id ? this.store.pending.get(id) : undefined;
    if (!pending || pending.expiresAt <= Date.now()) {
      res.status(400).type("text").send("This sign-in request has expired. Start again from your MCP client.");
      return;
    }
    if (!csrf || !safeEqual(csrf, pending.csrf)) {
      res.status(403).type("text").send("This form was not issued by this server.");
      return;
    }
    if (decision !== "approve") {
      this.store.pending.delete(pending.id);
      res.redirect(302, withParams(pending.redirectUri, { error: "access_denied", error_description: "The user denied access", state: pending.state }));
      return;
    }
    pending.approved = true;
    res.redirect(302, withParams(new URL("/login/oauth/authorize", this.cfg.github.oauthUrl).href, {
      client_id: this.cfg.github.clientId,
      redirect_uri: this.callbackUrl,
      scope: this.cfg.github.scope,
      state: pending.id,
      code_challenge: pkceS256(pending.githubVerifier),
      code_challenge_method: "S256",
      allow_signup: "false",
    }));
  };

  /** GET /github/callback: GitHub sent the user back. Swap GitHub's code for a token, then issue our own code. */
  readonly handleGitHubCallback = async (req: Request, res: Response): Promise<void> => {
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const pending = state ? this.store.pending.get(state) : undefined;
    if (!pending || !pending.approved || pending.expiresAt <= Date.now()) {
      res.status(400).type("text").send("This sign-in request has expired or was not approved. Start again from your MCP client.");
      return;
    }
    this.store.pending.delete(pending.id); // one use only
    const back = (params: Record<string, string>) => res.redirect(302, withParams(pending.redirectUri, { ...params, state: pending.state }));

    if (typeof req.query.error === "string" || typeof req.query.code !== "string") {
      back({ error: "access_denied", error_description: "GitHub sign-in was cancelled" });
      return;
    }

    try {
      const { token, scope } = await this.exchangeGitHubCode(req.query.code, pending.githubVerifier);
      const user = await new GitHubClient({ token, apiUrl: this.cfg.github.apiUrl, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs })
        .request<{ id: number; login: string }>("GET", "/user", { what: "your GitHub profile" });
      const userId = `github:${user.id}`;
      this.store.upstream.set(userId, { login: user.login, sealedToken: this.cfg.sealer.seal(token), scope, updatedAt: Date.now() });

      const code = newToken();
      this.store.codes.set(hashToken(code), {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        userId,
        scopes: pending.scopes,
        resource: pending.resource,
        expiresAt: Date.now() + this.ttl.codeMs,
      });
      back({ code });
    } catch (err) {
      console.error("GitHub sign-in failed", err instanceof Error ? err.message : err);
      back({ error: "server_error", error_description: "GitHub sign-in failed; try again" });
    }
  };

  private async exchangeGitHubCode(code: string, verifier: string): Promise<{ token: string; scope: string }> {
    const res = await this.fetchImpl(new URL("/login/oauth/access_token", this.cfg.github.oauthUrl), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.github.clientId,
        client_secret: this.cfg.github.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`GitHub token exchange failed: ${body.error ?? `HTTP ${res.status}`}`);
    return { token: body.access_token, scope: body.scope ?? "" };
  }

  private codeRecord(client: OAuthClientInformationFull, code: string) {
    const rec = this.store.codes.get(hashToken(code));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    return rec;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.codeRecord(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // The SDK has already checked the PKCE verifier against challengeForAuthorizationCode.
    const rec = this.codeRecord(client, code);
    this.store.codes.delete(hashToken(code)); // single use
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource && !sameResource(resource.href, rec.resource)) throw new InvalidTargetError("resource does not match the authorization request");
    return this.issue(client.client_id, rec.userId, rec.scopes, rec.resource, newToken(16));
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = hashToken(refreshToken);
    const rec = this.store.refresh.get(key);
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("invalid refresh token");
    if (rec.used) {
      // A rotated-out refresh token came back: someone has a copy. End the whole grant.
      this.store.revokeFamily(rec.familyId);
      throw new InvalidGrantError("refresh token was already used; all tokens from this sign-in are revoked");
    }
    if (rec.expiresAt <= Date.now()) throw new InvalidGrantError("refresh token expired");
    const granted = scopes?.length ? scopes : rec.scopes;
    if (granted.some((s) => !rec.scopes.includes(s))) throw new InvalidScopeError("cannot widen scopes on refresh");
    if (resource && !sameResource(resource.href, rec.resource)) throw new InvalidTargetError("resource does not match the original grant");
    rec.used = true;
    return this.issue(client.client_id, rec.userId, granted, rec.resource, rec.familyId);
  }

  private issue(clientId: string, userId: string, scopes: string[], resource: string, familyId: string): OAuthTokens {
    this.store.sweep();
    const now = Date.now();
    const access = newToken();
    const refresh = newToken();
    const base: TokenRecord = { clientId, userId, scopes, resource, familyId, expiresAt: now + this.ttl.accessMs };
    this.store.access.set(hashToken(access), base);
    this.store.refresh.set(hashToken(refresh), { ...base, expiresAt: now + this.ttl.refreshMs, used: false });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: Math.floor(this.ttl.accessMs / 1000),
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.store.access.get(hashToken(token));
    if (!rec || rec.expiresAt <= Date.now()) throw new InvalidTokenError("invalid or expired access token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: new URL(rec.resource),
      extra: { userId: rec.userId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hashToken(request.token);
    const access = this.store.access.get(key);
    if (access?.clientId === client.client_id) {
      this.store.access.delete(key);
      return;
    }
    const refresh = this.store.refresh.get(key);
    // RFC 7009: revoking a refresh token should also end the access tokens from the same grant.
    if (refresh?.clientId === client.client_id) this.store.revokeFamily(refresh.familyId);
  }

  /** The only way a tool gets a GitHub token: from the verified access token's user. */
  githubClientFor(authInfo: { extra?: Record<string, unknown> } | undefined): GitHubClient {
    const userId = authInfo?.extra?.userId;
    const grant = typeof userId === "string" ? this.store.upstream.get(userId) : undefined;
    if (!grant) throw new SignInRequiredError("No GitHub sign-in is linked to this connection. Reconnect the server to sign in again.");
    return new GitHubClient({ token: this.cfg.sealer.open(grant.sealedToken), apiUrl: this.cfg.github.apiUrl, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
  }
}
