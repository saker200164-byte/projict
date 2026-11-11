// src/lib/merger-client.ts — منسّق الدمج من داخل MCP
// يستدعي merge-engine مباشرة (لا HTTP) لتجنب self-loop في serverless.

import { randomUUID } from "node:crypto";
import { getTask, insertTask, updateTask, type AttemptEntry } from "./turso";
import { MERGER_MODEL } from "./models";
import {
  createMergeJob,
  getMergeJob,
  processMergeJob,
  deleteMergeJob,
} from "./merge-engine";

// قفل في الذاكرة لمنع تزامن process مع get_task
const processInFlight = new Set<string>();

export interface MergeInput {
  urls: string[]; // روابط مباشرة بالترتيب
  waitSeconds: number;
  onProgress?: (progress: number, message: string) => void;
}

export type MergeResult =
  | { kind: "completed"; taskId: string; urls: string[] }
  | { kind: "processing"; taskId: string; progress: number; message: string }
  | { kind: "failed"; taskId: string; error: string }
  | { kind: "bad_input"; error: string };

/**
 * تنفيذ الدمج: إنشاء مهمة + process خلفي + استعلام حتى نهاية النافذة.
 */
export async function runMerge(input: MergeInput): Promise<MergeResult> {
  // تحقق صارم: ≥2 وكلها http/https مباشرة، >10 → رفض
  if (input.urls.length < 2) {
    return {
      kind: "bad_input",
      error: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
    };
  }
  if (input.urls.length > 10) {
    return {
      kind: "bad_input",
      error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  for (const u of input.urls) {
    if (!/^https?:\/\//i.test(u)) {
      return { kind: "bad_input", error: `❌ الرابط ليس مباشرًا أو عامًا: ${u}` };
    }
  }

  const taskId = randomUUID();

  // سجّل مهمة في Turso أولًا
  await insertTask({
    id: taskId,
    provider: "merger",
    provider_task_id: null,
    model: MERGER_MODEL,
    type: "merge",
    prompt: input.urls.join("\n"),
    params_json: JSON.stringify({ urls: input.urls }),
    status: "pending",
    progress: 0,
  });

  return continueMerge(taskId, input);
}

async function continueMerge(taskId: string, input: MergeInput): Promise<MergeResult> {
  try {
    // 1) أنشئ مهمة دمج في خدمة الدمج
    const job = await createMergeJob(input.urls);
    await updateTask(taskId, {
      provider_task_id: job.jobId,
      status: "processing",
      progress: 2,
    });

    // 2) أطلق process خلفيًا بمرة واحدة فقط (قفل في الذاكرة)
    if (!processInFlight.has(job.jobId)) {
      processInFlight.add(job.jobId);
      // fire-and-forget لكن نحدث القاعدة عند الانتهاء
      processMergeJob(job.jobId)
        .catch((e) => {
          /* يُسجَّل داخل الدالة */
        })
        .finally(() => {
          processInFlight.delete(job.jobId);
        });
    }

    // 3) استعلم الحالة كل 3 ثوانٍ حتى نهاية النافذة
    const waitMs = Math.max(0, Math.min(240, input.waitSeconds)) * 1000;
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const st = await getMergeJob(job.jobId);
      if (!st) {
        // 404 → فشل نهائي
        await updateTask(taskId, {
          status: "failed",
          error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        });
        return {
          kind: "failed",
          taskId,
          error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        };
      }

      if (st.status === "done" || st.status === "completed") {
        const url = st.videoUrl || st.downloadUrl || `/api/jobs/${job.jobId}/video`;
        const fullUrl = absoluteUrl(url);
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify([fullUrl]),
          addAttempt: {
            provider: "merger",
            keyId: "",
            keyLabel: "",
            ok: true,
            at: new Date().toISOString(),
          } satisfies AttemptEntry,
        });
        return { kind: "completed", taskId, urls: [fullUrl] };
      }
      if (st.status === "failed" || (st.error && st.status !== "processing")) {
        const err = st.error || "فشل الدمج";
        await updateTask(taskId, { status: "failed", error_message: err });
        return { kind: "failed", taskId, error: err };
      }

      const prog = st.progress ?? 0;
      await updateTask(taskId, { status: "processing", progress: prog });
      input.onProgress?.(prog, `قيد الدمج… ${prog}%`);
      await sleep(3000);
    }

    // انتهت النافذة والنتيجة لم تكتمل → أعد المهمة processing
    return {
      kind: "processing",
      taskId,
      progress: 0,
      message: "⏳ المهمة قيد المعالجة — task_id: " + taskId + "\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateTask(taskId, { status: "failed", error_message: msg });
    return { kind: "failed", taskId, error: msg };
  }
}

/**
 * يحدّث مهمة دمج جارية عند استدعاء get_task.
 */
export async function refreshMergeTask(taskId: string) {
  const row = await getTask(taskId);
  if (!row) return null;
  if (row.status === "completed" || row.status === "failed") return row;
  if (!row.provider_task_id) return row;

  const jobId = row.provider_task_id;
  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن
  if (!processInFlight.has(jobId)) {
    processInFlight.add(jobId);
    processMergeJob(jobId)
      .catch(() => {})
      .finally(() => processInFlight.delete(jobId));
  }

  const st = await getMergeJob(jobId).catch(() => null);
  if (!st) {
    await updateTask(taskId, {
      status: "failed",
      error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
    });
    return getTask(taskId);
  }

  if (st.status === "done" || st.status === "completed") {
    const url = st.videoUrl || st.downloadUrl || `/api/jobs/${jobId}/video`;
    const fullUrl = absoluteUrl(url);
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify([fullUrl]),
    });
  } else if (st.status === "failed" || (st.error && st.status !== "processing")) {
    await updateTask(taskId, { status: "failed", error_message: st.error || "فشل الدمج" });
  } else {
    await updateTask(taskId, { status: "processing", progress: st.progress ?? 0 });
  }
  return getTask(taskId);
}

/** يحوّل المسار النسبي إلى رابط مطلق — يستخدم NEXT_PUBLIC_SITE_URL أو VERCEL_URL. */
function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (base) {
    const b = base.replace(/\/$/, "");
    return `${b}${path.startsWith("/") ? "" : "/"}${path}`;
  }
  // في التطوير المحلي نُرجع المسار نسبيًا — العميل يحوّله
  return path;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
