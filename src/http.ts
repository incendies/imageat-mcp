#!/usr/bin/env node
/**
 * Remote (Streamable HTTP) entry for the ImageAT MCP server.
 *
 * Unlike the stdio entry, this is multi-user: each MCP session carries its own
 * ImageAT API key, read from the `Authorization: Bearer iat_live_...` header on
 * the `initialize` request. This is what claude.ai and chatgpt.com connect to.
 *
 * Two endpoints share the sessions and OAuth server:
 *   /mcp          — the generic tool surface (Claude, Cursor, ChatGPT developer mode, ...)
 *   /chatgpt/mcp  — the published ChatGPT app profile (see chatgpt.ts)
 *
 * Env:
 *   PORT                   — listen port (default 8787)
 *   IMAGEAT_BASE_URL       — web app base (default https://imageat.com)
 *   OPENAI_APPS_CHALLENGE  — domain verification token for the ChatGPT app submission
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { resolveBaseUrl } from "./config.js";
import { ApiKeyAuthProvider } from "./auth.js";
import { ImageATClient } from "./client.js";
import { createImageatServer, SERVER_VERSION } from "./server.js";
import { createChatGPTServer } from "./chatgpt.js";
import { mountOAuth, apiKeyFromBearer } from "./oauth.js";

const PORT = Number(process.env.PORT) || 8787;
const baseUrl = resolveBaseUrl();
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ||
    "https://chatgpt.com,https://chat.openai.com,https://claude.ai,https://cursor.com,https://vscode.dev,https://github.com,https://imageat.com")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);

/**
 * Resolve the ImageAT API key for a request. The Bearer value may be either an
 * OAuth access token issued by our /token endpoint (browser clients) or a raw
 * iat_ key (mcp-remote, Inspector, curl). See oauth.ts:apiKeyFromBearer.
 */
function extractApiKey(req: Request, endpointPath: string): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return apiKeyFromBearer(m ? m[1].trim() : null, endpointPath);
}

function unauthorized(req: Request, res: Response, endpointPath: string) {
  // Point OAuth-capable clients (claude.ai, chatgpt.com) at our discovery doc so
  // they start the authorization flow instead of giving up.
  const base = (process.env.MCP_PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host")}`).replace(
    /\/+$/,
    "",
  );
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${endpointPath === "/mcp" ? "" : endpointPath}"`,
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
// Clients do not reliably send DELETE when they disappear, so idle sessions
// must be reclaimed or a public server leaks transports forever.
const SESSION_IDLE_MS = Math.max(60_000, Number(process.env.MCP_SESSION_IDLE_MS) || 2 * 60 * 60 * 1000);
const MAX_SESSIONS = Math.max(1, Number(process.env.MCP_MAX_SESSIONS) || 500);
const transports: Record<string, { transport: StreamableHTTPServerTransport; lastSeen: number }> = {};

const sessionSweep = setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [sid, entry] of Object.entries(transports)) {
    if (entry.lastSeen >= cutoff) continue;
    delete transports[sid];
    void entry.transport.close().catch((err) =>
      process.stderr.write(`[imageat-mcp-http] idle session close failed (${sid}): ${String(err)}\n`),
    );
  }
}, Math.min(15 * 60 * 1000, Math.max(60_000, SESSION_IDLE_MS / 2)));
sessionSweep.unref();

const app = express();
// Behind Traefik/Cloudflare: trust X-Forwarded-Proto/Host so OAuth metadata URLs are https.
app.set("trust proxy", true);
// MCP Streamable HTTP requires Origin validation to prevent browser-based DNS
// rebinding. Server-to-server clients usually omit Origin and remain unaffected.
app.use((req, res, next) => {
  const origin = req.get("origin")?.replace(/\/+$/, "");
  const localDev = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (origin && !localDev && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
});
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true })); // OAuth token/consent form posts
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin.replace(/\/+$/, "")) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) callback(null, true);
      else callback(new Error("Origin not allowed"));
    },
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
  }),
);

// OAuth 2.1 authorization server (discovery, registration, /authorize, /token).
mountOAuth(app);

// Domain verification for the ChatGPT app submission: the raw token, nothing else.
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  const token = process.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) {
    res.status(404).type("text/plain").send("Not configured");
    return;
  }
  res.type("text/plain").send(token);
});

app.get("/health", (_req, res) => {
  // `version` makes it possible to tell which build is live from outside,
  // which a deploy otherwise can't confirm.
  res.json({ ok: true, version: SERVER_VERSION, baseUrl, sessions: Object.keys(transports).length });
});

type Profile = "generic" | "chatgpt";

// MCP endpoints — POST carries JSON-RPC; GET opens the SSE stream; DELETE ends a session.
const handleMcpPost = (profile: Profile, endpointPath: string) => async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transports[sessionId].lastSeen = Date.now();
      transport = transports[sessionId].transport;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      if (Object.keys(transports).length >= MAX_SESSIONS) {
        res.set("Retry-After", "30").status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP server is at session capacity; retry shortly." }, id: null });
        return;
      }
      const apiKey = extractApiKey(req, endpointPath);
      if (!apiKey) return unauthorized(req, res, endpointPath);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = { transport, lastSeen: Date.now() };
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      if (profile === "chatgpt") {
        const client = new ImageATClient({ apiKey, baseUrl, surface: "chatgpt" }, new ApiKeyAuthProvider(apiKey));
        await createChatGPTServer(client).connect(transport);
      } else {
        const client = new ImageATClient({ apiKey, baseUrl }, new ApiKeyAuthProvider(apiKey));
        const { server } = await createImageatServer(client, (msg) =>
          process.stderr.write(`[imageat-mcp-http] ${msg}\n`),
        );
        await server.connect(transport);
      }
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
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    process.stderr.write(`[imageat-mcp-http] request error: ${message}\n`);
    if (stack) process.stderr.write(`${stack}\n`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
          data: {
            code: "MCP_TRANSPORT_ERROR",
            detail: message,
            retryable: true,
          },
        },
        id: null,
      });
    }
  }
};

app.post("/mcp", handleMcpPost("generic", "/mcp"));
app.post("/chatgpt/mcp", handleMcpPost("chatgpt", "/chatgpt/mcp"));

// GET (SSE stream) and DELETE (terminate) reuse the existing session transport.
async function handleSessionRequest(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  const entry = transports[sessionId];
  entry.lastSeen = Date.now();
  await entry.transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);
app.get("/chatgpt/mcp", handleSessionRequest);
app.delete("/chatgpt/mcp", handleSessionRequest);

app.listen(PORT, () => {
  process.stderr.write(
    `[imageat-mcp-http] listening on :${PORT} — MCP endpoints /mcp and /chatgpt/mcp, upstream ${baseUrl}\n`,
  );
});
