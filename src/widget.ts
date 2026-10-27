/**
 * Media result view for the ChatGPT app (MCP Apps standard, `text/html;profile=mcp-app`).
 *
 * One self-contained page, no bundler and no external scripts, so the resource CSP
 * only needs the media hosts. It renders the `structuredContent` of the generate/edit
 * tools: an image grid, a video player, or a "rendering" card that polls
 * imageat_check_video_status itself until the video is ready.
 *
 * Talks to the host through `window.openai` when present (ChatGPT) and through the
 * MCP Apps JSON-RPC bridge over postMessage otherwise (Claude and other MCP Apps hosts).
 */

export const MEDIA_WIDGET_URI = "ui://imageat/media-v1.html";

/**
 * Hosts generated media is served from. Outputs are not mirrored to our CDN, so the
 * provider CDNs have to be listed; anything else falls back to an "Open" link.
 */
export const MEDIA_RESOURCE_DOMAINS = [
  "https://cdn.imageat.com",
  "https://fal.media",
  "https://v3.fal.media",
  "https://v3b.fal.media",
  "https://cdn.wiro.ai",
  "https://cdn1.wiro.ai",
  "https://d2ol7oe51mr4n9.cloudfront.net",
];

export const MEDIA_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #ffffff; --surface: #f4f4f5; --border: #e4e4e7; --text: #18181b; --muted: #71717a;
    --accent: #6366f1; --accent-text: #ffffff; --danger: #b91c1c;
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: #18181b; --surface: #27272a; --border: #3f3f46; --text: #fafafa; --muted: #a1a1aa;
    --accent: #818cf8; --accent-text: #18181b; --danger: #fca5a5;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #root { padding: 12px; }
  .grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .grid.single { grid-template-columns: 1fr; }
  .tile { position: relative; border-radius: 12px; overflow: hidden; background: var(--surface);
    border: 1px solid var(--border); }
  .tile img, .tile video { display: block; width: 100%; height: auto; max-height: 520px; object-fit: contain;
    background: repeating-conic-gradient(var(--surface) 0% 25%, var(--bg) 0% 50%) 50% / 16px 16px; }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .meta { color: var(--muted); font-size: 12px; margin-right: auto; }
  button { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text);
    border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .card { display: flex; gap: 12px; align-items: center; padding: 16px; border-radius: 12px;
    background: var(--surface); border: 1px solid var(--border); }
  .spinner { width: 22px; height: 22px; flex: none; border-radius: 50%; border: 3px solid var(--border);
    border-top-color: var(--accent); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .title { font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; }
  .error .title { color: var(--danger); }
  .fallback { padding: 24px 12px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  "use strict";
  var root = document.getElementById("root");
  var openai = window.openai;
  var rpcId = 0;
  var pending = {};
  var current = null;
  var pollTimer = null;
  var pollStarted = 0;
  var POLL_MS = 10000;
  var POLL_LIMIT_MS = 20 * 60 * 1000;

  function setTheme(theme) {
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
  }
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) setTheme("dark");
  if (openai && openai.theme) setTheme(openai.theme);

  // ---- MCP Apps bridge (JSON-RPC over postMessage) -------------------------
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++rpcId;
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error("Host did not respond")); }
      }, 60000);
    });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && pending[msg.id] && !msg.method) {
      var p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || "Request failed"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result" && msg.params) show(msg.params.structuredContent);
    if (msg.method === "ui/notifications/host-context-changed" && msg.params) setTheme(msg.params.theme);
  });

  // ChatGPT pushes updated globals (toolOutput, theme) through this event.
  window.addEventListener("openai:set_globals", function (event) {
    var globals = event.detail && event.detail.globals;
    if (!globals) return;
    if (globals.theme) setTheme(globals.theme);
    if (globals.toolOutput) show(globals.toolOutput);
  });

  function callTool(name, args) {
    if (openai && typeof openai.callTool === "function") return openai.callTool(name, args);
    return rpc("tools/call", { name: name, arguments: args });
  }

  function structuredFrom(result) {
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    var inner = result.result;
    if (typeof inner === "string") { try { inner = JSON.parse(inner); } catch (e) { return null; } }
    return inner && inner.structuredContent ? inner.structuredContent : null;
  }

  function openLink(url) {
    if (openai && typeof openai.openExternal === "function") { openai.openExternal({ href: url }); return; }
    rpc("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
  }

  // ---- Rendering -----------------------------------------------------------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, primary, onClick) {
    var b = el("button", primary ? "primary" : "", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function isVideo(data, url) {
    return data.mediaType === "video" || /\\.(mp4|webm|mov|m4v)(\\?|$)/i.test(url);
  }

  function renderStatusCard(kind, title, sub) {
    root.textContent = "";
    var card = el("div", "card" + (kind === "error" ? " error" : ""));
    if (kind === "pending") card.appendChild(el("div", "spinner"));
    var text = el("div");
    text.appendChild(el("div", "title", title));
    if (sub) text.appendChild(el("div", "sub", sub));
    card.appendChild(text);
    root.appendChild(card);
  }

  function renderMedia(data) {
    root.textContent = "";
    var urls = data.urls || [];
    var grid = el("div", "grid" + (urls.length === 1 ? " single" : ""));
    urls.forEach(function (url) {
      var tile = el("div", "tile");
      var media;
      if (isVideo(data, url)) {
        media = document.createElement("video");
        media.controls = true;
        media.playsInline = true;
        media.preload = "metadata";
      } else {
        media = document.createElement("img");
        media.alt = "Generated image";
        media.loading = "lazy";
        media.addEventListener("click", function () { openLink(url); });
      }
      media.addEventListener("error", function () {
        tile.textContent = "";
        var fb = el("div", "fallback");
        fb.appendChild(el("div", null, "Preview unavailable here."));
        fb.appendChild(button("Open", true, function () { openLink(url); }));
        tile.appendChild(fb);
      });
      media.src = url;
      tile.appendChild(media);
      grid.appendChild(tile);
    });
    root.appendChild(grid);

    var bar = el("div", "bar");
    var meta = [];
    if (urls.length > 1) meta.push(urls.length + " results");
    if (typeof data.creditsUsed === "number") meta.push(data.creditsUsed + " credits");
    bar.appendChild(el("span", "meta", meta.join(" · ")));
    if (urls.length === 1) bar.appendChild(button("Open full size", true, function () { openLink(urls[0]); }));
    bar.appendChild(button("Open in imageat", false, function () { openLink("https://imageat.com/dashboard"); }));
    root.appendChild(bar);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(jobId) {
    stopPolling();
    if (Date.now() - pollStarted > POLL_LIMIT_MS) {
      renderStatusCard("pending", "Still rendering", "This one is taking a while. Ask ChatGPT to check the video status again later.");
      return;
    }
    pollTimer = setTimeout(function () {
      callTool("imageat_check_video_status", { jobId: jobId })
        .then(function (result) {
          var next = structuredFrom(result);
          if (next) show(next, true); else schedulePoll(jobId);
        })
        .catch(function () { schedulePoll(jobId); });
    }, POLL_MS);
  }

  function show(data, fromPoll) {
    if (!data || typeof data !== "object") return;
    current = data;
    if (data.status === "pending") {
      renderStatusCard("pending", "Rendering your video…", "Most videos take 1–5 minutes. You can keep chatting; this card updates when it's ready.");
      if (data.jobId) {
        if (!fromPoll) pollStarted = Date.now();
        schedulePoll(data.jobId);
      }
      return;
    }
    stopPolling();
    if (data.status === "failed") {
      renderStatusCard("error", "Generation failed", data.message || "Something went wrong. Any credits charged for it were refunded.");
      return;
    }
    if (data.urls && data.urls.length) renderMedia(data);
  }

  // ---- Size reporting for MCP Apps hosts ----------------------------------
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () {
      var height = document.documentElement.scrollHeight;
      if (openai && typeof openai.notifyIntrinsicHeight === "function") openai.notifyIntrinsicHeight(height);
      else notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: height });
    }).observe(document.body);
  }

  // ---- Boot ----------------------------------------------------------------
  if (openai) {
    if (openai.toolOutput) show(openai.toolOutput);
  } else {
    rpc("ui/initialize", {
      protocolVersion: "2025-06-18",
      appInfo: { name: "imageat-media", version: "1.0.0" },
      appCapabilities: { availableDisplayModes: ["inline"] },
    })
      .then(function (result) {
        if (result && result.hostContext) setTheme(result.hostContext.theme);
        notify("ui/notifications/initialized", {});
      })
      .catch(function () {});
  }
})();
</script>
</body>
</html>`;
