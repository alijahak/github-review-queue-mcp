import express, { type NextFunction, type Request, type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../server.js";
import { Sealer } from "./crypto.js";
import { GitHubFederatedProvider, SCOPE, type ProviderConfig } from "./provider.js";

export interface AppConfig {
  /** Public origin of this server, e.g. https://reviews.example.com */
  publicUrl: string;
  github: ProviderConfig["github"];
  encryptionKey: string;
  /** Number of proxies in front of the app (for rate limiting by client IP). */
  trustProxy?: number;
  ttl?: ProviderConfig["ttl"];
  fetchImpl?: typeof fetch;
  /** Rate limits on the OAuth endpoints; tests turn them off. */
  rateLimits?: boolean;
}

export function createApp(cfg: AppConfig) {
  const publicUrl = new URL(cfg.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);
  const provider = new GitHubFederatedProvider({
    publicUrl,
    mcpUrl,
    github: cfg.github,
    sealer: Sealer.fromBase64(cfg.encryptionKey),
    ttl: cfg.ttl,
    fetchImpl: cfg.fetchImpl,
  });

  const app = express();
  app.disable("x-powered-by");
  if (cfg.trustProxy) app.set("trust proxy", cfg.trustProxy);

  const limits = cfg.rateLimits === false ? { rateLimit: false as const } : {};
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "GitHub Review Queue",
      serviceDocumentationUrl: new URL("https://github.com/alijahak/github-review-queue-mcp"),
      authorizationOptions: limits,
      tokenOptions: limits,
      clientRegistrationOptions: limits,
      revocationOptions: limits,
    }),
  );

  app.post("/consent", express.urlencoded({ extended: false, limit: "10kb" }), provider.handleConsent);
  app.get("/github/callback", (req, res, next) => {
    provider.handleGitHubCallback(req, res).catch(next);
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server per request, bound to the caller's verified token.
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    const server = createServer((extra) => provider.githubClientFor(extra.authInfo));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless: use POST." }, id: null });
  };
  app.get("/mcp", bearer, notAllowed);
  app.delete("/mcp", bearer, notAllowed);

  app.get("/", (_req, res) => {
    res.type("text").send(`GitHub Review Queue MCP server. Connect your MCP client to ${mcpUrl.href}`);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("unhandled error", err);
    if (!res.headersSent) res.status(500).type("text").send("Internal server error");
  });

  return { app, provider, mcpUrl };
}
