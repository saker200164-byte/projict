// src/app/api/tasks/route.ts — قائمة المهام + الإحصائيات
import { ensureSchema, listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureSchema();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10)));
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);
  // إخفاء المفاتيح داخل attempts
  const safe = tasks.map((t) => ({
    ...t,
    attempts_json: t.attempts_json || "[]",
  }));
  return Response.json({ tasks: safe, stats });
}
