import crypto from "node:crypto";

export type OAuthTokenKind = "access" | "refresh";

export interface OAuthTokenClaims {
  apiKey: string;
  kind: OAuthTokenKind;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
  clientId?: string;
  scope?: string;
  /** RFC 8707 resource the token was issued for (the MCP endpoint URL). */
  resource?: string;
}

const PREFIXES: Record<OAuthTokenKind, string> = { access: "iao_", refresh: "iar_" };

function keyFromSecret(secret: string) {
  return crypto.scryptSync(secret, "imageat-mcp-oauth-v2", 32);
}

export function sealOAuthToken(apiKey: string, kind: OAuthTokenKind, ttlSeconds: number, secret: string, binding: { clientId?: string; scope?: string; resource?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: OAuthTokenClaims = {
    apiKey,
    kind,
    issuedAt: now,
    expiresAt: now + ttlSeconds,
    tokenId: crypto.randomBytes(16).toString("base64url"),
    ...binding,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIXES[kind] + Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function openOAuthToken(token: string, kind: OAuthTokenKind, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): OAuthTokenClaims | null {
  const prefix = PREFIXES[kind];
  if (!token.startsWith(prefix)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length), "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const claims = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as OAuthTokenClaims;
    if (!claims || claims.kind !== kind || !claims.apiKey?.startsWith("iat_") || !claims.tokenId) return null;
    if (!Number.isFinite(claims.issuedAt) || !Number.isFinite(claims.expiresAt) || claims.expiresAt <= nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}
