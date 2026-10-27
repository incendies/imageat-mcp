import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { ImageATClient, ImageATError, type ImageATStructuredError } from "./client.js";

// Read from package.json (one level above dist/ in both the npm package and the Docker image) so the
// version clients and /health see can't drift from the published one again.
export const SERVER_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
})();
const FEATURE_CACHE_MS = 5 * 60 * 1000;
let featureCache: { features: EditFeature[]; expiresAt: number } | null = null;
const taskStore = new InMemoryTaskStore();
const taskMessageQueue = new InMemoryTaskMessageQueue();

interface EditFeature {
  id: string;
  name: string;
  credits: number;
  endpoint?: string;
}

/** Wrap a tool handler so API errors become readable MCP error results instead of crashes. */
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function structuredFail(error: ImageATStructuredError) {
  return fail(JSON.stringify({ error }, null, 2));
}

function logGeneration(
  log: (msg: string) => void,
  event: "starting" | "success" | "failed",
  meta: Record<string, unknown>,
) {
  log(`ImageAT generation ${event}: ${JSON.stringify(meta)}`);
}

export function extractUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof data.url === "string") urls.push(data.url);
  if (Array.isArray(data.urls)) for (const u of data.urls) if (typeof u === "string") urls.push(u);
  // `url` is normally also urls[0]; list each output once.
  return [...new Set(urls)];
}

function generationStructured(data: Record<string, unknown>) {
  const credits = data.creditsUsed ?? data.credits_used;
  return {
    status: typeof data.status === "string" ? data.status : "completed",
    urls: extractUrls(data),
    ...(typeof credits === "number" ? { creditsUsed: credits } : {}),
    ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
    ...(typeof data.generationId === "string" ? { generationId: data.generationId } : {}),
  };
}

const generationOutputSchema = {
  status: z.string(),
  urls: z.array(z.string()),
  creditsUsed: z.number().optional(),
  taskId: z.string().optional(),
  generationId: z.string().optional(),
};

export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

function summarizeOutput(data: Record<string, unknown>): string {
  const urls = extractUrls(data);
  const credits = data.creditsUsed ?? data.credits_used;
  const creditLine = credits !== undefined ? `\nCredits used: ${credits}` : "";
  if (urls.length === 0) return `Done.${creditLine}\n${JSON.stringify(data)}`;
  // Render each URL as a markdown image (or plain link for video) so clients that
  // format tool-result text show a preview; clients that don't still get a link.
  const lines = urls.map((u) => (isVideoUrl(u) ? `[Video](${u})` : `![result](${u})`));
  return `${lines.join("\n")}${creditLine}`;
}

/** POST /api/v1/videos returns either a finished url (sync models) or a task id (async). */
export interface VideoStartResponse {
  status?: string;
  url?: string;
  taskId?: string;
  generationId?: string | null;
}

export interface VideoStatusResponse {
  status: "pending" | "completed" | "failed";
  url?: string;
  /** Every output of the task — midjourney-v8 returns 4 clips per run. */
  urls?: string[];
  error?: string;
}

/** All finished video URLs from a status response (falls back to the single `url`). */
export function videoStatusUrls(data: VideoStatusResponse): string[] {
  const urls = Array.isArray(data.urls) ? data.urls.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
  return urls.length > 0 ? urls : data.url ? [data.url] : [];
}

/**
 * Render a finished video so clients that format tool-result text show something
 * useful. Markdown link + the bare URL, since most clients won't inline-play mp4
 * but every client can surface a clickable link, and the bare URL survives
 * clients that strip markdown entirely.
 */
function renderVideo(url: string): string {
  return `Video ready:\n\n[▶ Watch / download the video](${url})\n\n${url}`;
}

function renderVideos(urls: string[]): string {
  if (urls.length <= 1) return renderVideo(urls[0] ?? "");
  return `${urls.length} videos ready:\n\n${urls.map((u, i) => `[▶ Video ${i + 1}](${u})\n${u}`).join("\n\n")}`;
}

export function pollOnce(
  client: ImageATClient,
  taskId: string,
  generationId: string | null,
): Promise<VideoStatusResponse> {
  const params = new URLSearchParams({ taskId });
  if (generationId) params.set("generationId", generationId);
  return client.get<VideoStatusResponse>(`/api/v1/videos/status?${params.toString()}`);
}

/**
 * Build a tool result that includes the generated image inline (as an MCP image
 * content block) so the client can render a preview, plus the CDN URL(s) as text.
 * Falls back to URL-only text if the image can't be fetched/encoded.
 */
async function okImage(data: Record<string, unknown>) {
  const urls = extractUrls(data);
  const textBlock = { type: "text" as const, text: summarizeOutput(data) };
  const primary = urls[0];
  const structuredContent = generationStructured(data);
  if (!primary) return { content: [textBlock], structuredContent };

  try {
    const res = await fetch(primary);
    if (!res.ok) return { content: [textBlock], structuredContent };
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png";
    if (!mimeType.startsWith("image/")) return { content: [textBlock], structuredContent };
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return {
      content: [
        { type: "image" as const, data: base64, mimeType },
        textBlock,
      ],
      structuredContent,
    };
  } catch {
    return { content: [textBlock], structuredContent };
  }
}

/**
 * Build a fully-configured ImageAT MCP server bound to the given client. Shared by
 * both the stdio entry (index.ts) and the remote Streamable HTTP entry (http.ts),
 * so the two transports expose an identical tool surface.
 *
 * Returns the server plus the number of tools registered (for logging).
 */
export async function createImageatServer(
  client: ImageATClient,
  log: (msg: string) => void = () => {},
): Promise<{ server: McpServer; toolCount: number }> {
  const server = new McpServer({ name: "imageat", version: SERVER_VERSION }, {
    capabilities: { tasks: { requests: { tools: { call: {} } } } },
    taskStore,
    taskMessageQueue,
  });

  // ---- Core tools ----------------------------------------------------------

  server.registerTool(
    "imageat_generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image from a text prompt (text-to-image), optionally with reference images for image-to-image editing. Returns CDN image URL(s).",
      inputSchema: {
        prompt: z.string().describe("What to generate."),
        aspectRatio: z
          .string()
          .optional()
          .describe(
            'e.g. "1:1", "16:9", "9:16", "4:5". nano-banana-2.1 also takes "21:9", "4:1", "1:4", "8:1", "1:8" and "auto". ' +
              'midjourney-v8 takes 1:1, 9:16, 16:9, 4:3, 3:4, 2:3, 3:2, 9:21, 21:9 (others snap to the nearest).',
          ),
        resolution: z.enum(["1K", "2K", "4K"]).optional().describe('midjourney-v8: "1K", or "2K" for native 2K HD.'),
        numImages: z.number().int().min(1).max(4).optional().describe("Ignored by midjourney-v8, which always returns 4 images."),
        model: z
          .string()
          .optional()
          .describe(
            'Model id. One of: "nano-banana-pro" (default), "nano-banana-2.1" (Google\'s newest Nano Banana, up to 14 references), ' +
              '"nano-banana-2", "nano-banana", ' +
              '"gpt-image-2.5" (OpenAI GPT Image 2.5, Flare), "gpt-image-2.5-sunburst" (slower, finer detail), ' +
              '"midjourney-v8" (Midjourney V8.2; every call returns 4 images for one charge and takes ~2 minutes; ' +
              'images[0] is re-imagined, images[1] is a style reference), ' +
              '"gpt-image-2" (OpenAI GPT Image 2), "seedream-5.0-pro", "krea-3" (Krea 3: 1K/2K, up to 4 references, faithful edits), "krea-2-large", "krea-2-medium". ' +
              "Use these exact ids — do not invent variants like gpt-image-2.0.",
          ),
        quality: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe(
            'Quality tier for the GPT Image models. "xhigh" and "max" only exist on gpt-image-2.5; ' +
              "higher tiers cost more credits.",
          ),
        transparentBackground: z
          .boolean()
          .optional()
          .describe("gpt-image-2.5 only: return a cut-out PNG with no background."),
        outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
        enableWebSearch: z
          .boolean()
          .optional()
          .describe("Nano Banana models: ground the image in a live web search (small surcharge)."),
        images: z
          .array(z.string())
          .optional()
          .describe("Reference images as base64 data URLs or http(s) URLs for image-to-image."),
        stylize: z.number().int().min(0).max(1000).optional().describe("midjourney-v8 only: stylization strength, 0–1000."),
        chaos: z.number().int().min(0).max(100).optional().describe("midjourney-v8 only: variety across the 4 images, 0–100."),
        weird: z.number().int().min(0).max(3000).optional().describe("midjourney-v8 only: unconventional aesthetics, 0–3000."),
        seed: z.number().int().min(0).optional().describe("midjourney-v8 only: seed for repeatable results."),
        styleReferenceUrl: z.string().optional().describe("midjourney-v8 only: public URL of a style reference image."),
      },
      outputSchema: generationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const payload = {
        ...args,
        model: args.model ?? "nano-banana-pro",
      };
      const logMeta = {
        model: payload.model,
        promptLength: payload.prompt.length,
        referenceImageCount: args.images?.length ?? 0,
        payloadKeys: Object.keys(payload),
      };

      logGeneration(log, "starting", logMeta);

      try {
        const data = await client.post<Record<string, unknown>>("/api/v1/images", payload);
        logGeneration(log, "success", {
          ...logMeta,
          status: 200,
          hasUrl: typeof data.url === "string" || Array.isArray(data.urls),
          creditsUsed: data.creditsUsed ?? data.credits_used,
        });
        return await okImage(data);
      } catch (e) {
        if (e instanceof ImageATError) {
          logGeneration(log, "failed", {
            ...logMeta,
            message: e.message,
            status: e.status,
            requestId: e.requestId,
            providerMessage: e.providerMessage,
            providerBody: e.body,
          });
          return structuredFail(e.toStructuredError());
        }

        logGeneration(log, "failed", {
          ...logMeta,
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
        return structuredFail({
          code: "IMAGE_GENERATION_ERROR",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        });
      }
    },
  );

  server.registerTool(
    "imageat_generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video from a text prompt (text-to-video), a starting image (image-to-video), or reference images (reference-to-video, Seedance 2.0 / 2.5). " +
        "Returns a CDN mp4 URL when the video finishes quickly; for slower models it returns a task ID to pass to imageat_check_video_status.",
      inputSchema: {
        prompt: z.string().describe("What the video should show."),
        model: z
          .string()
          .optional()
          .describe(
            'Model id. One of: "veo" (default), "veo-lite", "sora", "kling", "kling3", "kling3-omni", ' +
              '"grok", "grok-1-5", "seedance2", "seedance2-mini", "seedance25", ' +
              '"gemini-omni", "pixverse", "happyhorse", "happyhorse-ref", "flux3", ' +
              '"flux3-max" (FLUX 3 Max: text, image or first/last-frame; 5s–20s, 720p/1080p, native audio, follows prompts closely), ' +
              '"wan3" (Wan 3.0: text, image, first/last-frame or up to 10 reference images; 2s–30s, 480p/720p/1080p, native audio), ' +
              '"midjourney-v8" (Midjourney V8.2, image-to-video only: needs imageUrl, returns 4 × 5s clips per run). ' +
              '"kling4" (Kling 4.0: text, image, first/last-frame or up to 10 reference images; 3s–30s, 720p/1080p), ' +
              "Use these exact ids — do not invent variants like seedance-2.5 or flux-3.",
          ),
        aspectRatio: z.string().optional(),
        duration: z
          .string()
          .optional()
          .describe(
            'e.g. "8s". Supported lengths vary by model — "seedance25" and "kling4" take 3s/4s–30s, "wan3" 2s–30s, "flux3"/"flux3-max" 5s–20s, ' +
              '"veo"/"veo-lite" only 4s, 6s or 8s.',
          ),
        resolution: z
          .string()
          .optional()
          .describe(
            'e.g. "720p", "1080p". Varies by model — "seedance25" and "midjourney-v8" are 480p or 720p, ' +
              '"flux3", "flux3-max" and "kling4" are 720p or 1080p, "wan3" is 480p, 720p or 1080p, "veo" also allows "4k".',
          ),
        negativePrompt: z.string().optional(),
        generateAudio: z.boolean().optional(),
        imageUrl: z.string().optional().describe("Starting image URL for image-to-video (required for midjourney-v8)."),
        motion: z.enum(["low", "high"]).optional().describe("midjourney-v8 only: amount of motion."),
        referenceImageUrls: z
          .array(z.string())
          .optional()
          .describe(
            "Reference image URLs for reference-to-video (Seedance 2.0 / 2.5, Wan 3.0 up to 10): the video keeps the face/subject from these images.",
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await client.post<VideoStartResponse>("/api/v1/videos", args);

        // Sync models return the mp4 straight away.
        if (typeof data.url === "string") {
          const structuredContent = generationStructured(data as Record<string, unknown>);
          return { content: [{ type: "text" as const, text: renderVideo(data.url) }], structuredContent };
        }

        const taskId = data.taskId;
        if (!taskId) {
          const raw = data as Record<string, unknown>;
          return { content: [{ type: "text" as const, text: summarizeOutput(raw) }], structuredContent: generationStructured(raw) };
        }

        // Async models must hand control back immediately. Polling inside this tool
        // caused MCP hosts with a hard tool deadline to report a timeout even after
        // ImageAT had accepted the job. The explicit status tool owns all polling.
        const generationId = data.generationId ?? null;
        return {
          content: [{ type: "text" as const, text:
          `Video request accepted and rendering.\n\n` +
            `Task ID: ${taskId}\n` +
            (generationId ? `Generation ID: ${generationId}\n` : "") +
            `\nCall imageat_check_video_status with this task ID to get the mp4 URL once it's ready. ` +
            `It will also appear in the ImageAT dashboard when it finishes.` }],
          structuredContent: { status: "pending", urls: [], taskId, ...(generationId ? { generationId } : {}) },
        };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_check_video_status",
    {
      title: "Check Video Status",
      description:
        "Check whether a video started by imageat_generate_video or imageat_assemble_video has finished, and get its CDN mp4 URL. " +
        "Use the task ID that tool returned.",
      inputSchema: {
        taskId: z.string().describe("The task ID returned by imageat_generate_video or imageat_assemble_video."),
        generationId: z
          .string()
          .optional()
          .describe("The generation ID returned alongside the task ID, if any."),
      },
      outputSchema: generationOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, generationId }) => {
      try {
        const data = await pollOnce(client, taskId, generationId ?? null);
        const doneUrls = data.status === "completed" ? videoStatusUrls(data) : [];
        if (doneUrls.length > 0) return { content: [{ type: "text" as const, text: renderVideos(doneUrls) }], structuredContent: { status: "completed", urls: doneUrls, taskId, ...(generationId ? { generationId } : {}) } };
        if (data.status === "failed") return fail(data.error ?? "Video generation failed.");
        return { content: [{ type: "text" as const, text: `Still rendering. Task ID: ${taskId}. Check again in a minute or two.` }], structuredContent: { status: "pending", urls: [], taskId, ...(generationId ? { generationId } : {}) } };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  // Experimental MCP Tasks variant for clients that support long-running tool
  // calls. The regular generate/status tools remain available for older hosts.
  (server.experimental.tasks.registerToolTask as any)(
    "imageat_generate_video_task",
    {
      title: "Generate Video (MCP Task)",
      description: "Start a video and expose its lifecycle through tasks/get and tasks/result.",
      inputSchema: {
        prompt: z.string().min(1),
        model: z.string().optional(),
        imageUrl: z.string().optional(),
        aspectRatio: z.string().optional(),
        duration: z.string().optional(),
        resolution: z.string().optional(),
      },
      outputSchema: generationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execution: { taskSupport: "required" },
    },
    {
      async createTask(args: Record<string, unknown>, extra: any) {
        const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl ?? 60 * 60 * 1000, pollInterval: 10_000 });
        void (async () => {
          try {
            const started = await client.post<VideoStartResponse>("/api/v1/videos", args);
            if (started.url) {
              await extra.taskStore.storeTaskResult(task.taskId, "completed", { content: [{ type: "text", text: renderVideo(started.url) }], structuredContent: { status: "completed", urls: [started.url], ...(started.generationId ? { generationId: started.generationId } : {}) } });
              return;
            }
            if (!started.taskId) throw new Error("Video provider did not return a URL or task ID");
            for (;;) {
              const current = await extra.taskStore.getTask(task.taskId);
              if (current?.status === "cancelled") {
                if (started.generationId) await client.post("/api/v1/videos/cancel", { taskId: started.taskId, generationId: started.generationId }).catch(() => null);
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              const state = await pollOnce(client, started.taskId, started.generationId ?? null);
              if (state.status === "pending") continue;
              const doneUrls = videoStatusUrls(state);
              if (state.status === "failed" || doneUrls.length === 0) throw new Error(state.error || "Video generation failed");
              await extra.taskStore.storeTaskResult(task.taskId, "completed", { content: [{ type: "text", text: renderVideos(doneUrls) }], structuredContent: { status: "completed", urls: doneUrls, taskId: started.taskId, ...(started.generationId ? { generationId: started.generationId } : {}) } });
              return;
            }
          } catch (error) {
            await extra.taskStore.storeTaskResult(task.taskId, "failed", fail(error instanceof Error ? error.message : String(error)));
          }
        })();
        return { task };
      },
      async getTask(_args: unknown, extra: any) { return await extra.taskStore.getTask(extra.taskId); },
      async getTaskResult(_args: unknown, extra: any) { return await extra.taskStore.getTaskResult(extra.taskId); },
    },
  );

  server.registerTool(
    "imageat_check_credits",
    {
      title: "Check Credits",
      description:
        "Return the spendable balance for the API key's account. Website credits are spent " +
        "first (at website rates), then the prepaid API balance.",
      inputSchema: {},
      outputSchema: {
        balance: z.number(),
        unit: z.string(),
        webCredits: z.number().optional(),
        webCreditsSpendable: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await client.get<{
          balance: number;
          unit?: string;
          currency?: string;
          web_credits?: number;
          web_credits_spendable?: boolean;
        }>("/api/v1/credits");
        const structuredContent = {
          balance: data.balance,
          unit: data.currency ?? data.unit ?? "credits",
          ...(typeof data.web_credits === "number" ? { webCredits: data.web_credits } : {}),
          ...(data.web_credits_spendable ? { webCreditsSpendable: true } : {}),
        };
        const text = structuredContent.webCreditsSpendable
          ? `Website credits: ${structuredContent.webCredits} (spent first). ` +
            `API balance: ${data.balance} ${structuredContent.unit}.`
          : `Credit balance: ${data.balance} ${structuredContent.unit}`;
        return { content: [{ type: "text" as const, text }], structuredContent };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  // ---- LLM tools -------------------------------------------------------------
  // Runs through the same /v1/chat/completions endpoint (and billing) as the REST API.

  server.registerTool(
    "imageat_ask_gemini_argon",
    {
      title: "Ask Gemini 4 Argon",
      description:
        "Send a prompt to Google's Gemini 4 Argon, a multimodal reasoning model for long, multi-step coding, research, and " +
        "document analysis. Optionally ground the answer with Google Search or Google Maps, or attach image URLs. " +
        "Use one grounding source per call: when both are set, only Google Search is applied. " +
        "Returns the text answer. Usage-based: a 10-credit reservation settles to the provider cost (usually 1 credit).",
      inputSchema: {
        prompt: z.string().min(1).max(100_000).describe("The question or task."),
        system: z.string().max(20_000).optional().describe("Optional system instructions."),
        imageUrls: z.array(z.string().url()).max(10).optional().describe("Public HTTPS image URLs for the model to look at."),
        thinkingLevel: z.enum(["low", "medium", "high"]).optional().describe('Reasoning depth. Default "medium"; "high" is slower and costs more.'),
        webSearch: z.boolean().optional().describe("Ground the answer with Google Search. Takes precedence over googleMaps."),
        googleMaps: z.boolean().optional().describe("Ground the answer with Google Maps place data (places, ratings, addresses). Ignored when webSearch is set."),
      },
      outputSchema: {
        text: z.string(),
        model: z.string(),
        creditsUsed: z.number().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const model = "google/gemini-4-argon";
      try {
        const content = args.imageUrls?.length
          ? [{ type: "text", text: args.prompt }, ...args.imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
          : args.prompt;
        const data = await client.post<{
          choices?: Array<{ message?: { content?: string | null } }>;
          credits_used?: number;
        }>("/api/v1/chat/completions", {
          model,
          messages: [...(args.system ? [{ role: "system", content: args.system }] : []), { role: "user", content }],
          reasoning: args.thinkingLevel ?? "medium",
          web_search: args.webSearch === true,
          google_maps: args.googleMaps === true,
        });
        const text = data.choices?.[0]?.message?.content ?? "";
        const structuredContent = {
          text,
          model,
          ...(typeof data.credits_used === "number" ? { creditsUsed: data.credits_used } : {}),
        };
        return {
          content: [{ type: "text" as const, text: text + (typeof data.credits_used === "number" ? `\n\nCredits used: ${data.credits_used}` : "") }],
          structuredContent,
        };
      } catch (e) {
        return e instanceof ImageATError ? structuredFail(e.toStructuredError()) : fail(String(e));
      }
    },
  );

  // ---- Narrated video tools ------------------------------------------------
  // Voiceover + assembly let an agent turn per-block clips into one finished
  // explainer: generate a clip and a take per script block, then assemble.

  server.registerTool(
    "imageat_list_voices",
    {
      title: "List Voices",
      description: "List the narrator voices imageat_generate_speech accepts, per speech model, with a style label and a preview URL.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await client.get<{
          models: Array<{ id: string; name: string; pricing: string; defaultVoice: string; voices: Array<{ id: string; name: string; gender: string; style: string }> }>
        }>("/api/v1/audio/voices");
        const text = data.models
          .map(
            (m) =>
              `${m.name} — model "${m.id}" (${m.pricing}; default voice ${m.defaultVoice}):\n` +
              m.voices.map((v) => `- ${v.name} (${v.gender}, ${v.style})`).join("\n"),
          )
          .join("\n\n");
        return { content: [{ type: "text" as const, text: `${text}\n\nPass the voice name as \`voice\` to imageat_generate_speech.` }] };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_generate_speech",
    {
      title: "Generate Speech",
      description:
        "Turn text into a voiceover (text-to-speech). Returns an mp3 URL and its measured duration in seconds. " +
        'Use one voice for a whole video. Default model "elevenlabs-tts" (3 credits per 1,000 characters); "gemini-tts" costs 1.',
      inputSchema: {
        text: z.string().min(1).max(5000).describe("The exact words to speak. Spell numbers out for natural reading."),
        model: z.enum(["elevenlabs-tts", "gemini-tts"]).optional(),
        voice: z.string().optional().describe('Voice name from imageat_list_voices, e.g. "Brian" (default, calm narrator) or "George".'),
        stability: z.number().min(0).max(1).optional().describe("elevenlabs-tts only: lower is more expressive, higher is steadier."),
      },
      outputSchema: { status: z.string(), url: z.string(), durationSec: z.number().optional(), creditsUsed: z.number().optional(), generationId: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await client.post<{ url: string; durationSec?: number; creditsUsed?: number; generationId?: string; voice?: { name: string } }>(
          "/api/v1/audio/speech",
          args,
        );
        const structuredContent = {
          status: "completed",
          url: data.url,
          ...(typeof data.durationSec === "number" ? { durationSec: data.durationSec } : {}),
          ...(typeof data.creditsUsed === "number" ? { creditsUsed: data.creditsUsed } : {}),
          ...(data.generationId ? { generationId: data.generationId } : {}),
        };
        const text =
          `Voiceover ready${data.voice ? ` (${data.voice.name})` : ""}: ${data.url}` +
          (typeof data.durationSec === "number" ? `\nDuration: ${data.durationSec}s` : "") +
          (typeof data.creditsUsed === "number" ? `\nCredits used: ${data.creditsUsed}` : "");
        return { content: [{ type: "text" as const, text }], structuredContent };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_assemble_video",
    {
      title: "Assemble Narrated Video",
      description:
        "Stitch clips and voiceover takes into one mp4, in order, with burned-in subtitles from each block's text. " +
        "Block N's audio always plays over clip N, starting 0.3s in. Every file is measured first: a take longer than its clip " +
        "is rejected per block before anything is charged. Costs 3 credits per started minute with subtitles, 1 without. " +
        "Returns a task ID: poll imageat_check_video_status with it for the final mp4.",
      inputSchema: {
        items: z
          .array(
            z.object({
              videoUrl: z.string().describe("Finished clip mp4 URL for this block."),
              audioUrl: z.string().optional().describe("Voiceover take for this block (from imageat_generate_speech)."),
              text: z.string().optional().describe("The narration line, used for the subtitles."),
            }),
          )
          .min(1)
          .max(60)
          .describe("One entry per block, in playback order."),
        subtitles: z.boolean().optional().describe("Burn subtitles from each item's text. Default true."),
        subtitlePosition: z.enum(["top", "center", "bottom"]).optional().describe("Default bottom."),
      },
      outputSchema: generationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await client.post<{ taskId: string; generationId?: string; durationSec?: number; creditsUsed?: number }>(
          "/api/v1/videos/assemble",
          args,
        );
        return {
          content: [{ type: "text" as const, text:
            `Assembly started${typeof data.durationSec === "number" ? ` (${data.durationSec}s video)` : ""}.\n\n` +
            `Task ID: ${data.taskId}\n` +
            (data.generationId ? `Generation ID: ${data.generationId}\n` : "") +
            (typeof data.creditsUsed === "number" ? `Credits used: ${data.creditsUsed}\n` : "") +
            `\nCall imageat_check_video_status with this task ID in about a minute to get the final mp4.` }],
          structuredContent: {
            status: "pending",
            urls: [],
            taskId: data.taskId,
            ...(data.generationId ? { generationId: data.generationId } : {}),
            ...(typeof data.creditsUsed === "number" ? { creditsUsed: data.creditsUsed } : {}),
          },
        };
      } catch (e) {
        if (e instanceof ImageATError && e.status === 422 && e.body && typeof e.body === "object" && Array.isArray((e.body as { problems?: unknown }).problems)) {
          const problems = (e.body as { problems: string[] }).problems;
          return fail(`Nothing was charged. Fix these blocks and assemble again:\n${problems.map((p) => `- ${p}`).join("\n")}`);
        }
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  // ---- Dynamic edit tools --------------------------------------------------
  // Fetch the live feature catalog and register one tool per feature, so new
  // editor-ai features appear automatically without changing this code.
  let features: EditFeature[] = featureCache && featureCache.expiresAt > Date.now() ? featureCache.features : [];
  if (!features.length) {
    try {
      const res = await client.get<{ features: EditFeature[] }>("/api/v1/edit/features");
      features = Array.isArray(res.features) ? res.features : [];
      if (features.length) featureCache = { features, expiresAt: Date.now() + FEATURE_CACHE_MS };
    } catch (e) {
      log(
        `Could not load edit feature catalog (${
          e instanceof Error ? e.message : String(e)
        }); registering a generic edit tool instead.`,
      );
    }
  }

  if (features.length > 0) {
    for (const f of features) {
      const toolName = `imageat_edit_${f.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      server.registerTool(
        toolName,
        {
          title: f.name,
          description: `${f.name} (≈${f.credits} credits). Edit an image via ImageAT's ${f.id} tool.`,
          inputSchema: {
            imageUrl: z.string().describe("Image to edit: base64 data URL or http(s) URL."),
            prompt: z.string().optional().describe("Edit instruction, where the feature uses one."),
            maskUrl: z.string().optional().describe("Mask image (for eraser/inpaint features)."),
            options: z
              .record(z.any())
              .optional()
              .describe("Feature-specific options (see ImageAT docs)."),
          },
          outputSchema: generationOutputSchema,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args) => {
          try {
            const data = await client.post<Record<string, unknown>>("/api/v1/edit", {
              feature: f.id,
              ...args,
            });
            return await okImage(data);
          } catch (e) {
            return fail(e instanceof ImageATError ? e.message : String(e));
          }
        },
      );
    }
  } else {
    // Fallback: a single generic edit tool that takes the feature id as a parameter.
    server.registerTool(
      "imageat_edit_image",
      {
        title: "Edit Image",
        description:
          "Edit an image using one of ImageAT's edit features. Pass the feature id (e.g. remove-background, object-eraser, relight, virtual-try-on, city-teleport, ai-edit-pro).",
        inputSchema: {
          feature: z.string().describe("Edit feature id."),
          imageUrl: z.string().describe("Image to edit: base64 data URL or http(s) URL."),
          prompt: z.string().optional(),
          maskUrl: z.string().optional(),
          options: z.record(z.any()).optional(),
        },
        outputSchema: generationOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const data = await client.post<Record<string, unknown>>("/api/v1/edit", args);
          return await okImage(data);
        } catch (e) {
          return fail(e instanceof ImageATError ? e.message : String(e));
        }
      },
    );
  }

  // ---- Playable game tools -------------------------------------------------
  // The caller (Claude) writes the game code; imageat supplies the rules, assets and hosting.
  // Same runtime contract and kit as the on-site generator at /ai-game-generator.

  const gameDimension = z.enum(["2d", "fast_3d", "3d"]);
  const gameGenre = z.enum(["shooter", "runner", "adventure", "action", "strategy", "maze", "puzzle", "simulation"]);
  const gameIssues = (e: unknown) => {
    const body = e instanceof ImageATError ? (e.body as { issues?: Array<{ rule: string; message: string }> } | undefined) : undefined;
    return body?.issues?.length ? `\n${body.issues.map((i) => `- [${i.rule}] ${i.message}`).join("\n")}` : "";
  };

  server.registerTool(
    "imageat_game_guide",
    {
      title: "Game guide",
      description:
        "Start here to build a playable browser game. Returns the workflow, the runtime rules and the kit API " +
        "(Phaser for 2D, three.js for 3D) that game code must follow, plus genre tips. Free.",
      inputSchema: {
        dimension: gameDimension.default("2d").describe("2d sprites, fast_3d (library models) or 3d (library + AI-made hero models)."),
        genre: gameGenre.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ dimension, genre }) => {
      try {
        const q = new URLSearchParams({ dimension, ...(genre ? { genre } : {}) });
        const data = await client.get<{ guide: string }>(`/api/v1/games/guide?${q}`);
        return ok(data.guide);
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_search_game_models",
    {
      title: "Search game 3D models",
      description:
        "Search imageat's library of 2,700+ ready-made, game-ready 3D models (vehicles, buildings, nature, " +
        "castle, pirate, space, food, furniture, characters, animals...). Returns library_key values to pass " +
        "to imageat_publish_game, with animation names and sizes. Free.",
      inputSchema: {
        query: z.string().min(2).describe("Plain search words, e.g. 'pine tree', 'police car', 'knight'."),
        animated: z.boolean().optional().describe("Prefer models with animations (walk, run, idle)."),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, animated, limit }) => {
      try {
        const q = new URLSearchParams({ q: query, ...(animated ? { animated: "1" } : {}), ...(limit ? { limit: String(limit) } : {}) });
        const data = await client.get<{ models: unknown[] }>(`/api/v1/games/models?${q}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(data.models, null, 2) }], structuredContent: data as Record<string, unknown> };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_generate_game_asset",
    {
      title: "Generate game asset",
      description:
        "Make one asset for a game and keep it ready for imageat_publish_game. kind: sprite (transparent " +
        "object/character), background, texture, logo (title lettering, transparent), or hero_model (a custom " +
        "3D model made from your description, takes 1-3 minutes). Returns an asset_id. Billed per asset.",
      inputSchema: {
        kind: z.enum(["sprite", "background", "texture", "logo", "hero_model"]),
        prompt: z.string().min(3).describe("Describe the single asset, including art style and palette shared by the whole game."),
        width: z.number().int().min(64).max(2048).optional(),
        height: z.number().int().min(64).max(2048).optional(),
        reference_image_urls: z.array(z.string()).max(4).optional().describe("imageat-hosted images to match (character likeness, style)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await client.post<Record<string, unknown>>("/api/v1/games/assets", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_publish_game",
    {
      title: "Publish game",
      description:
        "Publish a game you wrote against the imageat kit (see imageat_game_guide). Bundles your code, the " +
        "engine and every asset into one playable page and returns its link. The code is checked first; if " +
        "it needs changes you get the list and are not charged. 1 credit.",
      inputSchema: {
        title: z.string().min(1).max(60),
        prompt: z.string().min(3).describe("The game brief: setting, goal, controls, progression, look."),
        tagline: z.string().max(140).optional().describe("One line under the logo on the title screen."),
        genre: gameGenre,
        dimension: gameDimension,
        orientation: z.enum(["portrait", "landscape"]).default("portrait"),
        code: z.string().min(20).describe("The complete game JavaScript (runs inside an async function after the kit loads)."),
        assets: z
          .array(
            z.object({
              id: z.string().describe("The id the code uses, e.g. kit.asset('player') or kit.model('hero')."),
              asset_id: z.string().optional().describe("From imageat_generate_game_asset."),
              library_key: z.string().optional().describe("From imageat_search_game_models."),
            }),
          )
          .default([]),
        visibility: z.enum(["unlisted", "private"]).optional().describe("unlisted (default): anyone with the link can play."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await client.post<{ game_id: string; url: string; version: number }>("/api/v1/games", args);
        return {
          content: [{ type: "text" as const, text: `Published "${args.title}": ${data.url} (game_id ${data.game_id}). Share the link to play.` }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(`${e instanceof ImageATError ? e.message : String(e)}${gameIssues(e)}`);
      }
    },
  );

  server.registerTool(
    "imageat_update_game",
    {
      title: "Update game",
      description: "Publish new code for one of your games as a new version (same assets, same link). Free.",
      inputSchema: {
        game_id: z.string(),
        code: z.string().min(20).describe("The complete new game JavaScript."),
        note: z.string().max(200).optional().describe("What changed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ game_id, code, note }) => {
      try {
        const data = await client.post<{ url: string; version: number }>(`/api/v1/games/${encodeURIComponent(game_id)}/versions`, { code, note });
        return ok(`Updated to v${data.version}: ${data.url}`);
      } catch (e) {
        return fail(`${e instanceof ImageATError ? e.message : String(e)}${gameIssues(e)}`);
      }
    },
  );

  // ---- Resources and reusable prompts ------------------------------------
  server.registerResource(
    "imageat-account-credits",
    "imageat://account/credits",
    { title: "imageat account credits", description: "Current API balance for this connection.", mimeType: "application/json" },
    async () => {
      const data = await client.get<Record<string, unknown>>("/api/v1/credits");
      return { contents: [{ uri: "imageat://account/credits", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerResource(
    "imageat-edit-features",
    "imageat://edit/features",
    { title: "imageat edit features", description: "Live catalog of image editing capabilities and prices.", mimeType: "application/json" },
    async () => ({ contents: [{ uri: "imageat://edit/features", mimeType: "application/json", text: JSON.stringify({ features }, null, 2) }] }),
  );

  for (const [name, uri, path, description] of [
    ["imageat-image-models", "imageat://models/images", "/api/v1/models/images", "Available image generation models."],
    ["imageat-video-models", "imageat://models/videos", "/api/v1/models/videos", "Available video generation models."],
    ["imageat-recent-generations", "imageat://generations/recent", "/api/v1/generations/recent?limit=10", "The account's ten most recent generations."],
  ] as const) {
    server.registerResource(name, uri, { title: name.replace(/-/g, " "), description, mimeType: "application/json" }, async () => {
      const data = await client.get<Record<string, unknown>>(path);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
    });
  }

  server.registerPrompt(
    "create-product-visual",
    {
      title: "Create a product visual",
      description: "Prepare a production-ready prompt for an ecommerce or campaign image.",
      argsSchema: {
        product: z.string().describe("Product and its defining visual details."),
        campaign: z.string().optional().describe("Campaign goal, audience, or channel."),
        aspectRatio: z.string().optional().describe("Target aspect ratio, e.g. 1:1 or 4:5."),
      },
    },
    async ({ product, campaign, aspectRatio }) => ({ messages: [{ role: "user", content: { type: "text", text: `Create a polished imageat_generate_image prompt for ${product}.${campaign ? ` Campaign context: ${campaign}.` : ""}${aspectRatio ? ` Compose for ${aspectRatio}.` : ""} Include scene, composition, lighting, materials, camera, and exclusions; then call the image generation tool.` } }] }),
  );

  server.registerPrompt(
    "animate-image",
    {
      title: "Animate an image",
      description: "Turn a still image into a directed video shot.",
      argsSchema: { imageUrl: z.string().describe("Public source image URL."), motion: z.string().describe("Desired subject and camera motion."), duration: z.string().optional() },
    },
    async ({ imageUrl, motion, duration }) => ({ messages: [{ role: "user", content: { type: "text", text: `Use imageat_generate_video to animate ${imageUrl}. Motion direction: ${motion}.${duration ? ` Target duration: ${duration}.` : ""} Preserve identity and composition unless the motion requires revealing new space.` } }] }),
  );

  server.registerPrompt(
    "create-playable-game",
    {
      title: "Create a playable game",
      description: "Design, build and publish a browser game with imageat assets and hosting.",
      argsSchema: { idea: z.string().describe("The game idea."), style: z.string().optional().describe("2d, fast_3d or 3d") },
    },
    async ({ idea, style }) => ({ messages: [{ role: "user", content: { type: "text", text: `Make a playable browser game: ${idea}. Call imageat_game_guide first (dimension ${style || "2d"}), design the game, make its assets${style && style !== "2d" ? " and pick library models" : ""}, write the complete code against the kit, then publish it with imageat_publish_game and give me the link.` } }] }),
  );
  server.registerPrompt("create-social-campaign", { title: "Create a social campaign", description: "Plan and generate a channel-ready visual campaign.", argsSchema: { brief: z.string(), channels: z.string().optional() } }, async ({ brief, channels }) => ({ messages: [{ role: "user", content: { type: "text", text: `Create a cohesive social campaign for: ${brief}. Channels: ${channels || "Instagram, TikTok, and LinkedIn"}. Propose three visual concepts, then use imageat tools to generate the strongest assets with platform-ready aspect ratios.` } }] }));
  server.registerPrompt("generate-and-upscale", { title: "Generate and upscale", description: "Generate a strong master visual ready for high-resolution delivery.", argsSchema: { subject: z.string(), usage: z.string().optional() } }, async ({ subject, usage }) => ({ messages: [{ role: "user", content: { type: "text", text: `Generate a high-quality master visual of ${subject}${usage ? ` for ${usage}` : ""}. Choose the best available image model and resolution, preserve clean edges and realistic detail, and return the final CDN URL.` } }] }));
  server.registerPrompt("create-creative-variants", { title: "Create creative variants", description: "Generate three deliberately distinct creative directions.", argsSchema: { brief: z.string(), aspectRatio: z.string().optional() } }, async ({ brief, aspectRatio }) => ({ messages: [{ role: "user", content: { type: "text", text: `Create three clearly differentiated visual directions for: ${brief}. Use distinct composition, lighting, palette, and camera language for each.${aspectRatio ? ` Use ${aspectRatio}.` : ""} Generate all three and label their URLs.` } }] }));

  const toolCount = 8 + (features.length || 1);
  return { server, toolCount };
}
