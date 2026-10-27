/**
 * The ChatGPT app profile, served at /chatgpt/mcp.
 *
 * A curated, static tool surface for the published ChatGPT app, kept apart from the
 * generic /mcp endpoint because OpenAI's directory rules differ from other clients:
 *
 * - Tools are reviewed, and a new tool needs approval before it goes live, so this list
 *   is fixed instead of being built from the live edit-feature catalog.
 * - The app must suit ages 13–17: the client tags every call with the "chatgpt" surface
 *   and the web app applies the strict content filter to it.
 * - No purchase prompts anywhere (see client.ts messageForStatus).
 * - Attached photos arrive as `openai/fileParams` objects ({ download_url, file_id }).
 * - Results render in the media widget (widget.ts) instead of inline base64.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ImageATClient, ImageATError } from "./client.js";
import {
  extractUrls,
  isVideoUrl,
  pollOnce,
  videoStatusUrls,
  SERVER_VERSION,
  type VideoStartResponse,
} from "./server.js";
import { MEDIA_RESOURCE_DOMAINS, MEDIA_WIDGET_HTML, MEDIA_WIDGET_URI } from "./widget.js";

const fileRef = z
  .object({
    download_url: z.string().url(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .describe("An image the user attached in the conversation.");

type FileRef = z.infer<typeof fileRef>;

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

const mediaOutputSchema = {
  status: z.enum(["completed", "pending", "failed"]),
  mediaType: z.enum(["image", "video"]),
  urls: z.array(z.string()),
  creditsUsed: z.number().optional(),
  jobId: z.string().optional(),
  message: z.string().optional(),
};

type MediaResult = {
  status: "completed" | "pending" | "failed";
  mediaType: "image" | "video";
  urls: string[];
  creditsUsed?: number;
  jobId?: string;
  message?: string;
};

// Every tool states all three hints explicitly (OpenAI submission requirement).
const GENERATES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function widgetMeta(invoking: string, invoked: string, fileParams: string[] = []) {
  return {
    ui: { resourceUri: MEDIA_WIDGET_URI },
    "openai/outputTemplate": MEDIA_WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
    ...(fileParams.length ? { "openai/fileParams": fileParams } : {}),
  };
}

/**
 * A video job is two upstream ids: the provider task (to poll) and the dashboard
 * generation (which the status route needs to finalize and to refund a failure).
 * They travel as one opaque handle so the model only has to carry a single value.
 */
function encodeJobId(taskId: string, generationId?: string | null): string {
  return Buffer.from(JSON.stringify(generationId ? [taskId, generationId] : [taskId])).toString("base64url");
}

function decodeJobId(jobId: string): { taskId: string; generationId: string | null } | null {
  try {
    const parsed = JSON.parse(Buffer.from(jobId, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
    return { taskId: parsed[0], generationId: typeof parsed[1] === "string" ? parsed[1] : null };
  } catch {
    return null;
  }
}

function pickImage(file: FileRef | undefined, url: string | undefined): string | undefined {
  return file?.download_url ?? url;
}

function credits(data: Record<string, unknown>): number | undefined {
  const value = data.creditsUsed ?? data.credits_used;
  return typeof value === "number" ? value : undefined;
}

function textFor(result: MediaResult): string {
  if (result.status === "pending") {
    return (
      "The video is rendering (usually 1–5 minutes). The card above updates by itself when it's done. " +
      `To check from the conversation, call imageat_check_video_status with jobId "${result.jobId}".`
    );
  }
  if (result.status === "failed") return `Generation failed: ${result.message ?? "unknown error"}. Any credits charged were refunded.`;
  const noun = result.mediaType === "video" ? "video" : result.urls.length === 1 ? "image" : "images";
  const lines = [`Created ${result.urls.length > 1 ? `${result.urls.length} ` : ""}${noun}:`, ...result.urls];
  if (result.creditsUsed !== undefined) lines.push(`Credits used: ${result.creditsUsed}`);
  return lines.join("\n");
}

function reply(result: MediaResult) {
  return { content: [{ type: "text" as const, text: textFor(result) }], structuredContent: result };
}

function failure(e: unknown) {
  const message = e instanceof ImageATError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function imageResult(data: Record<string, unknown>): MediaResult {
  const urls = extractUrls(data);
  return {
    status: "completed",
    mediaType: urls.some(isVideoUrl) ? "video" : "image",
    urls,
    ...(credits(data) !== undefined ? { creditsUsed: credits(data) } : {}),
  };
}

export function createChatGPTServer(client: ImageATClient): McpServer {
  const server = new McpServer({ name: "imageat", title: "imageat", version: SERVER_VERSION });

  server.registerResource(
    "imageat-media-widget",
    MEDIA_WIDGET_URI,
    {
      title: "imageat media viewer",
      description: "Shows generated images and videos, and tracks videos while they render.",
      mimeType: "text/html;profile=mcp-app",
    },
    async () => ({
      contents: [
        {
          uri: MEDIA_WIDGET_URI,
          mimeType: "text/html;profile=mcp-app",
          text: MEDIA_WIDGET_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: MEDIA_RESOURCE_DOMAINS },
            },
            "openai/widgetDescription":
              "Shows the generated images or video. While a video renders it shows progress and updates itself; no need to repeat the result in text.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": { connect_domains: [], resource_domains: MEDIA_RESOURCE_DOMAINS },
          },
        },
      ],
    }),
  );

  // ---- Generation ----------------------------------------------------------

  server.registerTool(
    "imageat_generate_image",
    {
      title: "Generate image",
      description:
        "Create images from a text description with imageat's image models, optionally guided by a reference photo " +
        "(image-to-image). Use when the user asks imageat to create, design or render a picture. " +
        "Costs imageat credits from the user's account (typically 2–15 per image depending on model, resolution and quality). " +
        "Returns image URLs, shown in an inline viewer.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to create, in detail: subject, setting, style, lighting, composition."),
        aspectRatio: z.string().optional().describe('e.g. "1:1", "16:9", "9:16", "4:5", "3:2".'),
        resolution: z.enum(["1K", "2K", "4K"]).optional().describe("Output resolution. Higher costs more."),
        numImages: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe('How many variations, 1–4. Each one is charged. Ignored by "midjourney-v8", which always returns 4 for one charge.'),
        model: z
          .enum([
            "nano-banana-pro",
            "nano-banana-2.1",
            "nano-banana-2",
            "gpt-image-2.5",
            "gpt-image-2",
            "midjourney-v8",
            "seedream-5.0-pro",
            "krea-3",
            "krea-2-large",
          ])
          .optional()
          .describe(
            'Image model. Default "nano-banana-pro" (best all-round, strong text rendering). "gpt-image-2.5" for precise ' +
              'layouts and typography, "seedream-5.0-pro" for photoreal scenes, "krea-3" or "krea-2-large" for aesthetic/stylized art, ' +
              '"midjourney-v8" (Midjourney V8.2) for painterly, art-directed looks: it always returns 4 images and takes ~2 minutes.',
          ),
        quality: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("GPT Image models only. Higher costs more credits."),
        transparentBackground: z.boolean().optional().describe("gpt-image-2.5 only: return a cut-out PNG with no background."),
        referenceImage: fileRef.optional(),
        referenceImageUrls: z
          .array(httpUrl)
          .max(4)
          .optional()
          .describe("Public image URLs to use as references, e.g. an earlier imageat result."),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Generating image…", "Image ready", ["referenceImage"]),
    },
    async ({ referenceImage, referenceImageUrls, ...args }) => {
      const images = [referenceImage?.download_url, ...(referenceImageUrls ?? [])].filter(
        (u): u is string => typeof u === "string",
      );
      try {
        const data = await client.post<Record<string, unknown>>("/api/v1/images", {
          ...args,
          model: args.model ?? "nano-banana-pro",
          ...(images.length ? { images } : {}),
        });
        return reply(imageResult(data));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "imageat_generate_video",
    {
      title: "Generate video",
      description:
        "Create a short video from a text description, or animate a photo (image-to-video). Use when the user asks " +
        "imageat for a video, clip or animation. Costs imageat credits based on model, duration and resolution " +
        "(often 20–150). Videos take 1–5 minutes: this returns right away with a jobId, and the inline card updates " +
        "itself when the video is ready.",
      inputSchema: {
        prompt: z.string().min(1).describe("What happens in the video: subject, action, camera movement, style."),
        model: z
          .enum(["veo", "veo-lite", "kling3", "seedance25", "seedance2", "grok-1-5", "pixverse", "flux3", "flux3-max", "wan3", "kling4", "midjourney-v8"])
          .optional()
          .describe(
            'Video model. Default "veo" (cinematic, with sound). "seedance25" for long shots (4–30s) and keeping a face ' +
              'from reference photos, "kling3" for dynamic motion, "wan3" (Wan 3.0) for 2–30s up to 1080p with native audio, ' +
              '"flux3-max" (FLUX 3 Max) for close prompt adherence, 5–20s at 720p/1080p with native audio, ' +
              '"veo-lite" for cheaper drafts, "midjourney-v8" to animate ' +
              "a start image into 4 five-second clips (image-to-video only). " +
              '"kling4" (Kling 4.0) for the newest Kling: 3–30s at 720p/1080p from text, a start image or first/last frames.',
          ),
        aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
        duration: z
          .string()
          .optional()
          .describe('Length like "8s". Supported values vary: "veo"/"veo-lite" take 4s, 6s or 8s; "seedance25" 4s–30s; "wan3" 2s–30s; "kling4" 3s–30s; "flux3-max" 5s–20s.'),
        resolution: z.string().optional().describe('e.g. "720p" or "1080p" (model-dependent). Higher costs more.'),
        generateAudio: z.boolean().optional().describe("Generate a soundtrack where the model supports it."),
        startImage: fileRef.optional(),
        startImageUrl: httpUrl.optional().describe("Public URL of the first frame, e.g. an earlier imageat image."),
        referenceImageUrls: z
          .array(httpUrl)
          .max(4)
          .optional()
          .describe('Seedance models only: photos whose person or subject should appear in the video.'),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Starting video…", "Video started", ["startImage"]),
    },
    async ({ startImage, startImageUrl, ...args }) => {
      const imageUrl = pickImage(startImage, startImageUrl);
      try {
        const data = await client.post<VideoStartResponse>("/api/v1/videos", {
          ...args,
          ...(imageUrl ? { imageUrl } : {}),
        });
        if (typeof data.url === "string") {
          return reply({ status: "completed", mediaType: "video", urls: [data.url] });
        }
        if (!data.taskId) return failure(new Error("The video service did not return a job. No credits were charged."));
        return reply({ status: "pending", mediaType: "video", urls: [], jobId: encodeJobId(data.taskId, data.generationId) });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "imageat_check_video_status",
    {
      title: "Check video status",
      description:
        "Check a video started with imageat_generate_video and get its URL once it's ready. Only needed when the user " +
        "asks about a video in progress; the inline card already updates by itself.",
      inputSchema: {
        jobId: z.string().min(1).describe("The jobId returned by imageat_generate_video."),
      },
      outputSchema: mediaOutputSchema,
      annotations: READS,
      _meta: widgetMeta("Checking video…", "Video status checked"),
    },
    async ({ jobId }) => {
      const job = decodeJobId(jobId);
      if (!job) return failure(new Error("That jobId isn't valid. Use the exact jobId returned by imageat_generate_video."));
      try {
        const data = await pollOnce(client, job.taskId, job.generationId);
        const doneUrls = data.status === "completed" ? videoStatusUrls(data) : [];
        if (doneUrls.length > 0) return reply({ status: "completed", mediaType: "video", urls: doneUrls });
        if (data.status === "failed") {
          return reply({ status: "failed", mediaType: "video", urls: [], message: data.error ?? "The video could not be generated." });
        }
        return reply({ status: "pending", mediaType: "video", urls: [], jobId });
      } catch (e) {
        return failure(e);
      }
    },
  );

  // ---- Photo edits (POST /api/v1/edit) ----------------------------------------

  const edit = async (body: Record<string, unknown>) => {
    try {
      return reply(imageResult(await client.post<Record<string, unknown>>("/api/v1/edit", body)));
    } catch (e) {
      return failure(e);
    }
  };
  const needImage = () => failure(new Error("Attach a photo or give an image URL to edit."));

  const sourceImage = {
    image: fileRef.optional(),
    imageUrl: httpUrl.optional().describe("Public URL of the image to edit, e.g. an earlier imageat result."),
  };

  server.registerTool(
    "imageat_edit_image",
    {
      title: "Edit image",
      description:
        "Change a photo with a plain-language instruction: add or remove objects, change clothing, colors, style or " +
        'scene, fix details. Use when the user wants an existing image modified. Costs 4 credits ("standard") or 8 ("pro").',
      inputSchema: {
        ...sourceImage,
        instruction: z.string().min(1).describe("What to change, e.g. \"replace the sky with a sunset\"."),
        quality: z
          .enum(["standard", "pro"])
          .optional()
          .describe('"pro" follows complex instructions and keeps faces more faithfully. Default "standard".'),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Editing image…", "Edit ready", ["image"]),
    },
    async ({ image, imageUrl, instruction, quality }) => {
      const src = pickImage(image, imageUrl);
      if (!src) return needImage();
      return edit({ feature: quality === "pro" ? "ai-edit-pro" : "ai-edit", imageUrl: src, prompt: instruction });
    },
  );

  server.registerTool(
    "imageat_remove_background",
    {
      title: "Remove background",
      description:
        "Cut out the main subject of a photo and return a transparent PNG. Use for product shots, stickers, " +
        "profile pictures or compositing. Costs 0.5 credits.",
      inputSchema: sourceImage,
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Removing background…", "Background removed", ["image"]),
    },
    async ({ image, imageUrl }) => {
      const src = pickImage(image, imageUrl);
      if (!src) return needImage();
      return edit({ feature: "remove-background", imageUrl: src });
    },
  );

  server.registerTool(
    "imageat_replace_background",
    {
      title: "Replace background",
      description:
        "Keep the subject of a photo and put it in a new background, described in words or taken from a second " +
        "image. Use for product photos, portraits and listings. Costs 2 credits.",
      inputSchema: {
        ...sourceImage,
        background: z.string().optional().describe('The new background in words, e.g. "marble kitchen counter, soft morning light".'),
        backgroundImage: fileRef.optional(),
        backgroundImageUrl: httpUrl.optional().describe("Public URL of an image to use as the new background."),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Replacing background…", "Background replaced", ["image", "backgroundImage"]),
    },
    async ({ image, imageUrl, background, backgroundImage, backgroundImageUrl }) => {
      const src = pickImage(image, imageUrl);
      if (!src) return needImage();
      const bgImage = pickImage(backgroundImage, backgroundImageUrl);
      if (!background && !bgImage) return failure(new Error("Describe the new background or attach a background image."));
      return edit({
        feature: "background-replace",
        imageUrl: src,
        ...(bgImage ? { backgroundImageUrl: bgImage } : { backgroundPrompt: background }),
      });
    },
  );

  server.registerTool(
    "imageat_relight",
    {
      title: "Relight photo",
      description:
        "Change the lighting of a photo (direction and mood, e.g. golden-hour sun from the left) while keeping the " +
        "subject and scene. Costs 2 credits.",
      inputSchema: {
        ...sourceImage,
        lightDirection: z.enum(["front", "top", "left", "right", "back", "bottom"]).optional().describe("Where the light comes from. Default front."),
        lightType: z
          .enum([
            "midday",
            "blue hour light",
            "low-angle sunlight",
            "sunrise light",
            "spotlight on subject",
            "overcast light",
            "soft overcast daylight lighting",
            "cloud-filtered lighting",
            "fog-diffused lighting",
            "moonlight lighting",
            "starlight nighttime",
            "soft bokeh lighting",
            "harsh studio lighting",
          ])
          .optional()
          .describe('Light style. Use "low-angle sunlight" for golden hour. Default soft daylight.'),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Relighting…", "Relit", ["image"]),
    },
    async ({ image, imageUrl, lightDirection, lightType }) => {
      const src = pickImage(image, imageUrl);
      if (!src) return needImage();
      return edit({ feature: "relight", imageUrl: src, options: { lightDirection, lightType } });
    },
  );

  server.registerTool(
    "imageat_virtual_try_on",
    {
      title: "Virtual try-on",
      description:
        "Show a person wearing a garment: give a photo of the person plus a photo of the clothing item (or a short " +
        "description of it). Keeps the person's pose. Use when the user wants to see how an outfit looks on someone. Costs 4 credits.",
      inputSchema: {
        personImage: fileRef.optional(),
        personImageUrl: httpUrl.optional().describe("Public URL of the person photo."),
        garmentImage: fileRef.optional(),
        garmentImageUrl: httpUrl.optional().describe("Public URL of the clothing photo."),
        garmentDescription: z
          .string()
          .optional()
          .describe('Used only when there is no garment photo, e.g. "red wool turtleneck sweater".'),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Trying it on…", "Try-on ready", ["personImage", "garmentImage"]),
    },
    async ({ personImage, personImageUrl, garmentImage, garmentImageUrl, garmentDescription }) => {
      const person = pickImage(personImage, personImageUrl);
      if (!person) return failure(new Error("Attach a photo of the person, or give its URL."));
      const garment = pickImage(garmentImage, garmentImageUrl);
      if (!garment && !garmentDescription) return failure(new Error("Attach a photo of the clothing item or describe it."));
      return edit({
        feature: "virtual-try-on",
        imageUrl: person,
        options: garment ? { clothingImageUrl: garment } : { clothingPrompt: garmentDescription },
      });
    },
  );

  server.registerTool(
    "imageat_city_teleport",
    {
      title: "City teleport",
      description:
        "Place the person from a photo into a famous city or travel destination (e.g. Paris, Tokyo, New York) as a " +
        "realistic travel photo. Costs 4 credits.",
      inputSchema: {
        personImage: fileRef.optional(),
        personImageUrl: httpUrl.optional().describe("Public URL of the person photo."),
        city: z.string().min(1).describe('City or landmark, e.g. "Paris" or "Santorini".'),
        shot: z
          .enum(["extreme_close_up", "close_up", "medium_close_up", "medium_shot", "medium_long_shot", "long_shot", "extreme_long_shot", "full_body"])
          .optional()
          .describe("Framing. Default medium_shot."),
        cameraAngle: z
          .enum(["eye_level", "low_angle", "high_angle", "dutch_angle", "birds_eye_view", "worms_eye_view", "overhead", "side_angle"])
          .optional()
          .describe("Camera angle. Default eye_level."),
      },
      outputSchema: mediaOutputSchema,
      annotations: GENERATES,
      _meta: widgetMeta("Teleporting…", "Travel photo ready", ["personImage"]),
    },
    async ({ personImage, personImageUrl, city, shot, cameraAngle }) => {
      const person = pickImage(personImage, personImageUrl);
      if (!person) return failure(new Error("Attach a photo of the person, or give its URL."));
      return edit({
        feature: "city-teleport",
        imageUrl: person,
        options: { cityName: city, photoShot: shot, cameraAngle },
      });
    },
  );

  // ---- Account -------------------------------------------------------------

  server.registerTool(
    "imageat_check_credits",
    {
      title: "Check credits",
      description: "Show how many imageat credits the connected account has available. Use when the user asks about their balance.",
      inputSchema: {},
      outputSchema: { credits: z.number() },
      annotations: READS,
    },
    async () => {
      try {
        const data = await client.get<{ balance: number; web_credits?: number; web_credits_spendable?: boolean }>(
          "/api/v1/credits",
        );
        // Website credits are spent first; otherwise the account's API balance applies.
        const available =
          data.web_credits_spendable && typeof data.web_credits === "number" ? data.web_credits : data.balance;
        return {
          content: [{ type: "text" as const, text: `Available imageat credits: ${available}` }],
          structuredContent: { credits: available },
        };
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
