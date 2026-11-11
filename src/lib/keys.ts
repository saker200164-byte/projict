// src/lib/keys.ts — نظام المفاتيح المتسلسلة: قلب المشروع
// الترتيب صارم بترتيب الإضافة (created_at ASC, id ASC) — لا round-robin ولا "الأقل استخدامًا".

import { db, listApiKeys, updateApiKey, type ApiKeyRow } from "./turso";
import { ProviderError, type ErrorClass, type ProviderId } from "./types";

/** تجلب كل المفاتيح غير المعطّلة لهذه المزودات بالترتيب الصارم. */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  const placeholders = providers.map(() => "?").join(",");
  const r = await db().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows as unknown as ApiKeyRow[];
}

/** تحديث عدّادات المفتاح بعد كل محاولة. */
export async function recordKeyUsage(
  keyId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  await db()
    .execute({
      sql: `UPDATE api_keys SET
        usage_count = usage_count + 1,
        success_count = success_count + CASE WHEN ?1 THEN 1 ELSE 0 END,
        fail_count = fail_count + CASE WHEN ?1 THEN 0 ELSE 1 END,
        last_used_at = datetime('now'),
        last_checked_at = datetime('now'),
        last_error = ?2
      WHERE id = ?3`,
      args: [ok ? 1 : 0, errorMessage ?? null, keyId],
    })
    .catch(() => {
      /* تجاهل أخطاء التحديث */
    });
}

/**
 * تصنيف أخطاء المزود (دالة موحّدة) — جدول 4.2 من البرومبت.
 * الترتيب مهم: نفحص exhausted قبل 400 لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400.
 */
export function classifyProviderError(err: ProviderError): ErrorClass {
  const status = err.status;
  // نص الرسالة موحّد لفحص الأنماط
  const msg = (err.message || "").toLowerCase();
  const bodyText =
    typeof err.body === "string"
      ? err.body.toLowerCase()
      : JSON.stringify(err.body ?? "").toLowerCase();

  // 1) disabled: 401/403 أو رسالة مصادقة
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|forbidden|authentication|auth failed|invalid_api_key/.test(msg) ||
    /invalid api key|unauthorized|forbidden|authentication/.test(bodyText)
  ) {
    return "disabled";
  }

  // 2) exhausted: 402 أو رسالة رصيد (نفحص قبل 400)
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额不足|额度|insufficient_balance|insufficient_credit/.test(
      msg,
    ) ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额不足|额度/.test(bodyText)
  ) {
    return "exhausted";
  }

  // 3) provider: الموديل غير مدعوم
  if (
    /model not found|unsupported model|model_not_found|no such model|invalid model/.test(msg) ||
    /model not found|unsupported model|model_not_found|no such model/.test(bodyText)
  ) {
    return "provider";
  }

  // 4) params: 400/422 (معطيات الطلب) — توقف فوري
  if (status === 400 || status === 422) {
    return "params";
  }

  // 5) temporary: 429, 5xx, timeout, abort
  if (
    status === 429 ||
    status >= 500 ||
    status < 0 ||
    /timeout|timed out|aborted|network|econnreset|enotfound|socket hang up|fetch failed/.test(msg)
  ) {
    return "temporary";
  }

  // 6) 404 — يعتمد على السياق؛ نعامله مؤقتًا (المزود قد يكون قد انتهى من المهمة)
  if (status === 404) {
    return "provider";
  }

  return "unknown";
}

/** تطبيق الإجراء حسب فئة الخطأ على المفتاح. */
export async function applyKeyAction(keyId: string, cls: ErrorClass): Promise<void> {
  if (cls === "disabled") {
    await updateApiKey(keyId, { status: "disabled" });
  } else if (cls === "exhausted") {
    await updateApiKey(keyId, { status: "exhausted" });
  }
  // باقي الفئات لا تغيّر حالة المفتاح
}

/** تحديث القائمة كاملة — يُعاد قراءتها بعد كل تبديل. */
export async function refreshKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  return listApiKeys().then((all) =>
    all.filter((k) => k.status !== "disabled" && providers.includes(k.provider as ProviderId)),
  );
}
