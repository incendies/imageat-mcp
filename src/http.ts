#!/usr/bin/env node
/**
 * Remote (Streamable HTTP) entry for the ImageAT MCP server.
 *
 * Unlike the stdio entry, this is multi-user: each MCP session carries its own
 * ImageAT API key, read from the `Authorization: Bearer iat_live_...` header on
 * the `initialize` request. This is what claude.ai and chatgpt.com connect to.
 *
 * Env:
 *   PORT              — listen port (default 8787)
 *   IMAGEAT_BASE_URL  — web app base (default https://imageat.com)
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { resolveBaseUrl } from "./config.js";
import { ApiKeyAuthProvider } from "./auth.js";
import { ImageATClient } from "./client.js";
import { createImageatServer } from "./server.js";
import { mountOAuth, apiKeyFromBearer } from "./oauth.js";

const PORT = Number(process.env.PORT) || 8787;
const baseUrl = resolveBaseUrl();

/**
 * Resolve the ImageAT API key for a request. The Bearer value may be either an
 * OAuth access token issued by our /token endpoint (browser clients) or a raw
 * iat_ key (mcp-remote, Inspector, curl). See oauth.ts:apiKeyFromBearer.
 */
function extractApiKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return apiKeyFromBearer(m ? m[1].trim() : null);
}

function unauthorized(req: Request, res: Response) {
  // Point OAuth-capable clients (claude.ai, chatgpt.com) at our discovery doc so
  // they start the authorization flow instead of giving up.
  const base = (process.env.MCP_PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host")}`).replace(
    /\/+$/,
    "",
  );
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message:
        "Unauthorized. Connect with OAuth, or send your ImageAT API key as " +
        "'Authorization: Bearer iat_live_...'. Create one on your ImageAT Projects page.",
    },
    id: null,
  });
}

// Active sessions keyed by MCP session id. Each is bound to one user's API key.
const transports: Record<string, StreamableHTTPServerTransport> = {};

const app = express();
// Behind Traefik/Cloudflare: trust X-Forwarded-Proto/Host so OAuth metadata URLs are https.
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true })); // OAuth token/consent form posts
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
  }),
);

// OAuth 2.1 authorization server (discovery, registration, /authorize, /token).
mountOAuth(app);

app.get("/health", (_req, res) => {
  res.json({ ok: true, baseUrl, sessions: Object.keys(transports).length });
});

// Main MCP endpoint — POST carries JSON-RPC; GET opens the SSE stream; DELETE ends a session.
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const apiKey = extractApiKey(req);
      if (!apiKey) return unauthorized(req, res);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      const client = new ImageATClient({ apiKey, baseUrl }, new ApiKeyAuthProvider(apiKey));
      const { server } = await createImageatServer(client, (msg) =>
        process.stderr.write(`[imageat-mcp-http] ${msg}\n`),
      );
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session id" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(
      `[imageat-mcp-http] request error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET (SSE stream) and DELETE (terminate) reuse the existing session transport.
async function handleSessionRequest(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, () => {
  process.stderr.write(
    `[imageat-mcp-http] listening on :${PORT} — MCP endpoint /mcp, upstream ${baseUrl}\n`,
  );
});
