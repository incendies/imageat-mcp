/**
 * Auth provider abstraction.
 *
 * Phase 1 (now): ApiKeyAuthProvider — sends a static `iat_live_` key as a Bearer token.
 * Phase 2 (later): an OAuthAuthProvider can implement the same interface (browser consent +
 * refresh-token rotation) without touching client.ts, the tools, or the /v1 routes.
 */
export interface AuthProvider {
  /** Returns the Authorization header value, e.g. "Bearer iat_live_...". */
  authorizationHeader(): Promise<string>;
}

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly apiKey: string) {}

  async authorizationHeader(): Promise<string> {
    return `Bearer ${this.apiKey}`;
  }
}
