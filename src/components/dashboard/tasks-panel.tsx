"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw, ExternalLink, Clock } from "lucide-react";

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export function TasksPanel() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      setTasks(j.tasks || []);
      setStats(j.stats || { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch {
      /* تجاهل */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const statusBadge = (s: TaskItem["status"]) => {
    const map: Record<TaskItem["status"], { label: string; cls: string }> = {
      pending: { label: "بانتظار", cls: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
      processing: { label: "قيد المعالجة", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
      completed: { label: "مكتملة", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
      failed: { label: "فاشلة", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
    };
    const v = map[s];
    return <Badge className={v.cls}>{v.label}</Badge>;
  };

  const typeLabel = (t: TaskItem["type"]) => (t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج");
  const attempts = (j: string) => {
    try {
      const a = JSON.parse(j) as unknown[];
      return Array.isArray(a) ? a.length : 0;
    } catch {
      return 0;
    }
  };

  const resultUrl = (t: TaskItem): string | null => {
    if (!t.result_urls_json) return null;
    try {
      const urls = JSON.parse(t.result_urls_json) as string[];
      return urls[0] || null;
    } catch {
      return null;
    }
  };

  const formatDate = (s: string) => {
    try {
      const d = new Date(s.replace(" ", "T") + "Z");
      return d.toLocaleString("ar", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric" });
    } catch {
      return s;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          لوحة المهام
        </CardTitle>
        <CardDescription>تتحدث تلقائيًا كل 5 ثوانٍ.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* شرائح الإحصائيات */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatChip label="الإجمالي" value={stats.total} color="text-foreground" />
          <StatChip label="مكتملة" value={stats.completed} color="text-emerald-600" />
          <StatChip label="فاشلة" value={stats.failed} color="text-red-600" />
          <StatChip label="جارية" value={stats.processing} color="text-blue-600" />
        </div>

        {/* قائمة المهام */}
        <div className="space-y-2 max-h-[28rem] overflow-y-auto pe-1">
          {loading && <p className="text-sm text-muted-foreground py-4 text-center">جارٍ التحميل…</p>}
          {!loading && tasks.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">لا توجد مهام بعد.</p>
          )}
          {tasks.map((t) => {
            const url = resultUrl(t);
            const att = attempts(t.attempts_json);
            return (
              <div key={t.id} className="rounded-lg border p-3 text-sm hover:bg-muted/50 transition-colors">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <Badge variant="outline">{typeLabel(t.type)}</Badge>
                  {statusBadge(t.status)}
                  <span className="text-xs text-muted-foreground font-mono" dir="ltr">{t.model}</span>
                  <span className="text-xs text-muted-foreground ms-auto flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDate(t.created_at)}
                  </span>
                </div>
                {t.prompt && (
                  <p className="text-xs text-muted-foreground mb-2 line-clamp-2" dir="auto">
                    {t.prompt.slice(0, 120)}
                    {t.prompt.length > 120 ? "…" : ""}
                  </p>
                )}
                {t.status === "processing" && (
                  <div className="flex items-center gap-2 mb-2">
                    <Progress value={t.progress} className="h-2" />
                    <span className="text-xs text-muted-foreground w-10">{t.progress}%</span>
                  </div>
                )}
                {t.status === "failed" && t.error_message && (
                  <p className="text-xs text-red-600 mb-2 line-clamp-2" dir="auto">{t.error_message}</p>
                )}
                {url && (
                  <div className="flex items-center gap-2 mt-1">
                    <a href={url} target="_blank" rel="noreferrer">
                      <Button size="sm" variant="outline">
                        <ExternalLink className="h-3 w-3 ml-1" />
                        فتح الرابط
                      </Button>
                    </a>
                    {t.type === "merge" && (
                      <span className="text-xs text-amber-600">⚠️ يُحذف بعد 24 ساعة</span>
                    )}
                  </div>
                )}
                {att > 0 && (
                  <div className="text-xs text-muted-foreground mt-1">عدد المحاولات: {att}</div>
                )}
              </div>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" onClick={load} className="ms-auto flex">
          <RefreshCw className="h-4 w-4 ml-1" />
          تحديث
        </Button>
      </CardContent>
    </Card>
  );
}

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
