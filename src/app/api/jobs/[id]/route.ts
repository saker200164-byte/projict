// src/app/api/jobs/[id]/route.ts — GET (status) + DELETE
import { ensureSchema, db } from "@/lib/turso";
import { getMergeJob, deleteMergeJob } from "@/lib/merge-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const job = await getMergeJob(id);
  if (!job) return Response.json({ error: "مهمة الدمج غير موجودة" }, { status: 404 });
  // قد يرد الجسم فيه error بدون status → عاملها failed فورًا
  if (job.error && (!job.status || job.status === "failed")) {
    return Response.json({ ...job, status: "failed" });
  }
  return Response.json(job);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const r = await db().execute({ sql: "SELECT id FROM jobs WHERE id = ?", args: [id] });
  if (r.rows.length === 0) return Response.json({ error: "مهمة الدمج غير موجودة" }, { status: 404 });
  await deleteMergeJob(id);
  return Response.json({ ok: true });
}
