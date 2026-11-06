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
 * restart — the only in-memory state is short-lived authorization codes. Dynamically
 * registered client IDs are self-describing too (redirect URIs signed into the ID), so a
 * client registered once (Gemini registers once per app) keeps working across deploys.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 resource metadata
 *   GET  /.well-known/oauth-authorization-server[/mcp] RFC 8414 AS metadata
 *   POST /register                                     RFC 7591 dynamic registration
 *   (client_id may also be an https URL: a client ID metadata document, CIMD)
 *   GET  /authorize                                    consent page (paste API key)
 *   POST /authorize                                    consent submit -> auth code
 *   POST /token                                        code/refresh -> access token
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { resolveBaseUrl } from "./config.js";
import { openOAuthToken, sealOAuthToken } from "./oauth-token.js";

// Upstream ImageAT web app that hosts the "Sign in with ImageAT" consent page
// and the mint/exchange endpoints.
const IMAGEAT_BASE_URL = resolveBaseUrl();
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY?.trim();

// ---------------------------------------------------------------------------
// Token crypto — the API key sealed into an opaque, self-contained token.
// ---------------------------------------------------------------------------

const secretSource =
  process.env.MCP_OAUTH_SECRET?.trim() || crypto.randomBytes(32).toString("hex");
if (!process.env.MCP_OAUTH_SECRET?.trim()) {
  process.stderr.write(
    "[imageat-mcp-http] WARNING: MCP_OAUTH_SECRET not set — using an ephemeral secret. " +
      "Issued tokens will be invalidated on restart. Set MCP_OAUTH_SECRET to a long random string.\n",
  );
}
/**
 * Resolve an incoming Bearer value to the raw ImageAT API key, or null.
 *
 * `endpointPath` is the MCP endpoint being called ("/mcp" or "/chatgpt/mcp"). A token
 * whose RFC 8707 resource names the other endpoint is rejected (audience check); tokens
 * from before resource binding, or bound to the bare origin, are accepted anywhere.
 */
export function apiKeyFromBearer(bearer: string | null, endpointPath?: string): string | null {
  if (!bearer) return null;
  // Backward-compat: allow a raw iat_ key directly (mcp-remote, Inspector, curl).
  if (bearer.startsWith("iat_")) return bearer;
  const claims = openOAuthToken(bearer, "access", secretSource);
  if (!claims || revokedTokens.has(claims.tokenId)) return null;
  if (endpointPath && claims.resource && resourcePath(claims.resource) && resourcePath(claims.resource) !== endpointPath) {
    return null;
  }
  return claims.apiKey;
}

/** Path of a resource URL without trailing slashes ("" for a bare origin or a bad URL). */
function resourcePath(resource: string): string {
  try {
    return new URL(resource).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// In-memory, short-lived state.
// ---------------------------------------------------------------------------

interface AuthCode {
  apiKey: string;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}
const authCodes = new Map<string, AuthCode>();

interface RegisteredClient {
  redirectUris: string[];
}

// Public OAuth client used by the OpenAI plugin submission portal. `provided`
// mode expects a conventional, pre-registered client ID rather than ChatGPT's
// CIMD URL. RFC 9207 `iss` support lets ChatGPT use this stable callback.
const predefinedClients = new Map<string, RegisteredClient>([
  [
    "imageat-chatgpt-public",
    { redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] },
  ],
]);

/**
 * Pre-registered client for the Google Connected Console ("Pre-registered" auth option),
 * in case DCR is not used. Google's callback carries a per-app path, so it is matched
 * against Google's documented redirect patterns rather than a fixed list.
 */
const GOOGLE_CLIENT_ID = "imageat-google";

/** Google's OAuth redirect hosts (prod, sandbox, test) with the /r/* and /a/* paths. */
function isGoogleRedirectUri(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === "https:" &&
      /^oauth-redirect(-sandbox|-test)?\.googleusercontent\.com$/.test(url.hostname) &&
      /^\/[ra]\/[^/]/.test(url.pathname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// --- Stateless dynamic registration: the redirect URIs travel inside the client_id,
//     signed so they can't be swapped. ---
const DCR_PREFIX = "mcpd_";
const DCR_MAX_URIS = 5;
const DCR_MAX_URI_LENGTH = 1024;

function dcrSignature(payload: string): string {
  return crypto.createHmac("sha256", `${secretSource}:dcr`).update(payload).digest("base64url").slice(0, 32);
}

function encodeDcrClientId(redirectUris: string[]): string {
  const payload = Buffer.from(JSON.stringify(redirectUris)).toString("base64url");
  return `${DCR_PREFIX}${payload}.${dcrSignature(payload)}`;
}

function decodeDcrClientId(clientId: string): RegisteredClient | null {
  if (!clientId.startsWith(DCR_PREFIX)) return null;
  const [payload, sig] = clientId.slice(DCR_PREFIX.length).split(".");
  if (!payload || !sig) return null;
  const expected = dcrSignature(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const uris = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(uris) || !uris.every((u) => typeof u === "string")) return null;
    return { redirectUris: uris as string[] };
  } catch {
    return null;
  }
}

/** Whether `redirectUri` is allowed for a non-CIMD client, or null for an unknown client. */
function clientAllowsRedirect(clientId: string, redirectUri: string): boolean | null {
  if (clientId === GOOGLE_CLIENT_ID) return isGoogleRedirectUri(redirectUri);
  const known = predefinedClients.get(clientId) ?? decodeDcrClientId(clientId);
  if (!known) return null;
  return known.redirectUris.includes(redirectUri);
}

// Pending "Sign in with ImageAT" authorizations, keyed by a ticket handed to the
// consent page. Correlates the browser round-trip back to the original PKCE
// authorize request from the MCP client.
interface PendingTicket {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  state: string;
  scope: string;
  resource?: string;
  /** Issuer to echo as `iss` on the redirect back to the client (RFC 9207). */
  issuer: string;
  /** Random value also set as a cookie on the browser that started /authorize. */
  browserBinding: string;
  expiresAt: number;
}
const tickets = new Map<string, PendingTicket>();

/**
 * /connect/complete must run in the browser that started /authorize. Without this, an
 * attacker could start a flow in their own AI client, send the consent link (with their
 * ticket) to a victim, and after the victim approved, finish the ticket themselves and
 * link the victim's account to the attacker's client.
 */
function bindingCookieName(ticket: string): string {
  return `iat_mcp_${crypto.createHash("sha256").update(ticket).digest("hex").slice(0, 16)}`;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Host the authorization code is sent to, shown on the consent page. */
function redirectHost(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : `${u.protocol}//`;
  } catch {
    return "";
  }
}

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
/**
 * Persistent linking (Gemini): Google keeps one refresh token per link and never expects
 * it to change, so it must outlive any realistic link. Unlinking revokes the underlying
 * API key upstream (see /revoke), and deleting that key on the Projects page ends it too.
 */
const PERSISTENT_REFRESH_TTL_S = 10 * 365 * 24 * 60 * 60;
const usedRefreshTokens = new Map<string, number>();
const revokedTokens = new Map<string, number>();

function sweep() {
  const now = Date.now();
  for (const [code, v] of authCodes) if (v.expiresAt < now) authCodes.delete(code);
  for (const [t, v] of tickets) if (v.expiresAt < now) tickets.delete(t);
  for (const [id, expiresAt] of usedRefreshTokens) if (expiresAt < Math.floor(now / 1000)) usedRefreshTokens.delete(id);
  for (const [id, expiresAt] of revokedTokens) if (expiresAt < Math.floor(now / 1000)) revokedTokens.delete(id);
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

function isValidRedirectUri(u: string): boolean {
  try {
    const parsed = new URL(u);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "cursor:"
    );
  } catch {
    return false;
  }
}

/** Projects-page label for the minted API key, inferred from the OAuth redirect. */
function keyNameFromRedirectUri(redirectUri: string): string {
  // Match on the exact host: a substring match labelled any registered redirect that
  // merely contained "claude"/"chatgpt" (e.g. claude.attacker.tld) as that vendor on
  // the consent page.
  const lower = redirectUri.toLowerCase();
  if (lower.startsWith("cursor:")) return "Cursor (MCP)";
  let host = "";
  try {
    host = new URL(redirectUri).hostname.toLowerCase();
  } catch {
    return "MCP";
  }
  const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (isHost("anysphere.co") || isHost("cursor.com") || isHost("cursor.sh")) return "Cursor (MCP)";
  if (isHost("openai.com") || isHost("chatgpt.com")) return "ChatGPT (MCP)";
  if (isHost("anthropic.com") || isHost("claude.ai") || isHost("claude.com")) return "Claude (MCP)";
  if (isGoogleRedirectUri(redirectUri)) return "Gemini (MCP)";
  return "MCP";
}

/** Permanently revoke an MCP-minted API key on the web app. Best effort, logged on failure. */
async function revokeApiKeyUpstream(apiKey: string): Promise<void> {
  if (!INTERNAL_SERVICE_KEY) {
    process.stderr.write("[imageat-mcp-http] revoke: INTERNAL_SERVICE_KEY not set, API key left active\n");
    return;
  }
  try {
    const r = await fetch(`${IMAGEAT_BASE_URL}/api/oauth/mcp/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${INTERNAL_SERVICE_KEY}` },
      body: JSON.stringify({ key: apiKey }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) process.stderr.write(`[imageat-mcp-http] revoke: upstream returned ${r.status}\n`);
  } catch (err) {
    process.stderr.write(`[imageat-mcp-http] revoke failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Append the authorization response parameters, including `iss` (RFC 9207). ChatGPT
 * relies on `iss` to use its stable redirect URI, and it is harmless for other clients.
 */
function redirectWith(redirectUri: string, issuer: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Client ID metadata documents (CIMD). ChatGPT identifies itself with an https URL
// as its client_id (e.g. https://chatgpt.com/oauth/client.json) instead of
// registering, so nothing has to survive a restart.
// ---------------------------------------------------------------------------

const CIMD_TTL_MS = 60 * 60 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;
const cimdCache = new Map<string, { redirectUris: string[]; expiresAt: number }>();

function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    // https only, a real hostname (no IP literals or localhost: we fetch this server-side),
    // and a path, as the CIMD draft requires.
    return (
      url.protocol === "https:" &&
      !/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i.test(url.hostname) &&
      url.hostname.includes(".") &&
      url.pathname.length > 1 &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function loadCimdClient(clientId: string): Promise<{ redirectUris: string[] } | null> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  try {
    const res = await fetch(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > CIMD_MAX_BYTES) return null;
    const doc = JSON.parse(text) as { client_id?: unknown; redirect_uris?: unknown };
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter((u): u is string => typeof u === "string");
    const entry = { redirectUris, expiresAt: Date.now() + CIMD_TTL_MS };
    cimdCache.set(clientId, entry);
    return entry;
  } catch {
    return null;
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
  resource?: string;
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
<title>Connect imageat</title>
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
    <h1>Connect imageat</h1>
    <p class="sub">Paste your imageat API key to let this client generate images, video, and edits billed to your account.</p>
    ${err}
    <label for="api_key">imageat API key</label>
    <input id="api_key" name="api_key" type="password" placeholder="iat_live_..." autocomplete="off" autofocus required />
    ${hidden("client_id", params.clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("state", params.state)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("scope", params.scope)}
    ${params.resource ? hidden("resource", params.resource) : ""}
    <button type="submit">Authorize</button>
    <p class="hint">No key yet? Create one on your <a href="https://imageat.com" target="_blank" rel="noopener">imageat Projects</a> page (starts with <code>iat_live_</code>).</p>
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
      revocation_endpoint: `${base}/revoke`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["mcp", "images:generate", "videos:generate", "edits:run", "credits:read"],
    });
  };
  const resourceMetadata = (path: string) => (req: Request, res: Response) => {
    const base = publicBaseUrl(req);
    res.json({
      resource: `${base}${path}`,
      authorization_servers: [base],
      scopes_supported: ["mcp", "images:generate", "videos:generate", "edits:run", "credits:read"],
      bearer_methods_supported: ["header"],
    });
  };

  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", asMetadata);
  app.get("/.well-known/oauth-authorization-server/chatgpt/mcp", asMetadata);
  app.get("/.well-known/oauth-authorization-server/google/mcp", asMetadata);
  app.get("/.well-known/oauth-protected-resource", resourceMetadata("/mcp"));
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata("/mcp"));
  app.get("/.well-known/oauth-protected-resource/chatgpt/mcp", resourceMetadata("/chatgpt/mcp"));
  app.get("/.well-known/oauth-protected-resource/google/mcp", resourceMetadata("/google/mcp"));

  // --- Dynamic client registration (RFC 7591). Public PKCE clients only. ---
  app.post("/register", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > DCR_MAX_URIS ||
      redirectUris.some((u) => u.length > DCR_MAX_URI_LENGTH || !isValidRedirectUri(u))
    ) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must list 1–5 valid URIs" });
      return;
    }
    const clientId = encodeDcrClientId(redirectUris);
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
  app.get("/authorize", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const responseType = q.response_type;
    const clientId = q.client_id ?? "";
    const redirectUri = q.redirect_uri ?? "";
    const codeChallenge = q.code_challenge ?? "";
    const method = q.code_challenge_method ?? "";
    const state = q.state ?? "";
    const scope = q.scope ?? "mcp";
    const resource = q.resource?.trim() || undefined;

    if (responseType !== "code") {
      res.status(400).send("unsupported response_type (only 'code')");
      return;
    }
    if (!codeChallenge || method !== "S256") {
      res.status(400).send("PKCE required: code_challenge with code_challenge_method=S256");
      return;
    }
    if (!isValidRedirectUri(redirectUri)) {
      res.status(400).send("invalid redirect_uri");
      return;
    }
    if (isCimdClientId(clientId)) {
      const doc = await loadCimdClient(clientId);
      if (!doc) {
        res.status(400).send("could not load the client metadata document for this client_id");
        return;
      }
      if (!doc.redirectUris.includes(redirectUri)) {
        res.status(400).send("redirect_uri is not listed in the client metadata document");
        return;
      }
    } else {
      const allowed = clientAllowsRedirect(clientId, redirectUri);
      if (allowed === null) {
        res.status(400).send("unknown client_id");
        return;
      }
      if (!allowed) {
        res.status(400).send("redirect_uri not registered for this client");
        return;
      }
    }

    // Manual fallback: paste an iat_live_ key directly (for testing / non-browser
    // clients). The default path is "Sign in with ImageAT".
    if (q.manual === "1") {
      res
        .status(200)
        .type("html")
        .send(consentPage({ clientId, redirectUri, state, codeChallenge, scope, resource }));
      return;
    }

    // Default: hand the browser to the ImageAT consent page (Firebase login +
    // approve). Correlate via a ticket so /connect/complete can finish the flow.
    sweep();
    const ticket = crypto.randomBytes(32).toString("base64url");
    const browserBinding = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, {
      browserBinding,
      codeChallenge,
      redirectUri,
      clientId,
      state,
      scope,
      resource,
      issuer: publicBaseUrl(req),
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const base = publicBaseUrl(req);
    const consentUrl = new URL(`${IMAGEAT_BASE_URL}/connect/mcp`);
    consentUrl.searchParams.set("ticket", ticket);
    consentUrl.searchParams.set("mcp_callback", `${base}/connect/complete`);
    consentUrl.searchParams.set("client", keyNameFromRedirectUri(redirectUri));
    consentUrl.searchParams.set("redirect_host", redirectHost(redirectUri));
    res.cookie(bindingCookieName(ticket), browserBinding, {
      httpOnly: true,
      secure: base.startsWith("https://"),
      sameSite: "lax",
      maxAge: CODE_TTL_MS,
      path: "/",
    });
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
    res.clearCookie(bindingCookieName(ticket), { path: "/" });

    const binding = readCookie(req, bindingCookieName(ticket));
    if (
      !binding ||
      binding.length !== pending.browserBinding.length ||
      !crypto.timingSafeEqual(Buffer.from(binding), Buffer.from(pending.browserBinding))
    ) {
      res
        .status(400)
        .send("This authorization was started in a different browser. Please start again from your AI client.");
      return;
    }

    // User declined on the consent page.
    if (q.denied === "1") {
      res.redirect(302, redirectWith(pending.redirectUri, pending.issuer, { error: "access_denied", state: pending.state }));
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
        scope: pending.scope,
        resource: pending.resource,
        expiresAt: Date.now() + CODE_TTL_MS,
      });

      res.redirect(302, redirectWith(pending.redirectUri, pending.issuer, { code, state: pending.state }));
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
    const resource = body.resource?.trim() || undefined;

    if (!isValidRedirectUri(redirectUri) || !codeChallenge) {
      res.status(400).send("invalid authorization request");
      return;
    }
    // Same client/redirect check as GET /authorize (CIMD clients are URL ids, validated there).
    if (!/^https:\/\//.test(clientId) && clientAllowsRedirect(clientId, redirectUri) !== true) {
      res.status(400).send("redirect_uri not registered for this client");
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
            resource,
            error: "That doesn't look like an imageat key. It should start with iat_live_.",
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
      scope,
      resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    res.redirect(302, redirectWith(redirectUri, publicBaseUrl(req), { code, state }));
  });

  // --- Token endpoint: authorization_code + refresh_token grants. ---
  app.post("/token", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const grantType = body.grant_type;

    const issue = (
      apiKey: string,
      clientId: string,
      scope: string,
      resource?: string,
      persistent?: { refreshToken?: string },
    ) => {
      const binding = { clientId, scope, ...(resource ? { resource } : {}), ...(persistent ? { persistent: true } : {}) };
      res.json({
        access_token: sealOAuthToken(apiKey, "access", ACCESS_TTL_S, secretSource, binding),
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
        // Persistent links keep the refresh token they were given; others rotate it.
        refresh_token:
          persistent?.refreshToken ??
          sealOAuthToken(apiKey, "refresh", persistent ? PERSISTENT_REFRESH_TTL_S : REFRESH_TTL_S, secretSource, binding),
        scope,
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
      if (body.client_id && body.client_id !== entry.clientId) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== entry.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      issue(
        entry.apiKey,
        entry.clientId,
        entry.scope,
        entry.resource ?? (body.resource?.trim() || undefined),
        isGoogleRedirectUri(entry.redirectUri) ? {} : undefined,
      );
      return;
    }

    if (grantType === "refresh_token") {
      sweep();
      const claims = openOAuthToken(body.refresh_token ?? "", "refresh", secretSource);
      if (!claims || usedRefreshTokens.has(claims.tokenId) || revokedTokens.has(claims.tokenId) || (body.client_id && claims.clientId && body.client_id !== claims.clientId)) {
        res.status(400).json({ error: "invalid_grant", error_description: "invalid refresh_token" });
        return;
      }
      if (claims.persistent) {
        issue(claims.apiKey, claims.clientId || body.client_id || "", claims.scope || "mcp", claims.resource, {
          refreshToken: body.refresh_token,
        });
        return;
      }
      usedRefreshTokens.set(claims.tokenId, claims.expiresAt);
      issue(claims.apiKey, claims.clientId || body.client_id || "", claims.scope || "mcp", claims.resource);
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.post("/revoke", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const token = body.token ?? "";
    const claims = openOAuthToken(token, token.startsWith("iar_") ? "refresh" : "access", secretSource);
    if (claims && (!body.client_id || !claims.clientId || body.client_id === claims.clientId)) {
      revokedTokens.set(claims.tokenId, claims.expiresAt);
      if (claims.kind === "refresh") usedRefreshTokens.set(claims.tokenId, claims.expiresAt);
      // The in-memory list is lost on restart, and a persistent link's tokens live for
      // years, so unlinking also revokes the minted API key upstream: every token sealed
      // around it stops working for good.
      if (claims.persistent) await revokeApiKeyUpstream(claims.apiKey);
    }
    res.status(200).send();
  });
}
