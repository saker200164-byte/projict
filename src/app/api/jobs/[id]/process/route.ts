// src/app/api/jobs/[id]/process/route.ts — POST /api/jobs/{id}/process (تنفيذ الدمج، متزامن)
import { ensureSchema, db } from "@/lib/turso";
import { processMergeJob } from "@/lib/merge-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const r = await db().execute({ sql: "SELECT id, status FROM jobs WHERE id = ?", args: [id] });
  if (r.rows.length === 0) {
    return Response.json({ error: "مهمة الدمج غير موجودة" }, { status: 404 });
  }
  const status = (r.rows[0] as { status?: string }).status;
  if (status === "done") {
    // أعد النتيجة فورًا
    const r2 = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
    const row = r2.rows[0] as {
      video_url?: string | null;
      download_url?: string | null;
      size?: number | null;
      duration?: number | null;
      resolution?: string | null;
      expires_at?: string | null;
    };
    return Response.json({
      status: "done",
      videoUrl: row.video_url || `/api/jobs/${id}/video`,
      downloadUrl: row.download_url || `/api/jobs/${id}/video?download=1`,
      size: row.size ?? 0,
      duration: row.duration ?? 0,
      resolution: row.resolution ?? "",
      expiresAt: row.expires_at || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }
  if (status === "processing") {
    return Response.json({ status: "processing" }, { status: 202 });
  }
  if (status === "failed") {
    const r2 = await db().execute({ sql: "SELECT error FROM jobs WHERE id = ?", args: [id] });
    const err = (r2.rows[0] as { error?: string | null }).error || "فشل سابق";
    return Response.json({ status: "failed", error: err }, { status: 500 });
  }
  // queued أو uploading → نفّذ الدمج الآن (متزامن)
  await db().execute({ sql: "UPDATE jobs SET status='processing' WHERE id = ?", args: [id] });
  const result = await processMergeJob(id);
  if (result.status === "done") {
    return Response.json({
      status: "done",
      videoUrl: result.videoUrl,
      downloadUrl: result.downloadUrl,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }
  return Response.json({ status: "failed", error: result.error || "فشل غير معروف" }, { status: 500 });
}
