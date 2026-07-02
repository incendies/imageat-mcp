import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ImageATClient, ImageATError } from "./client.js";

export const SERVER_VERSION = "0.2.0";

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

function extractUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof data.url === "string") urls.push(data.url);
  if (Array.isArray(data.urls)) for (const u of data.urls) if (typeof u === "string") urls.push(u);
  return urls;
}

function summarizeOutput(data: Record<string, unknown>): string {
  const urls = extractUrls(data);
  const credits = data.creditsUsed ?? data.credits_used;
  const creditLine = credits !== undefined ? `\nCredits used: ${credits}` : "";
  if (urls.length === 0) return `Done.${creditLine}\n${JSON.stringify(data)}`;
  return `${urls.join("\n")}${creditLine}`;
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
  if (!primary) return { content: [textBlock] };

  try {
    const res = await fetch(primary);
    if (!res.ok) return { content: [textBlock] };
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png";
    if (!mimeType.startsWith("image/")) return { content: [textBlock] };
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return {
      content: [
        { type: "image" as const, data: base64, mimeType },
        textBlock,
      ],
    };
  } catch {
    return { content: [textBlock] };
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
  const server = new McpServer({ name: "imageat", version: SERVER_VERSION });

  // ---- Core tools ----------------------------------------------------------

  server.registerTool(
    "imageat_generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image from a text prompt (text-to-image), optionally with reference images for image-to-image editing. Returns CDN image URL(s).",
      inputSchema: {
        prompt: z.string().describe("What to generate."),
        aspectRatio: z.string().optional().describe('e.g. "1:1", "16:9", "9:16", "4:5".'),
        resolution: z.enum(["1K", "2K", "4K"]).optional(),
        numImages: z.number().int().min(1).max(4).optional(),
        model: z
          .string()
          .optional()
          .describe(
            'Model id. One of: "nano-banana-pro" (default), "nano-banana-2", "nano-banana", ' +
              '"gpt-image-2" (OpenAI GPT Image 2), "seedream-5.0-lite", "krea-2-large", "krea-2-medium". ' +
              "Use these exact ids — do not invent variants like gpt-image-2.0.",
          ),
        outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
        enableWebSearch: z.boolean().optional(),
        images: z
          .array(z.string())
          .optional()
          .describe("Reference images as base64 data URLs or http(s) URLs for image-to-image."),
      },
    },
    async (args) => {
      try {
        const data = await client.post<Record<string, unknown>>("/api/v1/images", args);
        return await okImage(data);
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video from a text prompt (text-to-video) or from a starting image (image-to-video). Returns a CDN mp4 URL.",
      inputSchema: {
        prompt: z.string().describe("What the video should show."),
        model: z
          .string()
          .optional()
          .describe('e.g. "veo", "veo-lite", "kling", "kling3", "seedance2", "pixverse".'),
        aspectRatio: z.string().optional(),
        duration: z.string().optional().describe('e.g. "8s".'),
        resolution: z.string().optional().describe('e.g. "720p", "1080p".'),
        negativePrompt: z.string().optional(),
        generateAudio: z.boolean().optional(),
        imageUrl: z.string().optional().describe("Starting image URL for image-to-video."),
      },
    },
    async (args) => {
      try {
        const data = await client.post<Record<string, unknown>>("/api/v1/videos", args);
        return ok(summarizeOutput(data));
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "imageat_check_credits",
    {
      title: "Check Credits",
      description: "Return the current credit balance for the API key's account.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.get<{ balance: number }>("/api/v1/credits");
        return ok(`Credit balance: ${data.balance}`);
      } catch (e) {
        return fail(e instanceof ImageATError ? e.message : String(e));
      }
    },
  );

  // ---- Dynamic edit tools --------------------------------------------------
  // Fetch the live feature catalog and register one tool per feature, so new
  // editor-ai features appear automatically without changing this code.
  let features: EditFeature[] = [];
  try {
    const res = await client.get<{ features: EditFeature[] }>("/api/v1/edit/features");
    features = Array.isArray(res.features) ? res.features : [];
  } catch (e) {
    log(
      `Could not load edit feature catalog (${
        e instanceof Error ? e.message : String(e)
      }); registering a generic edit tool instead.`,
    );
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

  const toolCount = 3 + (features.length || 1);
  return { server, toolCount };
}
