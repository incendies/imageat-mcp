# @imageat/mcp

Model Context Protocol (MCP) server for **ImageAT**. Gives any MCP client (Claude Desktop, Cursor,
etc.) tools to generate images, generate video, and run ImageAT's image-edit features — billed
against your ImageAT account credits.

## Tools

| Tool | What it does |
|------|--------------|
| `imageat_generate_image` | Text-to-image / image-to-image. Returns CDN image URL(s). |
| `imageat_generate_video` | Text-to-video / image-to-video. Returns a CDN mp4 URL. |
| `imageat_check_credits` | Current credit balance. |
| `imageat_edit_<feature>` | One tool **per edit feature**, fetched live at startup — e.g. `imageat_edit_remove-background`, `imageat_edit_object-eraser`, `imageat_edit_relight`, `imageat_edit_virtual-try-on`, `imageat_edit_city-teleport`, `imageat_edit_ai-edit-pro`. New features appear automatically. |

If the feature catalog can't be reached at startup, a single generic `imageat_edit_image` tool
(taking a `feature` id parameter) is registered instead, so the server still works.

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

The OAuth layer (`src/oauth.ts`) is a minimal, stateless authorization server: it exposes the
RFC 8414/9728 discovery docs, RFC 7591 dynamic client registration, and PKCE `/authorize` +
`/token`. Access/refresh tokens are the API key encrypted (AES-256-GCM) under `MCP_OAUTH_SECRET`,
so there is no session store.

| Var | Where | Default | Notes |
|-----|-------|---------|-------|
| `PORT` | remote only | `8787` | HTTP listen port. |
| `IMAGEAT_BASE_URL` | both | `https://imageat.com` | Upstream web app serving `/api/v1/*`. |
| `MCP_OAUTH_SECRET` | remote only | *(random per boot)* | Long random string that encrypts issued OAuth tokens. **Set this in production** or tokens are invalidated on every restart. |
| `MCP_PUBLIC_URL` | remote only | derived from request | Public origin, e.g. `https://mcp.imageat.com`. Only needed if proxy headers are wrong. |

## Local development

```bash
npm install
npm run build

# Inspect the stdio server with the official MCP Inspector against a local ImageAT instance:
IMAGEAT_API_KEY=iat_live_... IMAGEAT_BASE_URL=http://localhost:3000 \
  npx @modelcontextprotocol/inspector node dist/index.js
```

## Auth roadmap

Today the server authenticates with a static `iat_live_` API key (the remote server reads it
per-session from the `Authorization` header). Auth is isolated behind an `AuthProvider` interface
(`src/auth.ts`), so a future "Sign in with ImageAT" OAuth provider can be dropped in without
changing the tools, the HTTP client, or the backend `/v1` routes.
