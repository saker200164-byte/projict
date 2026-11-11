// src/lib/providers/kie.ts — مزود kie.ai (Jobs API الموحّد)
// التوثيق: https://docs.kie.ai
// POST https://api.kie.ai/api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
// GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
//   → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//       "resultJson":"{\"resultUrls\":[\"https://...\"]}", "failMsg":"..."}}
// انتباه: resultJson نص يحتاج JSON.parse ثانيًا.

import { ProviderError, type CheckResult, type ProviderAdapter, type ProviderInput } from "../types";

const KIE_BASE = "https://api.kie.ai";

interface KieCreateResp {
  code: number;
  msg?: string;
  message?: string;
  data?: { taskId?: string };
}

interface KieRecordResp {
  code: number;
  msg?: string;
  message?: string;
  data?: {
    state?: string;
    stateStr?: string;
    resultJson?: string; // نص JSON
    failMsg?: string;
    fail_msg?: string;
    process?: string; // مثل "10%"
    progress?: number;
  };
}

async function kieFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45_000); // مهلة 45 ثانية
  try {
    return await fetch(`${KIE_BASE}${path}`, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseKieError(status: number, body: unknown): ProviderError {
  const obj = body as { msg?: string; message?: string; error?: string };
  const msg = obj.msg || obj.message || obj.error || `kie.ai HTTP ${status}`;
  return new ProviderError(status, msg, body);
}

function extractResultUrls(resultJson: unknown): string[] {
  // resultJson قد يكون نصًا يحتاج JSON.parse، أو كائنًا جاهزًا
  let parsed: unknown = resultJson;
  if (typeof resultJson === "string") {
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      return [];
    }
  }
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    const urls =
      p.resultUrls ||
      p.result_urls ||
      p.urls ||
      p.images ||
      p.videoUrl ||
      p.video_url ||
      p.url;
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === "string");
    if (typeof urls === "string") return [urls];
  }
  return [];
}

function stateToStatus(state: string): "processing" | "completed" | "failed" {
  const s = state.toLowerCase();
  if (["success", "succeeded", "completed", "done", "finished", "complete"].includes(s)) {
    return "completed";
  }
  if (["fail", "failed", "error", "cancelled", "canceled"].includes(s)) {
    return "failed";
  }
  return "processing"; // waiting, queuing, generating...
}

export const kieProvider: ProviderAdapter = {
  id: "kie",

  async createTask(apiKey: string, model: string, input: ProviderInput) {
    const body: Record<string, unknown> = {
      model,
      input: {
        prompt: input.prompt,
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.background ? { background: input.background } : {}),
        ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        ...(typeof input.enableAudio === "boolean" ? { enable_audio: input.enableAudio } : {}),
        ...(typeof input.duration === "number" ? { duration: input.duration } : {}),
      },
    };

    const res = await kieFetch("/api/v1/jobs/createTask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    let data: KieCreateResp | unknown = null;
    try {
      data = await res.json();
    } catch {
      /* قد يفشل التحليل */
    }

    if (!res.ok) throw parseKieError(res.status, data);

    const r = data as KieCreateResp;
    if (r.code !== 200 || !r.data?.taskId) {
      // قد يكون كود خطأ غير HTTP (مثل code !== 200 مع حالة 200)
      const msg = r.msg || r.message || "kie.ai createTask failed";
      const low = msg.toLowerCase();
      if (/insufficient|quota|balance|credit|exhausted|充值/.test(low)) {
        throw new ProviderError(402, msg, data);
      }
      if (/invalid api key|unauthorized|forbidden|authentication/i.test(msg)) {
        throw new ProviderError(401, msg, data);
      }
      if (/model not found|unsupported model/i.test(msg)) {
        throw new ProviderError(404, msg, data);
      }
      throw new ProviderError(res.status === 200 ? 500 : res.status, msg, data);
    }

    return { providerTaskId: r.data.taskId };
  },

  async checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult> {
    const res = await kieFetch(
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );

    let data: KieRecordResp | unknown = null;
    try {
      data = await res.json();
    } catch {
      /* قد يفشل */
    }

    if (!res.ok) throw parseKieError(res.status, data);

    const r = data as KieRecordResp;
    if (r.code !== 200) {
      const msg = r.msg || r.message || "kie.ai checkTask failed";
      const low = msg.toLowerCase();
      if (/insufficient|quota|balance|credit|exhausted|充值/.test(low)) {
        throw new ProviderError(402, msg, data);
      }
      if (/invalid api key|unauthorized|forbidden|authentication/i.test(msg)) {
        throw new ProviderError(401, msg, data);
      }
      throw new ProviderError(res.status === 200 ? 500 : res.status, msg, data);
    }

    const d = r.data;
    if (!d) return { status: "processing" };
    const state = d.state || d.stateStr || "";
    const status = stateToStatus(state);

    if (status === "completed") {
      const urls = extractResultUrls(d.resultJson);
      return { status: "completed", urls, progress: 100 };
    }
    if (status === "failed") {
      return { status: "failed", error: d.failMsg || d.fail_msg || "غير معروف" };
    }

    // قيد المعالجة — استخراج النسبة إن وُجدت
    let progress = 0;
    if (typeof d.progress === "number") {
      progress = d.progress <= 1 ? Math.round(d.progress * 100) : Math.round(d.progress);
    } else if (typeof d.process === "string") {
      const m = d.process.match(/(\d+)/);
      if (m) progress = parseInt(m[1], 10);
    }
    return { status: "processing", progress: Math.max(0, Math.min(99, progress)) };
  },
};
