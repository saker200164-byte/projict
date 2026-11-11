"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Video,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Upload,
  Download,
  Copy,
  Check,
  RefreshCw,
  Code,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface SourceItem {
  id: string;
  kind: "url" | "file";
  url?: string;
  file?: File;
  name: string;
  size: number;
  mime: string;
  uploaded?: boolean;
  uploading?: boolean;
  uploadProgress?: number;
}

interface JobStatus {
  status?: string;
  progress?: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
}

interface Config {
  maxSources: number;
  sourceMaxMb: number;
  outputMaxMb: number;
  maxTotalDurationSec: number;
  preset: string;
  chunkBytes: number;
  version: string;
}

const ACCEPTED = ".mp4,.mov,.webm,.mkv,.avi,.m4v,.mpg,.3gp";

export default function MergerPage() {
  const { toast } = useToast();
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [processing, setProcessing] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showApi, setShowApi] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // استرجاع #job=<id> من الـ URL بعد التحديث
  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.location.hash.match(/job=([a-z0-9]+)/i);
    if (m) {
      setJobId(m[1]);
    }
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {});
  }, []);

  // متابعة حالة المهمة
  const pollStatus = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/jobs/${id}`);
      if (r.status === 404) {
        setJobStatus({ status: "failed", error: "مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها)" });
        setProcessing(false);
        return;
      }
      const j: JobStatus = await r.json();
      setJobStatus(j);
      if (j.status === "done" || j.status === "failed") {
        setProcessing(false);
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch {
      /* أخطاء مؤقتة */
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    if (typeof window !== "undefined") window.location.hash = `job=${jobId}`;
    setProcessing(true);
    pollStatus(jobId);
    pollRef.current = setInterval(() => pollStatus(jobId!), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId, pollStatus]);

  const addUrl = () => {
    const u = urlInput.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      toast({ variant: "destructive", title: "خطأ", description: "الرابط يجب أن يكون http/https" });
      return;
    }
    if (sources.length >= (config?.maxSources ?? 10)) {
      toast({ variant: "destructive", title: "خطأ", description: `الحد الأقصى ${config?.maxSources ?? 10} مقاطع` });
      return;
    }
    setSources((s) => [
      ...s,
      { id: crypto.randomUUID(), kind: "url", url: u, name: u, size: 0, mime: "video/mp4" },
    ]);
    setUrlInput("");
  };

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (sources.length + arr.length > (config?.maxSources ?? 10)) {
      toast({ variant: "destructive", title: "خطأ", description: `الحد الأقصى ${config?.maxSources ?? 10} مقاطع` });
      return;
    }
    const items: SourceItem[] = arr.map((f) => ({
      id: crypto.randomUUID(),
      kind: "file",
      file: f,
      name: f.name,
      size: f.size,
      mime: f.type || "video/mp4",
    }));
    setSources((s) => [...s, ...items]);
  };

  const removeSource = (id: string) => {
    setSources((s) => s.filter((x) => x.id !== id));
  };

  const moveSource = (id: string, dir: -1 | 1) => {
    setSources((s) => {
      const i = s.findIndex((x) => x.id === id);
      if (i < 0) return s;
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const uploadFile = async (src: SourceItem, jobId: string): Promise<boolean> => {
    if (!src.file) return false;
    const chunkBytes = config?.chunkBytes ?? 2 * 1024 * 1024;
    const totalChunks = Math.ceil(src.file.size / chunkBytes);
    setSources((s) =>
      s.map((x) => (x.id === src.id ? { ...x, uploading: true, uploadProgress: 0 } : x)),
    );
    for (let k = 0; k < totalChunks; k++) {
      const slice = src.file.slice(k * chunkBytes, (k + 1) * chunkBytes);
      let ok = false;
      for (let retry = 0; retry < 3 && !ok; retry++) {
        try {
          const r = await fetch(`/api/upload?job=${jobId}&seq=${src.id}&chunk=${k}`, {
            method: "POST",
            body: slice,
            headers: { "Content-Type": "application/octet-stream" },
          });
          if (r.ok) ok = true;
        } catch {
          /* retry */
        }
      }
      if (!ok) {
        setSources((s) => s.map((x) => (x.id === src.id ? { ...x, uploading: false } : x)));
        return false;
      }
      setSources((s) =>
        s.map((x) =>
          x.id === src.id ? { ...x, uploadProgress: Math.round(((k + 1) / totalChunks) * 100) } : x,
        ),
      );
    }
    setSources((s) => s.map((x) => (x.id === src.id ? { ...x, uploading: false, uploaded: true } : x)));
    return true;
  };

  // ملاحظة: الـ seq في الرفع يجب أن يكون رقميًا — نُصلح ذلك بأن نُعطي كل مصدر رقم تسلسل
  const merge = async () => {
    if (sources.length < 2) {
      toast({ variant: "destructive", title: "خطأ", description: "الدمج يتطلب مصدرين على الأقل" });
      return;
    }
    setProcessing(true);
    setJobStatus(null);
    try {
      // إنشاء مهمة
      const urlSources = sources.filter((s) => s.kind === "url");
      const fileSources = sources.filter((s) => s.kind === "file");
      const createBody: {
        videos?: string[];
        sources?: Array<{ kind: "url" | "file"; url?: string; name?: string; size?: number; mime?: string }>;
      } = {};
      if (urlSources.length) {
        createBody.videos = urlSources.map((s) => s.url!);
      }
      if (fileSources.length) {
        createBody.sources = fileSources.map((s) => ({
          kind: "file",
          name: s.name,
          size: s.size,
          mime: s.mime,
        }));
      }
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      const j = await r.json();
      if (!r.ok) {
        toast({ variant: "destructive", title: "خطأ", description: j.error || "فشل إنشاء المهمة" });
        setProcessing(false);
        return;
      }
      const newJobId = j.jobId;
      setJobId(newJobId);

      // رفع الملفات (إن وُجدت) — نحتاج خريطة seq
      // سنرفع الملفات بأرقام تسلسلية متساوية لموضعها في القائمة الكاملة
      // لكن الـ API يتوقع seq رقمي. نُعطي الملفات seq بناءً على موقعها الكامل
      if (fileSources.length) {
        const seqMap = new Map<string, number>();
        let seqIdx = 0;
        for (const s of sources) {
          if (s.kind === "file") seqMap.set(s.id, seqIdx + urlSources.length);
          seqIdx++;
        }
        // رفع كل ملف على حدى — لكن نريد إعادة استخدام دالة uploadFile مع seq صحيح
        // نُعدّل مؤقتًا بإرسال الرفع يدويًا
        for (const s of fileSources) {
          const seq = seqMap.get(s.id)!;
          const ok = await uploadFileWithSeq(s, newJobId, seq);
          if (!ok) {
            toast({ variant: "destructive", title: "خطأ", description: `فشل رفع الملف: ${s.name}` });
            setProcessing(false);
            return;
          }
        }
      }

      // أطلق process
      const pr = await fetch(`/api/jobs/${newJobId}/process`, { method: "POST" });
      const pj = await pr.json();
      if (!pr.ok && pr.status !== 202) {
        toast({ variant: "destructive", title: "خطأ", description: pj.error || "فشل بدء الدمج" });
        setProcessing(false);
        return;
      }
      // المتابعة تتم عبر useEffect
    } catch (e) {
      toast({ variant: "destructive", title: "خطأ", description: "تعذّر الاتصال" });
      setProcessing(false);
    }
  };

  const uploadFileWithSeq = async (src: SourceItem, jobId: string, seq: number): Promise<boolean> => {
    if (!src.file) return false;
    const chunkBytes = config?.chunkBytes ?? 2 * 1024 * 1024;
    const totalChunks = Math.ceil(src.file.size / chunkBytes);
    setSources((s) => s.map((x) => (x.id === src.id ? { ...x, uploading: true, uploadProgress: 0 } : x)));
    for (let k = 0; k < totalChunks; k++) {
      const slice = src.file.slice(k * chunkBytes, (k + 1) * chunkBytes);
      let ok = false;
      for (let retry = 0; retry < 3 && !ok; retry++) {
        try {
          const r = await fetch(`/api/upload?job=${jobId}&seq=${seq}&chunk=${k}`, {
            method: "POST",
            body: slice,
            headers: { "Content-Type": "application/octet-stream" },
          });
          if (r.ok) ok = true;
        } catch {
          /* retry */
        }
      }
      if (!ok) {
        setSources((s) => s.map((x) => (x.id === src.id ? { ...x, uploading: false } : x)));
        return false;
      }
      setSources((s) =>
        s.map((x) =>
          x.id === src.id ? { ...x, uploadProgress: Math.round(((k + 1) / totalChunks) * 100) } : x,
        ),
      );
    }
    setSources((s) => s.map((x) => (x.id === src.id ? { ...x, uploading: false, uploaded: true } : x)));
    return true;
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  const reset = () => {
    setSources([]);
    setJobId(null);
    setJobStatus(null);
    setProcessing(false);
    if (typeof window !== "undefined") window.location.hash = "";
  };

  const formatSize = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };

  const remainingTime = () => {
    if (!jobStatus?.expiresAt) return null;
    const ms = new Date(jobStatus.expiresAt).getTime() - Date.now();
    if (ms <= 0) return "انتهت الصلاحية";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h}س ${m}د ${s}ث`;
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-violet-950 to-slate-900 text-white">
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        {/* الهيدر */}
        <header className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center">
            <Video className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">أداة دمج الفيديو</h1>
            <p className="text-sm text-slate-300">ادمج عدة مقاطع في فيديو واحد عالي الجودة — الروابط أو الملفات المرفوعة.</p>
          </div>
        </header>

        {/* النموذج */}
        {!jobStatus?.videoUrl && (
          <section className="space-y-4 mb-6">
            {/* إضافة رابط */}
            <div className="flex gap-2">
              <Input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addUrl()}
                placeholder="ألصق رابط فيديو مباشر (mp4/mov/webm...)"
                className="bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-400"
                dir="ltr"
              />
              <Button onClick={addUrl} variant="secondary">
                <Plus className="h-4 w-4 ml-1" />
                إضافة
              </Button>
            </div>

            {/* منطقة السحب والإفلات */}
            <div
              ref={dropRef}
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl border-2 border-dashed border-slate-600 bg-slate-800/30 p-6 text-center cursor-pointer hover:bg-slate-800/50 transition-colors"
            >
              <Upload className="h-8 w-8 mx-auto mb-2 text-slate-400" />
              <p className="text-sm text-slate-300">اسحب وأفلت ملفات الفيديو هنا أو انقر للاختيار</p>
              <p className="text-xs text-slate-500 mt-1">mp4, mov, webm, mkv, avi, m4v, mpg, 3gp</p>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED}
                multiple
                className="hidden"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
            </div>

            {/* قائمة المصادر */}
            {sources.length > 0 && (
              <div className="space-y-2">
                {sources.map((s, i) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-sm"
                  >
                    <span className="font-mono text-slate-400 w-6 text-center">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate" dir="auto">{s.name}</div>
                      <div className="text-xs text-slate-400">
                        {s.kind === "url" ? "رابط مباشر" : "ملف مرفوع"} — {formatSize(s.size)}
                        {s.uploading && ` — رفع ${s.uploadProgress ?? 0}%`}
                        {s.uploaded && " — ✓"}
                      </div>
                      {s.uploading && <Progress value={s.uploadProgress ?? 0} className="h-1 mt-1" />}
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => moveSource(s.id, -1)} disabled={i === 0}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => moveSource(s.id, 1)} disabled={i === sources.length - 1}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => removeSource(s.id)}>
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* زر الدمج */}
            <Button
              onClick={merge}
              disabled={processing || sources.length < 2}
              className="w-full bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white font-bold py-3"
            >
              {processing ? (
                <><Loader2 className="h-4 w-4 ml-2 animate-spin" /> جارٍ الدمج…</>
              ) : (
                <><Video className="h-4 w-4 ml-2" /> دمج الفيديوهات ({sources.length})</>
              )}
            </Button>
          </section>
        )}

        {/* شريط التقدم */}
        {processing && jobStatus && (
          <section className="mb-6 rounded-xl border border-slate-700 bg-slate-800/50 p-4">
            <div className="flex items-center justify-between mb-2 text-sm">
              <span>قيد المعالجة…</span>
              <span className="text-slate-400">{jobStatus.progress ?? 0}%</span>
            </div>
            <Progress value={jobStatus.progress ?? 0} className="h-3" />
            {jobStatus.error && (
              <p className="text-xs text-red-400 mt-2">{jobStatus.error}</p>
            )}
          </section>
        )}

        {/* صفحة النتيجة */}
        {jobStatus?.videoUrl && (
          <section className="mb-6 rounded-xl border border-emerald-700 bg-emerald-950/30 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Check className="h-5 w-5 text-emerald-400" />
              <h2 className="text-lg font-bold text-emerald-300">تم الدمج بنجاح</h2>
            </div>
            <video
              src={jobStatus.videoUrl}
              controls
              className="w-full rounded-lg bg-black max-h-[60vh]"
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Info label="الحجم" value={jobStatus.size ? formatSize(jobStatus.size) : "—"} />
              <Info label="المدة" value={jobStatus.duration ? `${jobStatus.duration.toFixed(1)}ث` : "—"} />
              <Info label="الدقة" value={jobStatus.resolution || "—"} />
              <Info label="متبقٍّ" value={remainingTime() || "—"} />
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={jobStatus.downloadUrl || `${jobStatus.videoUrl}?download=1`} target="_blank" rel="noreferrer">
                <Button variant="secondary">
                  <Download className="h-4 w-4 ml-1" />
                  تحميل
                </Button>
              </a>
              <Button variant="outline" onClick={() => copyText(jobStatus.videoUrl!, "url")}>
                {copied === "url" ? <Check className="h-4 w-4 ml-1" /> : <Copy className="h-4 w-4 ml-1" />}
                نسخ الرابط
              </Button>
              <Button variant="ghost" onClick={reset}>
                <RefreshCw className="h-4 w-4 ml-1" />
                عملية جديدة
              </Button>
            </div>
          </section>
        )}

        {/* خطأ */}
        {jobStatus?.status === "failed" && (
          <section className="mb-6 rounded-xl border border-red-700 bg-red-950/30 p-4">
            <h2 className="font-bold text-red-300 mb-1">فشل الدمج</h2>
            <p className="text-sm text-red-200">{jobStatus.error || "خطأ غير معروف"}</p>
            <Button variant="ghost" className="mt-2" onClick={reset}>
              <RefreshCw className="h-4 w-4 ml-1" />
              إعادة المحاولة
            </Button>
          </section>
        )}

        {/* الحدود */}
        {config && (
          <section className="mb-6 text-xs text-slate-400 rounded-lg border border-slate-700 p-3">
            <p className="font-medium text-slate-300 mb-1">الحدود:</p>
            <ul className="space-y-1">
              <li>أقصى عدد مقاطع: {config.maxSources}</li>
              <li>أقصى حجم لكل مصدر: {config.sourceMaxMb}MB</li>
              <li>أقصى حجم للناتج: {config.outputMaxMb}MB</li>
              <li>أقصى مجموع مدد: {config.maxTotalDurationSec}ث</li>
              <li>تُحذف كل الملفات تلقائيًا بعد 24 ساعة</li>
            </ul>
          </section>
        )}

        {/* توثيق API */}
        <section className="rounded-xl border border-slate-700 bg-slate-800/50">
          <button
            onClick={() => setShowApi(!showApi)}
            className="w-full p-3 flex items-center justify-between text-sm hover:bg-slate-800/70"
          >
            <span className="flex items-center gap-2 font-medium">
              <Code className="h-4 w-4" />
              توثيق API للمطورين
            </span>
            <span>{showApi ? "▲" : "▼"}</span>
          </button>
          {showApi && (
            <div className="p-4 pt-0 space-y-3 text-xs">
              <ApiRow
                method="POST"
                path="/api/jobs"
                desc="إنشاء مهمة دمج"
                example={`curl -X POST ${origin}/api/jobs \\
  -H "Content-Type: application/json" \\
  -d '{"videos":["https://.../a.mp4","https://.../b.mp4"]}'`}
              />
              <ApiRow
                method="POST"
                path="/api/jobs/{id}/process"
                desc="تنفيذ الدمج — متزامن، يرجع النتيجة فورًا"
                example={`curl -X POST ${origin}/api/jobs/<jobId>/process`}
              />
              <ApiRow
                method="GET"
                path="/api/jobs/{id}"
                desc="الحالة + التقدم + الرابط عند الاكتمال"
                example={`curl ${origin}/api/jobs/<jobId>`}
              />
              <ApiRow
                method="GET"
                path="/api/jobs/{id}/video"
                desc="بث الناتج بدعم Range؛ ?download=1 للتحميل"
                example={`curl -L ${origin}/api/jobs/<jobId>/video -o merged.mp4`}
              />
              <ApiRow
                method="DELETE"
                path="/api/jobs/{id}"
                desc="حذف فوري شامل"
                example={`curl -X DELETE ${origin}/api/jobs/<jobId>`}
              />
              <ApiRow
                method="GET"
                path="/api/config"
                desc="الحدود العامة + version"
                example={`curl ${origin}/api/config`}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800/50 p-2">
      <div className="text-slate-400 text-xs">{label}</div>
      <div className="font-medium" dir="ltr">{value}</div>
    </div>
  );
}

function ApiRow({ method, path, desc, example }: { method: string; path: string; desc: string; example: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border-t border-slate-700 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="outline" className="font-mono text-emerald-400 border-emerald-700">{method}</Badge>
        <code className="text-slate-200" dir="ltr">{path}</code>
      </div>
      <p className="text-slate-400 mb-1">{desc}</p>
      <pre className="text-slate-300 bg-slate-900/50 rounded p-2 overflow-x-auto" dir="ltr">{example}</pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(example);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="text-xs text-slate-400 hover:text-white mt-1"
      >
        {copied ? "✓ نُسخ" : "نسخ"}
      </button>
    </div>
  );
}
