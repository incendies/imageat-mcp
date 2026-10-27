# @imageat/mcp

Model Context Protocol (MCP) server for **ImageAT**. Gives any MCP client (Claude Desktop, Cursor,
etc.) tools to generate images, generate video, and run ImageAT's image-edit features — billed
against your ImageAT account.

> **Billing.** If you have an active subscription, MCP requests spend your website credits at the
> same rate you'd pay on imageat.com — the same generation costs the same either way. When those
> credits run out (or if you have no subscription), requests bill your prepaid API balance at the
> [API tariff](https://imageat.com/api-pricing). Connecting a client requires one of the two.


## Tools

| Tool | What it does |
|------|--------------|
| `imageat_generate_image` | Text-to-image / image-to-image. Returns CDN image URL(s). |
| `imageat_generate_video` | Text-to-video / image-to-video. Returns a CDN mp4 URL. |
| `imageat_generate_video_task` | Experimental MCP Tasks version with `tasks/get` and `tasks/result`. |
| `imageat_check_video_status` | Checks an asynchronous video generation until it completes. |
| `imageat_ask_gemini_argon` | Ask Google's Gemini 4 Argon (optional image URLs, Google Search / Maps grounding). Returns the text answer. |
| `imageat_check_credits` | Current prepaid API balance (USD). |
| `imageat_game_guide` | Start here for a playable browser game: workflow, runtime rules and the kit API (Phaser 2D / three.js 3D). Free. |
| `imageat_search_game_models` | Search 2,700+ game-ready 3D library models; returns `library_key`s with animations. Free. |
| `imageat_generate_game_asset` | One game asset: sprite, background, texture, logo, or an AI-made 3D `hero_model`. Returns an `asset_id`. |
| `imageat_publish_game` | Checks your game code, bundles it with the engine and assets, and returns a shareable play link. |
| `imageat_update_game` | Publishes new code for one of your games as a new version (same link). Free. |
| `imageat_edit_<feature>` | One tool **per edit feature**, fetched live at startup — e.g. `imageat_edit_remove-background`, `imageat_edit_object-eraser`, `imageat_edit_relight`, `imageat_edit_virtual-try-on`, `imageat_edit_city-teleport`, `imageat_edit_ai-edit-pro`. New features appear automatically. |

If the feature catalog can't be reached at startup, a single generic `imageat_edit_image` tool
(taking a `feature` id parameter) is registered instead, so the server still works.

Tool results include both readable text and typed `structuredContent`. Tool schemas, safety
annotations, and output schemas let agent clients validate calls and distinguish read-only tools.

## Resources and prompts

- `imageat://account/credits` — live prepaid API balance (USD).
- `imageat://edit/features` — live edit-feature catalog.
- `imageat://models/images` and `imageat://models/videos` — media model catalogs.
- `imageat://generations/recent` — ten most recent account generations.
- `create-product-visual` — reusable product-image workflow prompt.
- `animate-image` — reusable image-to-video workflow prompt.
- `create-social-campaign`, `generate-and-upscale`, `create-creative-variants` — campaign workflows.

## Setup

1. Create an API key on your ImageAT **Projects** page (starts with `iat_live_`).
2. Add the server to your MCP client config:

```json
{
  "mcpServers": {
    "imageat": {
      "command": "npx",
      "args": ["-y", "@imageat/mcp"],
      "env": {
        "IMAGEAT_API_KEY": "iat_live_xxxxxxxxxxxx"
      }
    }
  }
}
```

3. Restart the client. The `imageat_*` tools will be available.

### Environment variables

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `IMAGEAT_API_KEY` | yes | — | Your `iat_live_` key. |
| `IMAGEAT_BASE_URL` | no | `https://imageat.com` | The web app that serves the `/api/v1/*` generation endpoints. Point at `http://localhost:3000` for local dev. |

## Remote server (claude.ai, ChatGPT, other web clients)

The `npx` setup above is **stdio** — it works in desktop apps that launch a local process
(Claude Desktop, Cursor, Claude Code). Browser clients like **claude.ai** and **chatgpt.com**
instead connect to a **remote MCP endpoint over Streamable HTTP**.

The same tools are served over HTTP by `dist/http.js`. Each MCP session carries the user's
own API key via the `Authorization: Bearer iat_live_...` header (multi-user), so this is what
you point a hosted connector at.

```bash
# Run the remote server locally against a local ImageAT instance:
IMAGEAT_BASE_URL=http://localhost:3000 PORT=8787 npm run start:http
# MCP endpoint: http://localhost:8787/mcp   ·   health: /health
```

Deploy it (e.g. on Dokploy as `mcp.imageat.com`) with the included `Dockerfile`, then add it as
a custom connector:

- **claude.ai** — Settings → Connectors → Add custom connector → URL `https://mcp.imageat.com/mcp`.
- **ChatGPT** — Connectors / Developer mode → add server URL `https://mcp.imageat.com/mcp`.

Browser clients run the **OAuth** flow: after adding the connector they open a consent page
served by this server where you paste your `iat_live_` key, and the client receives a short-lived
access token bound to it. Non-browser clients (`mcp-remote`, MCP Inspector, curl) can still send
a raw `iat_live_` key directly as `Authorization: Bearer iat_live_...`.

The OAuth layer (`src/oauth.ts`) exposes the
RFC 8414/9728 discovery docs, RFC 7591 dynamic client registration, and PKCE `/authorize` +
`/token`. Expiring access and refresh tokens are encrypted with AES-256-GCM under
`MCP_OAUTH_SECRET`; refresh tokens rotate after use and `/revoke` invalidates issued tokens. OAuth
tokens are bound to their client ID and requested scope. Idle MCP sessions are reclaimed automatically.

| Var | Where | Default | Notes |
|-----|-------|---------|-------|
| `PORT` | remote only | `8787` | HTTP listen port. |
| `IMAGEAT_BASE_URL` | both | `https://imageat.com` | Upstream web app serving `/api/v1/*`. |
| `MCP_OAUTH_SECRET` | remote only | *(random per boot)* | Long random string that encrypts issued OAuth tokens. **Set this in production** or tokens are invalidated on every restart. |
| `MCP_PUBLIC_URL` | remote only | derived from request | Public origin, e.g. `https://mcp.imageat.com`. Only needed if proxy headers are wrong. |
| `MCP_ALLOWED_ORIGINS` | remote only | ChatGPT, Claude, Cursor, VS Code, GitHub, imageat | Comma-separated browser Origin allowlist. Requests without an Origin (normal server-to-server clients) are unaffected. |
| `MCP_SESSION_IDLE_MS` | remote only | `7200000` | Reclaim MCP sessions idle for this many milliseconds. |
| `MCP_MAX_SESSIONS` | remote only | `500` | Reject new sessions with `503`/`Retry-After` after this process reaches capacity. |
| `INTERNAL_SERVICE_KEY` | remote only | — | Shared with the web app. Completes "Sign in with imageat" and signs the ChatGPT profile's calls so they bill website credits. |
| `OPENAI_APPS_CHALLENGE` | remote only | — | Domain verification token from the OpenAI plugin submission, served raw at `/.well-known/openai-apps-challenge`. |

### ChatGPT app profile (`/chatgpt/mcp`)

The published ChatGPT app connects to `https://mcp.imageat.com/chatgpt/mcp`, not `/mcp`. It is a
separate, curated profile (`src/chatgpt.ts`) because OpenAI's directory rules differ from other clients:

- **Fixed tool list.** OpenAI reviews tools and holds new ones for approval, so the profile does not
  build tools from the live edit-feature catalog. Adding a tool here means it waits for review.
- **Strict content filter.** Upstream calls carry `X-Imageat-Surface: chatgpt`, and the web app
  applies the restricted-account filter to every request (`lib/content-restriction.ts`).
- **Website credits for every account.** ChatGPT users can't buy API balance in the app, so calls
  signed with `X-Imageat-Surface-Auth` (HMAC of `INTERNAL_SERVICE_KEY`) spend website credits
  (`lib/api-credit-mode.ts`).
- **No purchase prompts.** Error text never links to pricing or top-ups.
- **Attached photos** arrive through `openai/fileParams` as `{ download_url, file_id }`.
- **Results render in a widget** (`src/widget.ts`, MCP Apps `ui://imageat/media-v1.html`). The widget
  also polls `imageat_check_video_status` itself while a video renders.

The URL cannot be changed after the app is published without contacting OpenAI support.
OAuth accepts ChatGPT's client ID metadata document (`https://chatgpt.com/oauth/client.json`),
returns `iss` on authorization redirects (RFC 9207), and binds tokens to the requested `resource`.

## Local development

```bash
npm install
npm run build

# Inspect the stdio server with the official MCP Inspector against a local ImageAT instance:
IMAGEAT_API_KEY=iat_live_... IMAGEAT_BASE_URL=http://localhost:3000 \
  npx @modelcontextprotocol/inspector node dist/index.js
```

## Security notes

Set a stable, long random `MCP_OAUTH_SECRET` in production. Browser Origins are restricted by
default; add any self-hosted web client to `MCP_ALLOWED_ORIGINS`. Direct server-to-server clients
normally omit the Origin header and continue to work with an `iat_live_` bearer key.
