// src/lib/mcp-schemas.ts — مخططات Zod للأدوات الخمس

import { z } from "zod";

export const generateImageSchema = {
  prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
  model: z
    .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
    .default("gpt-image-2-6/flare-text-to-image"),
  aspect_ratio: z
    .enum([
      "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
      "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3",
    ])
    .default("auto"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
  wait_seconds: z.number().int().min(0).max(240).default(90),
};

export const generateVideoSchema = {
  prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
  model: z
    .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
    .default("grok-imagine-video-1-5-preview"),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  enable_audio: z.boolean().default(true),
  duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25),
};

export const mergeVideosSchema = {
  urls: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
  task_ids: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
  wait_seconds: z.number().int().min(0).max(240).default(60),
};

export const getTaskSchema = {
  task_id: z.string(),
};

export const listMediaSchema = {
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
};
