// src/app/api/tasks/[id]/route.ts — تفاصيل مهمة واحدة
import { ensureSchema, getTask, maskKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const row = await getTask(id);
  if (!row) return Response.json({ error: "المهمة غير موجودة" }, { status: 404 });
  return Response.json({ task: row });
}
