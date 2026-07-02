/** Runtime configuration, read from environment variables. */
export interface Config {
  apiKey: string;
  baseUrl: string;
}

export function loadConfig(): Config {
  const apiKey = process.env.IMAGEAT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "IMAGEAT_API_KEY is required. Create a key on your ImageAT Projects page (starts with iat_live_) " +
        "and set it in the MCP server env, e.g. \"env\": { \"IMAGEAT_API_KEY\": \"iat_live_...\" }.",
    );
  }

  return { apiKey, baseUrl: resolveBaseUrl() };
}

/**
 * The web app that serves the /api/v1/* generation endpoints. Used by both the
 * stdio and remote (HTTP) entries; the remote entry takes the API key per-request
 * instead of from the environment, so it only needs the base URL.
 */
export function resolveBaseUrl(): string {
  // The MCP tools call the generation endpoints served by the main web app
  // (imageat.com/api/v1/*), not the workflow API on api.imageat.com.
  return (process.env.IMAGEAT_BASE_URL?.trim() || "https://imageat.com").replace(/\/+$/, "");
}
