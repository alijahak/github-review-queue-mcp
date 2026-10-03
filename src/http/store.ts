import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** An /authorize request waiting for the user's consent and then GitHub's callback. */
export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  csrf: string;
  githubVerifier: string;
  approved: boolean;
  expiresAt: number;
}

export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface TokenRecord {
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  /** Every token minted from one authorization shares a family, so reuse detection can revoke all of them. */
  familyId: string;
}

export interface RefreshRecord extends TokenRecord {
  used: boolean;
}

export interface UpstreamGrant {
  login: string;
  sealedToken: string;
  scope: string;
  updatedAt: number;
}

/**
 * In-memory state. Codes and tokens are keyed by their SHA-256 hash, never by the raw value. Restarting the
 * process signs everyone out, which is safe; production deployments swap this for Redis or Postgres.
 */
export class MemoryStore {
  readonly clients = new Map<string, OAuthClientInformationFull>();
  readonly pending = new Map<string, PendingAuthorization>();
  readonly codes = new Map<string, CodeRecord>();
  readonly access = new Map<string, TokenRecord>();
  readonly refresh = new Map<string, RefreshRecord>();
  readonly upstream = new Map<string, UpstreamGrant>();

  revokeFamily(familyId: string): void {
    for (const [k, v] of this.access) if (v.familyId === familyId) this.access.delete(k);
    for (const [k, v] of this.refresh) if (v.familyId === familyId) this.refresh.delete(k);
  }

  sweep(now = Date.now()): void {
    for (const map of [this.pending, this.codes, this.access, this.refresh] as Array<Map<string, { expiresAt: number }>>) {
      for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
    }
  }
}
