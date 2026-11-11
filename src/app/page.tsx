"use client";

import { useEffect, useState } from "react";
import { KeyManager } from "@/components/dashboard/key-manager";
import { TasksPanel } from "@/components/dashboard/tasks-panel";
import { ServerConnection } from "@/components/dashboard/server-connection";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Video, Github, ExternalLink } from "lucide-react";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  authRequired: boolean;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
    const t = setInterval(() => {
      fetch("/api/health")
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, []);

  const tursoOk = health?.database === "turso-connected";

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* الهيدر */}
      <header className="sticky top-0 z-40 border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white font-bold text-lg">
              M
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">MCP Media Generator</h1>
              <p className="text-xs text-muted-foreground leading-tight">خادم MCP لتوليد الصور والفيديو ودمج المقاطع</p>
            </div>
          </div>

          <div className="ms-auto flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={
                tursoOk ?
                  "bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-red-50 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300"
              }
            >
              {tursoOk ? "Turso متصل" : "غير متصل"}
            </Badge>
            {health?.merger?.healthy && (
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300">
                خدمة الدمج جاهزة
              </Badge>
            )}
            {health?.authRequired && (
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300">
                /mcp محمي
              </Badge>
            )}
            <Link href="/merger">
              <button className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-md border hover:bg-muted/50 transition-colors">
                <Video className="h-4 w-4" />
                أداة دمج الفيديو
              </button>
            </Link>
          </div>
        </div>
      </header>

      {/* المحتوى */}
      <main className="container mx-auto px-4 py-6 flex-1 space-y-6">
        {/* بطاقة تعريفية */}
        <section className="rounded-xl border bg-gradient-to-br from-violet-50 to-fuchsia-50 dark:from-violet-950/30 dark:to-fuchsia-950/30 p-5">
          <h2 className="text-xl font-bold mb-2">مرحبًا بك في لوحة الإدارة</h2>
          <p className="text-sm text-muted-foreground mb-3">
            يقدّم هذا الخادم خمس أدوات MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع
            تبديل تلقائي تسلسلي للمفاتيح عند أي فشل (نفاد رصيد، مفتاح خاطئ، حدود معدّل) — يتصرّف
            العميل وكأنه لا يرى أخطاء المفاتيح إطلاقًا.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            {health?.models?.map((m) => (
              <Badge key={m.canonical} variant="outline" className="font-mono">
                {m.canonical} ({m.type})
              </Badge>
            ))}
          </div>
        </section>

        {/* البطاقات الثلاث */}
        <div className="grid gap-6 lg:grid-cols-2">
          <KeyManager />
          <TasksPanel />
        </div>
        <ServerConnection />
      </main>

      {/* الفوتر */}
      <footer className="border-t mt-auto">
        <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground text-center">
          MCP Media Generator v1.2.0 — مدعوم بـ Next.js + Turso + kie.ai + CometAPI + ffmpeg
        </div>
      </footer>
    </div>
  );
}
