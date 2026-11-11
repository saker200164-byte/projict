// src/lib/providers/cometapi.ts — مزود CometAPI
// صور متزامنة عبر نقطة images المتوافقة مع OpenAI تعيد الرابط/b64_json فورًا.
// الفيديو عبر نقطة المهام غير المتزامنة بنفس نمط create/check.
// التوثيق: https://api.cometapi.com

import { ProviderError, type CheckResult, type ProviderAdapter, type ProviderInput } from "../types";

const COMET_BASE = "https://api.cometapi.com/v1";

interface CometTaskResp {
  id?: string;
  task_id?: string;
  data?: { id?: string; task_id?: string };
  error?: { message?: string; type?: string; code?: string };
}

interface CometCheckResp {
  status?: string;
  state?: string;
  progress?: number;
  output?: string | string[] | { url?: string }[];
  data?: {
    status?: string;
    state?: string;
    progress?: number;
    output?: string | string[] | { url?: string }[];
    video_url?: string;
    videoUrl?: string;
    error?: string;
    failMsg?: string;
  };
  error?: { message?: string; type?: string; code?: string };
  video_url?: string;
  videoUrl?: string;
  url?: string;
}

async function cometFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45_000);
  try {
    return await fetch(`${COMET_BASE}${path}`, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function cometErr(status: number, body: unknown): ProviderError {
  const obj = body as { error?: { message?: string; type?: string; code?: string }; message?: string };
  const msg = obj.error?.message || obj.message || `CometAPI HTTP ${status}`;
  const e = new ProviderError(status, msg, body);
  return e;
}

function statusFromString(s?: string): "processing" | "completed" | "failed" | null {
  if (!s) return null;
  const low = s.toLowerCase();
  if (["succeeded", "success", "completed", "done", "finished", "complete"].includes(low)) {
    return "completed";
  }
  if (["failed", "fail", "error", "cancelled", "canceled"].includes(low)) {
    return "failed";
  }
  return "processing";
}

function extractUrls(output: unknown): string[] {
  if (!output) return [];
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) {
    const out: string[] = [];
    for (const item of output) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object") {
        const u = (item as { url?: string }).url;
        if (typeof u === "string") out.push(u);
      }
    }
    return out;
  }
  if (typeof output === "object") {
    const u = (output as { url?: string }).url;
    if (typeof u === "string") return [u];
  }
  return [];
}

export const cometProvider: ProviderAdapter = {
  id: "cometapi",

  async createImageSync(apiKey: string, model: string, input: ProviderInput) {
    // نقطة images المتوافقة مع OpenAI — تعيد الرابط أو b64_json فورًا
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      n: 1,
      response_format: "url",
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.resolution ? { size: input.resolution } : {}),
    };
    const res = await cometFetch("/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* قد يفشل */
    }
    if (!res.ok) throw cometErr(res.status, data);
    const d = data as { data?: Array<{ url?: string; b64_json?: string }> };
    const urls: string[] = [];
    if (Array.isArray(d.data)) {
      for (const it of d.data) {
        if (it.url) urls.push(it.url);
        else if (it.b64_json) urls.push(`data:image/png;base64,${it.b64_json}`);
      }
    }
    return { urls };
  },

  async createTask(apiKey: string, model: string, input: ProviderInput) {
    // الفيديو عبر نقطة المهام غير المتزامنة
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
      ...(typeof input.enableAudio === "boolean" ? { enable_audio: input.enableAudio } : {}),
      ...(typeof input.duration === "number" ? { duration: input.duration } : {}),
    };
    const res = await cometFetch("/video/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    let data: CometTaskResp | unknown = null;
    try {
      data = await res.json();
    } catch {
      /* قد يفشل */
    }
    if (!res.ok) throw cometErr(res.status, data);
    const d = data as CometTaskResp;
    const id = d.id || d.task_id || d.data?.id || d.data?.task_id;
    if (!id) throw new ProviderError(res.status === 200 ? 500 : res.status, "CometAPI: no task id", data);
    return { providerTaskId: id };
  },

  async checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult> {
    const res = await cometFetch(`/video/generations/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let data: CometCheckResp | unknown = null;
    try {
      data = await res.json();
    } catch {
      /* قد يفشل */
    }
    if (!res.ok) throw cometErr(res.status, data);

    const d = data as CometCheckResp;
    const inner = d.data ?? d;
    const statusStr = (inner.status || inner.state || "") as string;
    const status = statusFromString(statusStr) ?? "processing";

    let progress = 0;
    if (typeof inner.progress === "number") {
      progress = inner.progress <= 1 ? Math.round(inner.progress * 100) : Math.round(inner.progress);
    }

    if (status === "completed") {
      const urls = extractUrls(inner.output) ||
        (inner.video_url ? [inner.video_url] : []) ||
        (inner.videoUrl ? [inner.videoUrl] : []) ||
        (d.video_url ? [d.video_url] : []) ||
        (d.videoUrl ? [d.videoUrl] : []) ||
        (d.url ? [d.url] : []);
      return { status: "completed", urls, progress: 100 };
    }
    if (status === "failed") {
      return { status: "failed", error: inner.error || inner.failMsg || "غير معروف" };
    }
    return { status: "processing", progress: Math.max(0, Math.min(99, progress)) };
  },
};

export const cometProviderExport = cometProvider;
