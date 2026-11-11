// src/lib/types.ts — أنواع مشتركة بين المزودات والمولّد

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

/** خطأ مزود موحد: يُمرر لـ classifyProviderError لتحديد الإجراء. */
export class ProviderError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "ProviderError";
  }
}

/** فئة الخطأ وتُحدد الإجراء المطلوب. */
export type ErrorClass =
  | "disabled" // مفتاح مرفوض — علّمه disabled وانتقل للتالي
  | "exhausted" // نفاد رصيد — علّمه exhausted وانتقل للتالي
  | "provider" // الموديل غير مدعوم — انتقل للتالي
  | "params" // معطيات الطلب خاطئة — توقف فورًا
  | "temporary" // 429/5xx/شبكة — انتقل للتالي الآن (المفتاح يبقى سليمًا)
  | "unknown"; // غير مصنف — انتقل للتالي احتراسًا

/** معطيات إنشاء مهمة لدى المزود. */
export interface ProviderInput {
  prompt: string;
  model: string; // اسم الموديل كما يُرسل للمزود
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  imageUrl?: string;
  enableAudio?: boolean;
  duration?: number;
}

/** نتيجة استعلام مهمة جارية. */
export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

/** واجهة المزود الموحّدة. */
export interface ProviderAdapter {
  id: ProviderId;
  /** مهمة غير متزامنة: تعيد معرّف المهمة لدى المزود. */
  createTask(apiKey: string, model: string, input: ProviderInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا). */
  createImageSync?(apiKey: string, model: string, input: ProviderInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية. */
  checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult>;
}
