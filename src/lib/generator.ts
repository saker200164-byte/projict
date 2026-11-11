// src/lib/generator.ts — منسّق التوليد مع التبديل التسلسلي للمفاتيح
// التدفق (قسم 6 من البرومبت):
// 1) وحّد اسم الموديل — غير معروف → خطأ معطيات فوري
// 2) getKeyPool(providers الموديل) — فارغ → رد no_keys
// 3) سجّل المهمة في Turso قبل أي نداء خارجي
// 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
// 5) أثناء نافذة الانتظار استعلم checkTask كل 3 ثوانٍ وأرسل progress notifications
// 6) اكتمل → خزّن النتائج — فشل حقيقي → failed — فشل مفتاح/رصيد → أعد على المفتاح التالي
// 7) انتهت النافذة → أعد المهمة processing مع task_id

import { randomUUID } from "node:crypto";
import {
  getTask,
  insertTask,
  updateTask,
  type AttemptEntry,
  type TaskRow,
} from "./turso";
import {
  applyKeyAction,
  getKeyPool,
  recordKeyUsage,
} from "./keys";
import { resolveModel } from "./models";
import { getProvider } from "./providers";
import {
  ProviderError,
  type ProviderId,
  type ProviderInput,
  type MediaType,
} from "./types";

export interface GenerateInput {
  type: MediaType;
  model: string;
  prompt: string;
  params: Omit<ProviderInput, "prompt" | "model">;
  waitSeconds: number;
  /** رد اتصال لبث التقدم أثناء نافذة الانتظار. */
  onProgress?: (progress: number, message: string) => void;
}

export type GenerateResult =
  | { kind: "completed"; taskId: string; urls: string[] }
  | { kind: "processing"; taskId: string; progress: number; message: string }
  | { kind: "failed"; taskId: string; error: string }
  | { kind: "no_keys"; error: string }
  | { kind: "bad_model"; error: string };

// آخر مرة حاولنا فيها مهمة معلّقة (لمنع الضغط على المزود — تهدئة ~45 ثانية)
const PENDING_RETRY_TS = new Map<string, number>();
const PENDING_COOLDOWN_MS = 45_000;

/** ساعة تخزن آخر مفتاح استُخدم لكل مهمة لتجنب إعادة المحاولة من البداية */
const TASK_LAST_KEY = new Map<string, string>();

/**
 * المنسّق الرئيسي: ينشئ المهمة، يجرّب المفاتيح بالترتيب، يتابع التقدم، ويعيد نتيجة.
 */
export async function runGeneration(input: GenerateInput): Promise<GenerateResult> {
  const modelDef = resolveModel(input.model);
  if (!modelDef) {
    return { kind: "bad_model", error: `موديل غير معروف: ${input.model}` };
  }
  if (modelDef.type !== input.type) {
    return {
      kind: "bad_model",
      error: `الموديل ${modelDef.canonical} لا يدعم النوع ${input.type}`,
    };
  }

  const taskId = randomUUID();
  const paramsJson = JSON.stringify({ ...input.params, model: modelDef.canonical });

  // سجّل المهمة قبل أي نداء خارجي (حتى لو انقطع الاتصال تبقى قابلة للتتبع)
  await insertTask({
    id: taskId,
    provider: null,
    model: modelDef.canonical,
    type: input.type,
    prompt: input.prompt,
    params_json: paramsJson,
    status: "pending",
    progress: 0,
  });

  return continueGeneration(taskId, modelDef.canonical, input);
}

/**
 * يتابع توليد مهمة قائمة (يُستدعى من get_task أو بعد تبديل المفتاح).
 * يجرّب المفاتيح بالترتيب من البداية أو من حيث توقف، ويعيد الحالة النهائية أو الجارية.
 */
export async function continueGeneration(
  taskId: string,
  canonicalModel: string,
  input: GenerateInput,
): Promise<GenerateResult> {
  const modelDef = resolveModel(canonicalModel);
  if (!modelDef) {
    await updateTask(taskId, { status: "failed", error_message: `موديل غير معروف: ${canonicalModel}` });
    return { kind: "failed", taskId, error: `موديل غير معروف: ${canonicalModel}` };
  }

  const providersList = modelDef.providers;
  const pool = await getKeyPool(providersList);
  if (pool.length === 0) {
    await updateTask(taskId, {
      status: "processing",
      error_message: "بانتظار توفر مفتاح صالح…",
      progress: 0,
    });
    return {
      kind: "processing",
      taskId,
      progress: 0,
      message: "❌ لا توجد مفاتيح نشطة لخدمة هذا الموديل. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.",
    };
  }

  // ابدأ من المفتاح الذي توقفنا عنده إن وُجد
  const lastKeyId = TASK_LAST_KEY.get(taskId);
  let startIndex = 0;
  if (lastKeyId) {
    const idx = pool.findIndex((k) => k.id === lastKeyId);
    if (idx >= 0) startIndex = idx;
  }

  const fullInput: ProviderInput = {
    prompt: input.prompt,
    model: modelDef.canonical,
    ...input.params,
  };

  // 1) جرّب إنشاء المهمة على المفاتيح بالترتيب
  let created: { providerId: ProviderId; keyId: string; providerTaskId: string } | null = null;

  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const providerId = key.provider as ProviderId;
    const provider = getProvider(providerId);
    const providerModelName = modelDef.providerModel[providerId];
    const localInput: ProviderInput = { ...fullInput, model: providerModelName };

    try {
      // صورة متزامنة أولًا إن أمكن
      if (input.type === "image" && provider.createImageSync) {
        const sync = await provider.createImageSync(key.api_key, providerModelName, localInput);
        await recordKeyUsage(key.id, true);
        await updateTask(taskId, {
          provider: providerId,
          provider_task_id: null,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(sync.urls),
          addAttempt: {
            provider: providerId,
            keyId: key.id,
            keyLabel: key.label || maskInline(key.api_key),
            ok: true,
            at: new Date().toISOString(),
          } satisfies AttemptEntry,
        });
        TASK_LAST_KEY.delete(taskId);
        return { kind: "completed", taskId, urls: sync.urls };
      }

      const r = await provider.createTask(key.api_key, providerModelName, localInput);
      await recordKeyUsage(key.id, true);
      created = { providerId, keyId: key.id, providerTaskId: r.providerTaskId };
      await updateTask(taskId, {
        provider: providerId,
        provider_task_id: r.providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        addAttempt: {
          provider: providerId,
          keyId: key.id,
          keyLabel: key.label || maskInline(key.api_key),
          ok: true,
          at: new Date().toISOString(),
        } satisfies AttemptEntry,
      });
      TASK_LAST_KEY.set(taskId, key.id);
      break;
    } catch (err) {
      const perr = err instanceof ProviderError ? err : new ProviderError(500, String(err));
      const cls = classify(perr);
      await recordKeyUsage(key.id, false, perr.message);
      await applyKeyAction(key.id, cls);
      const attempt: AttemptEntry = {
        provider: providerId,
        keyId: key.id,
        keyLabel: key.label || maskInline(key.api_key),
        ok: false,
        errorClass: cls,
        error: perr.message,
        at: new Date().toISOString(),
      };
      await updateTask(taskId, { addAttempt: attempt });

      // خطأ معطيات → توقف فوري (تبديل المفاتيح لن يحل خطأ معطيات)
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: perr.message });
        TASK_LAST_KEY.delete(taskId);
        return { kind: "failed", taskId, error: perr.message };
      }
      // وإلا انتقل للمفتاح التالي
      continue;
    }
  }

  if (!created) {
    // فشل الإنشاء على كل المفاتيح — تبقى processing وتُعاد المحاولة لاحقًا
    await updateTask(taskId, {
      status: "processing",
      error_message: "بانتظار توفر مفتاح صالح…",
      progress: 0,
    });
    return {
      kind: "processing",
      taskId,
      progress: 0,
      message: "⏳ المهمة قيد المعالجة — task_id: " + taskId + "\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
    };
  }

  // 2) أثناء نافذة الانتظار: استعلم checkTask كل 3 ثوانٍ وأبثّ التقدم
  const waitMs = Math.max(0, Math.min(240, input.waitSeconds)) * 1000;
  const start = Date.now();
  const intervalMs = 3000;
  const provider = getProvider(created.providerId);
  const keyRow = pool.find((k) => k.id === created!.keyId)!;

  while (Date.now() - start < waitMs) {
    try {
      const r = await provider.checkTask(keyRow.api_key, created.providerTaskId);
      if (r.status === "completed" && r.urls && r.urls.length > 0) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(r.urls),
        });
        TASK_LAST_KEY.delete(taskId);
        return { kind: "completed", taskId, urls: r.urls };
      }
      if (r.status === "failed") {
        // تحقق هل الفشل بسبب مفتاح/رصيد → أعد الإنشاء على المفتاح التالي بنفس task_id
        if (/insufficient|balance|credit|quota|402|401|unauthorized|exhausted/i.test(r.error || "")) {
          TASK_LAST_KEY.set(taskId, keyRow.id);
          // انتقل للمفتاح التالي
          const nextInput: GenerateInput = { ...input, waitSeconds: 0 };
          return continueGenerationNextKey(taskId, canonicalModel, nextInput, keyRow.id);
        }
        await updateTask(taskId, { status: "failed", error_message: r.error || "فشل غير معروف" });
        TASK_LAST_KEY.delete(taskId);
        return { kind: "failed", taskId, error: r.error || "فشل غير معروف" };
      }
      // قيد المعالجة — حدّث التقدم
      const prog = r.progress ?? 0;
      await updateTask(taskId, { status: "processing", progress: prog });
      input.onProgress?.(prog, `قيد التوليد… ${prog}%`);
    } catch (err) {
      const perr = err instanceof ProviderError ? err : new ProviderError(500, String(err));
      const cls = classify(perr);
      await recordKeyUsage(keyRow.id, false, perr.message);
      await applyKeyAction(keyRow.id, cls);
      const attempt: AttemptEntry = {
        provider: created.providerId,
        keyId: keyRow.id,
        keyLabel: keyRow.label || maskInline(keyRow.api_key),
        ok: false,
        errorClass: cls,
        error: perr.message,
        at: new Date().toISOString(),
      };
      await updateTask(taskId, { addAttempt: attempt });
      // إن كان خطأ مفتاح/رصيد → انتقل للتالي
      if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
        TASK_LAST_KEY.set(taskId, keyRow.id);
        return continueGenerationNextKey(taskId, canonicalModel, input, keyRow.id);
      }
      // params → توقف
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: perr.message });
        TASK_LAST_KEY.delete(taskId);
        return { kind: "failed", taskId, error: perr.message };
      }
      // temporary → تابع الاستعلام
    }
    await sleep(intervalMs);
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة processing
  const row = await getTask(taskId);
  return {
    kind: "processing",
    taskId,
    progress: row?.progress ?? 0,
    message: "⏳ المهمة قيد المعالجة — task_id: " + taskId + "\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
  };
}

/** يتابع التوليد على المفتاح التالي بعد فشل المفتاح الحالي (نفس task_id). */
async function continueGenerationNextKey(
  taskId: string,
  canonicalModel: string,
  input: GenerateInput,
  usedKeyId: string,
): Promise<GenerateResult> {
  // ابحث عن المفتاح التالي بعد usedKeyId في القائمة
  const modelDef = resolveModel(canonicalModel);
  if (!modelDef) {
    await updateTask(taskId, { status: "failed", error_message: `موديل غير معروف` });
    return { kind: "failed", taskId, error: `موديل غير معروف` };
  }
  const pool = await getKeyPool(modelDef.providers);
  const idx = pool.findIndex((k) => k.id === usedKeyId);
  // إن لم يعد المفتاح موجودًا (تعطّل) نبدأ من الأول
  const next = idx >= 0 ? pool.slice(idx + 1) : pool;
  if (next.length === 0) {
    // لا يوجد مفتاح تالٍ — المهمة تبقى processing وتُعاد مع كل get_task
    await updateTask(taskId, {
      status: "processing",
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return {
      kind: "processing",
      taskId,
      progress: 0,
      message: "⏳ المهمة قيد المعالجة — task_id: " + taskId + "\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
    };
  }
  // ضع lastKey على المفتاح التالي ليبدأ منه
  TASK_LAST_KEY.set(taskId, next[0].id);
  // أعد المحاولة بوقت انتظار كامل
  return continueGeneration(taskId, canonicalModel, { ...input, waitSeconds: input.waitSeconds });
}

/**
 * يحدّث مهمة جارية عند استدعاء get_task (من المزود، مع منطق إعادة المحاولة/التبديل).
 * يطبّق تهدئة ~45 ثانية لإعادة المحاولة على المهام المعلّقة بانتظار مفتاح.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  const row = await getTask(taskId);
  if (!row) return null;
  if (row.status === "completed" || row.status === "failed") return row;

  // مهمة دمج — يحدّثها refreshMergeTask (منفصل)
  if (row.type === "merge") return row;

  // تهدئة لإعادة المحاولة على المهام المعلّقة بانتظار مفتاح
  if (row.error_message && row.error_message.includes("بانتظار توفر مفتاح")) {
    const last = PENDING_RETRY_TS.get(taskId) ?? 0;
    if (Date.now() - last < PENDING_COOLDOWN_MS) return row;
    PENDING_RETRY_TS.set(taskId, Date.now());
  }

  // أعد بناء GenerateInput من params_json
  const params = JSON.parse(row.params_json || "{}") as Omit<ProviderInput, "prompt" | "model">;
  const input: GenerateInput = {
    type: row.type,
    model: row.model,
    prompt: row.prompt,
    params,
    waitSeconds: 0, // لا ننتظر في get_task — فقط تحديث
  };

  await continueGeneration(taskId, row.model, input);
  return getTask(taskId);
}

function classify(err: ProviderError) {
  // نستورد دالة classify من keys.ts هنا بشكل دائري آمن عبر استيراد ديناميكي
  // لكن为了避免 دائرة استيراد، نُكرّر المنطق هنا بشكل مختصر
  // (النسخة الكاملة في keys.ts ونعيد استخدامها)
  return classifyLocal(err);
}

import { classifyProviderError } from "./keys";
function classifyLocal(err: ProviderError) {
  return classifyProviderError(err);
}

function maskInline(key: string): string {
  if (!key) return "";
  if (key.length <= 11) return `${key.slice(0, 3)}••••`;
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
