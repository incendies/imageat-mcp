/**
 * Minimal OAuth 2.1 authorization server for the remote MCP endpoint.
 *
 * Browser MCP clients (claude.ai, chatgpt.com) will NOT accept a static Bearer
 * key — they run the OAuth discovery + PKCE flow described by the MCP spec. This
 * module implements just enough of that flow to let a user paste their ImageAT
 * `iat_live_` key on a consent page and have the client receive an access token.
 *
 * The access/refresh tokens are stateless: they are the user's API key encrypted
 * with AES-256-GCM under a server secret. So there is no session store to lose on
 * restart — the only in-memory state is short-lived authorization codes and the
 * set of dynamically-registered clients.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 resource metadata
 *   GET  /.well-known/oauth-authorization-server[/mcp] RFC 8414 AS metadata
 *   POST /register                                     RFC 7591 dynamic registration
 *   GET  /authorize                                    consent page (paste API key)
 *   POST /authorize                                    consent submit -> auth code
 *   POST /token                                        code/refresh -> access token
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { resolveBaseUrl } from "./config.js";

// Upstream ImageAT web app that hosts the "Sign in with ImageAT" consent page
// and the mint/exchange endpoints.
const IMAGEAT_BASE_URL = resolveBaseUrl();
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY?.trim();

// ---------------------------------------------------------------------------
// Token crypto — the API key sealed into an opaque, self-contained token.
// ---------------------------------------------------------------------------

const ACCESS_PREFIX = "iao_"; // ImageAT oauth access token
const REFRESH_PREFIX = "iar_"; // ImageAT oauth refresh token

const secretSource =
  process.env.MCP_OAUTH_SECRET?.trim() || crypto.randomBytes(32).toString("hex");
if (!process.env.MCP_OAUTH_SECRET?.trim()) {
  process.stderr.write(
    "[imageat-mcp-http] WARNING: MCP_OAUTH_SECRET not set — using an ephemeral secret. " +
      "Issued tokens will be invalidated on restart. Set MCP_OAUTH_SECRET to a long random string.\n",
  );
}
const CRYPTO_KEY = crypto.scryptSync(secretSource, "imageat-mcp-oauth-v1", 32);

function seal(apiKey: string, prefix: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CRYPTO_KEY, iv);
  const ct = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return prefix + Buffer.concat([iv, tag, ct]).toString("base64url");
}

function open(token: string, prefix: string): string | null {
  if (!token.startsWith(prefix)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length), "base64url");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", CRYPTO_KEY, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return out || null;
  } catch {
    return null;
  }
}

/** Resolve an incoming Bearer value to the raw ImageAT API key, or null. */
export function apiKeyFromBearer(bearer: string | null): string | null {
  if (!bearer) return null;
  // Backward-compat: allow a raw iat_ key directly (mcp-remote, Inspector, curl).
  if (bearer.startsWith("iat_")) return bearer;
  return open(bearer, ACCESS_PREFIX);
}

// ---------------------------------------------------------------------------
// In-memory, short-lived state.
// ---------------------------------------------------------------------------

interface AuthCode {
  apiKey: string;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}
const authCodes = new Map<string, AuthCode>();

interface RegisteredClient {
  redirectUris: string[];
}
const clients = new Map<string, RegisteredClient>();

// Pending "Sign in with ImageAT" authorizations, keyed by a ticket handed to the
// consent page. Correlates the browser round-trip back to the original PKCE
// authorize request from the MCP client.
interface PendingTicket {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  state: string;
  expiresAt: number;
}
const tickets = new Map<string, PendingTicket>();

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60; // reported to the client; token itself is stateless

function sweep() {
  const now = Date.now();
  for (const [code, v] of authCodes) if (v.expiresAt < now) authCodes.delete(code);
  for (const [t, v] of tickets) if (v.expiresAt < now) tickets.delete(t);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Public origin of this server, honoring the reverse proxy's forwarded proto/host. */
function publicBaseUrl(req: Request): string {
  const env = process.env.MCP_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function isValidHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Consent page.
// ---------------------------------------------------------------------------

function consentPage(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  error?: string;
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${htmlEscape(value)}" />`;
  const err = params.error
    ? `<p class="err">${htmlEscape(params.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect ImageAT</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #18181b; color: #e4e4e7;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { width: 100%; max-width: 420px; padding: 32px; margin: 16px;
    background: #27272a; border: 1px solid #3f3f46; border-radius: 16px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  p.sub { margin: 0 0 24px; color: #a1a1aa; font-size: 14px; }
  label { display: block; margin: 0 0 8px; font-weight: 600; font-size: 13px; }
  input[type=password], input[type=text] { width: 100%; padding: 12px 14px;
    background: #18181b; border: 1px solid #3f3f46; border-radius: 10px;
    color: #fafafa; font-size: 14px; font-family: ui-monospace, monospace; }
  input:focus { outline: none; border-color: #6366f1; }
  button { width: 100%; margin-top: 20px; padding: 12px 16px; border: 0;
    border-radius: 10px; background: #6366f1; color: #fff; font-size: 15px;
    font-weight: 600; cursor: pointer; }
  button:hover { background: #4f46e5; }
  .hint { margin-top: 16px; font-size: 13px; color: #a1a1aa; }
  .hint a { color: #a5b4fc; }
  .err { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px;
    background: #7f1d1d33; border: 1px solid #b91c1c66; color: #fca5a5; font-size: 13px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/authorize">
    <h1>Connect ImageAT</h1>
    <p class="sub">Paste your ImageAT API key to let this client generate images, video, and edits billed to your account.</p>
    ${err}
    <label for="api_key">ImageAT API key</label>
    <input id="api_key" name="api_key" type="password" placeholder="iat_live_..." autocomplete="off" autofocus required />
    ${hidden("client_id", params.clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("state", params.state)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("scope", params.scope)}
    <button type="submit">Authorize</button>
    <p class="hint">No key yet? Create one on your <a href="https://imageat.com" target="_blank" rel="noopener">ImageAT Projects</a> page (starts with <code>iat_live_</code>).</p>
  </form>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Mount everything on the given Express app.
// ---------------------------------------------------------------------------

export function mountOAuth(app: Express): void {
  // --- Discovery metadata (served at both the bare path and the /mcp suffix
  //     that RFC 9728 uses for resources that have a path component). ---
  const asMetadata = (req: Request, res: Response) => {
    const base = publicBaseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  };
  const resourceMetadata = (req: Request, res: Response) => {
    const base = publicBaseUrl(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  };

  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", asMetadata);
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

  // --- Dynamic client registration (RFC 7591). Public PKCE clients only. ---
  app.post("/register", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    const clientId = `mcp_${crypto.randomBytes(16).toString("hex")}`;
    clients.set(clientId, { redirectUris });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    });
  });

  // --- Authorization endpoint: render the consent page. ---
  app.get("/authorize", (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const responseType = q.response_type;
    const clientId = q.client_id ?? "";
    const redirectUri = q.redirect_uri ?? "";
    const codeChallenge = q.code_challenge ?? "";
    const method = q.code_challenge_method ?? "";
    const state = q.state ?? "";
    const scope = q.scope ?? "mcp";

    if (responseType !== "code") {
      res.status(400).send("unsupported response_type (only 'code')");
      return;
    }
    if (!codeChallenge || method !== "S256") {
      res.status(400).send("PKCE required: code_challenge with code_challenge_method=S256");
      return;
    }
    if (!isValidHttpUrl(redirectUri)) {
      res.status(400).send("invalid redirect_uri");
      return;
    }
    const known = clients.get(clientId);
    if (known && known.redirectUris.length > 0 && !known.redirectUris.includes(redirectUri)) {
      res.status(400).send("redirect_uri not registered for this client");
      return;
    }

    // Manual fallback: paste an iat_live_ key directly (for testing / non-browser
    // clients). The default path is "Sign in with ImageAT".
    if (q.manual === "1") {
      res
        .status(200)
        .type("html")
        .send(consentPage({ clientId, redirectUri, state, codeChallenge, scope }));
      return;
    }

    // Default: hand the browser to the ImageAT consent page (Firebase login +
    // approve). Correlate via a ticket so /connect/complete can finish the flow.
    sweep();
    const ticket = crypto.randomBytes(32).toString("base64url");
    tickets.set(ticket, {
      codeChallenge,
      redirectUri,
      clientId,
      state,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const base = publicBaseUrl(req);
    const consentUrl = new URL(`${IMAGEAT_BASE_URL}/connect/mcp`);
    consentUrl.searchParams.set("ticket", ticket);
    consentUrl.searchParams.set("mcp_callback", `${base}/connect/complete`);
    res.redirect(302, consentUrl.toString());
  });

  // --- Completion: browser returns here after approving on imageat.com. Fetch
  //     the minted key server-to-server, then finish the PKCE authorize flow. ---
  app.get("/connect/complete", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const ticket = q.ticket ?? "";

    sweep();
    const pending = tickets.get(ticket);
    if (!pending) {
      res.status(400).send("Authorization request expired. Please start again from your AI client.");
      return;
    }
    tickets.delete(ticket);

    // User declined on the consent page.
    if (q.denied === "1") {
      const url = new URL(pending.redirectUri);
      url.searchParams.set("error", "access_denied");
      if (pending.state) url.searchParams.set("state", pending.state);
      res.redirect(302, url.toString());
      return;
    }

    if (!INTERNAL_SERVICE_KEY) {
      res.status(500).send("Server misconfigured: INTERNAL_SERVICE_KEY is not set.");
      return;
    }

    try {
      const exRes = await fetch(`${IMAGEAT_BASE_URL}/api/oauth/mcp/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SERVICE_KEY}`,
        },
        body: JSON.stringify({ ticket }),
      });
      if (!exRes.ok) {
        res.status(400).send("Could not complete authorization. Please try again.");
        return;
      }
      const data = (await exRes.json()) as { key?: string };
      if (!data.key || !data.key.startsWith("iat_")) {
        res.status(400).send("Could not complete authorization. Please try again.");
        return;
      }

      const code = crypto.randomBytes(32).toString("base64url");
      authCodes.set(code, {
        apiKey: data.key,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        clientId: pending.clientId,
        expiresAt: Date.now() + CODE_TTL_MS,
      });

      const url = new URL(pending.redirectUri);
      url.searchParams.set("code", code);
      if (pending.state) url.searchParams.set("state", pending.state);
      res.redirect(302, url.toString());
    } catch (err) {
      process.stderr.write(
        `[imageat-mcp-http] exchange error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      res.status(500).send("Could not complete authorization. Please try again.");
    }
  });

  // --- Consent submit: validate key, mint a one-time authorization code. ---
  app.post("/authorize", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const apiKey = (body.api_key ?? "").trim();
    const clientId = body.client_id ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const state = body.state ?? "";
    const codeChallenge = body.code_challenge ?? "";
    const scope = body.scope ?? "mcp";

    if (!isValidHttpUrl(redirectUri) || !codeChallenge) {
      res.status(400).send("invalid authorization request");
      return;
    }
    if (!apiKey.startsWith("iat_")) {
      res
        .status(200)
        .type("html")
        .send(
          consentPage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            scope,
            error: "That doesn't look like an ImageAT key. It should start with iat_live_.",
          }),
        );
      return;
    }

    sweep();
    const code = crypto.randomBytes(32).toString("base64url");
    authCodes.set(code, {
      apiKey,
      codeChallenge,
      redirectUri,
      clientId,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // --- Token endpoint: authorization_code + refresh_token grants. ---
  app.post("/token", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const grantType = body.grant_type;

    const issue = (apiKey: string) => {
      res.json({
        access_token: seal(apiKey, ACCESS_PREFIX),
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: seal(apiKey, REFRESH_PREFIX),
        scope: "mcp",
      });
    };

    if (grantType === "authorization_code") {
      const code = body.code ?? "";
      const verifier = body.code_verifier ?? "";
      const redirectUri = body.redirect_uri ?? "";

      sweep();
      const entry = authCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant", error_description: "code invalid or expired" });
        return;
      }
      authCodes.delete(code); // one-time use
      if (entry.redirectUri !== redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== entry.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      issue(entry.apiKey);
      return;
    }

    if (grantType === "refresh_token") {
      const apiKey = open(body.refresh_token ?? "", REFRESH_PREFIX);
      if (!apiKey) {
        res.status(400).json({ error: "invalid_grant", error_description: "invalid refresh_token" });
        return;
      }
      issue(apiKey);
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });
}
