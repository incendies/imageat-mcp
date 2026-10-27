import crypto from "node:crypto";
import type { AuthProvider } from "./auth.js";
import type { Config } from "./config.js";

export interface ImageATStructuredError {
  code: string;
  message: string;
  providerStatus?: number;
  providerMessage?: string;
  requestId?: string;
  retryable?: boolean;
}

/** Raised when the ImageAT API returns a non-2xx response, with a human-readable message. */
export class ImageATError extends Error {
  readonly requestId?: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly providerMessage?: string;

  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    meta?: { requestId?: string; code?: string; retryable?: boolean; providerMessage?: string },
  ) {
    super(message);
    this.name = "ImageATError";
    this.requestId = meta?.requestId;
    this.code = meta?.code ?? errorCodeForStatus(status);
    this.retryable = meta?.retryable ?? isRetryableStatus(status);
    this.providerMessage = meta?.providerMessage;
  }

  toStructuredError(): ImageATStructuredError {
    return {
      code: this.code,
      message: this.message,
      providerStatus: this.status || undefined,
      providerMessage: this.providerMessage,
      requestId: this.requestId,
      retryable: this.retryable,
    };
  }
}

function headerRequestId(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function errorCodeForStatus(status: number): string {
  switch (status) {
    case 0:
      return "IMAGE_GENERATION_NETWORK_ERROR";
    case 401:
      return "IMAGE_GENERATION_AUTH_ERROR";
    case 402:
      return "IMAGE_GENERATION_INSUFFICIENT_CREDITS";
    case 422:
      return "IMAGE_GENERATION_VALIDATION_ERROR";
    case 429:
      return "IMAGE_GENERATION_RATE_LIMITED";
    default:
      return status >= 500
        ? "IMAGE_GENERATION_UPSTREAM_ERROR"
        : "IMAGE_GENERATION_CLIENT_ERROR";
  }
}

/**
 * Thin HTTP client for the ImageAT public API.
 * Auth is delegated to an AuthProvider so Phase 2 (OAuth) is a drop-in swap.
 */
export class ImageATClient {
  constructor(
    private readonly config: Config,
    private readonly auth: AuthProvider,
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: await this.auth.authorizationHeader(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.config.surface) {
      headers["X-Imageat-Surface"] = this.config.surface;
      const proof = surfaceAuthToken(this.config.surface);
      if (proof) headers["X-Imageat-Surface-Auth"] = proof;
    }

    let res: Response;
    // A video start request should return a provider task id quickly. Without an
    // explicit deadline a stalled app/upstream connection can outlive the MCP
    // client's own tool timeout, leaving the caller with no actionable error.
    const timeoutMs = path === "/api/v1/edit/features"
      ? 3_500
      : method === "POST" && path === "/api/v1/videos"
        ? 45_000
        // High-thinking, search-grounded LLM answers can run past two minutes.
        : path === "/api/v1/chat/completions" || path === "/api/v1/games/assets"
          ? 300_000
          : 120_000;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new ImageATError(
        timedOut
          ? `ImageAT did not accept the video request within ${Math.round(timeoutMs / 1000)} seconds. No provider task id was returned; retrying is safe after checking the ImageAT/Wiro task history.`
          : `Could not reach ImageAT at ${this.config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
      );
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    const requestId = headerRequestId(res.headers);

    if (!res.ok) {
      const providerMessage = extractProviderMessage(parsed);
      throw new ImageATError(messageForStatus(res.status, parsed, this.config.surface), res.status, parsed, {
        requestId,
        providerMessage,
      });
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

/**
 * Proof that a call came through this server's ChatGPT profile, which lets the web app
 * bill website credits for it (lib/api-credit-mode.ts isVerifiedChatGPTSurface).
 */
function surfaceAuthToken(surface: string): string | null {
  const secret = process.env.INTERNAL_SERVICE_KEY?.trim();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`imageat-surface:${surface}`).digest("hex");
}

function extractProviderMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body.length > 0 ? body : undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["details", "message", "error"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function messageForStatus(status: number, body: unknown, surface?: Config["surface"]): string {
  const detail =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).details ??
          (body as Record<string, unknown>).message ??
          (body as Record<string, unknown>).error)
      : body;
  const detailStr = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "";

  switch (status) {
    case 401:
      return "Authentication failed (401). Check that IMAGEAT_API_KEY is a valid, non-revoked iat_live_ key.";
    case 402: {
      const b = (body ?? {}) as Record<string, unknown>;
      const balance = b.balance ?? b.have;
      const required = b.required ?? b.need;
      const extra =
        balance !== undefined || required !== undefined
          ? ` (balance: ${balance ?? "?"}, required: ${required ?? "?"})`
          : "";
      // ChatGPT apps may not prompt purchases, so that surface gets the bare fact.
      if (surface === "chatgpt") return `Your imageat credit balance is too low for this request${extra}.`;
      return `Insufficient credits (402)${extra}. Top up at imageat.com.`;
    }
    case 429:
      return `Rate limited (429). ${detailStr || "Slow down and retry shortly."}`;
    default:
      return `ImageAT API error ${status}${detailStr ? `: ${detailStr}` : ""}`;
  }
}
