// src/lib/models.ts — سجل الموديلات والمزودات

import type { MediaType, ProviderId } from "./types";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

/** الموديلان المدمجان مع تجاوز بمتغيرات البيئة. */
export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: [
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
      "gpt-image-2-6-flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
      cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image",
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: [
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
      "grok-imagine-video-15-preview",
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
      cometapi: process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
    },
  },
];

/** توحيد اسم الموديل — إن لم يكن معروفًا نعيد null. */
export function resolveModel(name: string): ModelDef | null {
  const n = name.trim().toLowerCase();
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === n) return m;
    if (m.aliases.some((a) => a.toLowerCase() === n)) return m;
  }
  return null;
}

export const MERGER_MODEL = "video-merger";
