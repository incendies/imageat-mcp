import type { AuthProvider } from "./auth.js";
import type { Config } from "./config.js";

/** Raised when the ImageAT API returns a non-2xx response, with a human-readable message. */
export class ImageATError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ImageATError";
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

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ImageATError(
        `Could not reach ImageAT at ${this.config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
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

    if (!res.ok) {
      throw new ImageATError(messageForStatus(res.status, parsed), res.status, parsed);
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

function messageForStatus(status: number, body: unknown): string {
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
      return `Insufficient credits (402)${extra}. Top up at imageat.com.`;
    }
    case 429:
      return `Rate limited (429). ${detailStr || "Slow down and retry shortly."}`;
    default:
      return `ImageAT API error ${status}${detailStr ? `: ${detailStr}` : ""}`;
  }
}
