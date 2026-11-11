// src/app/api/jobs/route.ts — POST /api/jobs (إنشاء مهمة دمج) + GET (قائمة)
import { ensureSchema, db } from "@/lib/turso";
import { createMergeJob, addFileSource, getConfig, cleanupExpired } from "@/lib/merge-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface CreateBody {
  videos?: string[];
  sources?: Array<{ kind: "url" | "file"; url?: string; name?: string; size?: number; mime?: string }>;
}

export async function POST(req: Request) {
  await ensureSchema();
  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON غير صالح" }, { status: 400 });
  }

  const cfg = getConfig();
  const videoUrls: string[] = [];
  const fileSources: Array<{ name: string; size: number; mime: string }> = [];

  if (Array.isArray(body.videos)) {
    for (const u of body.videos) {
      if (typeof u === "string" && /^https?:\/\//i.test(u)) {
        videoUrls.push(u);
      }
    }
  }
  if (Array.isArray(body.sources)) {
    for (const s of body.sources) {
      if (s.kind === "url" && s.url) {
        videoUrls.push(s.url);
      } else if (s.kind === "file" && s.name) {
        fileSources.push({ name: s.name, size: s.size ?? 0, mime: s.mime || "video/mp4" });
      }
    }
  }

  const total = videoUrls.length + fileSources.length;
  if (total < 2) {
    return Response.json({ error: "الدمج يتطلب مصدرين على الأقل" }, { status: 400 });
  }
  if (total > cfg.maxSources) {
    return Response.json({ error: `تجاوز عدد المصادر (${total} > ${cfg.maxSources})` }, { status: 400 });
  }

  const job = await createMergeJob(videoUrls);

  // إن وُجدت ملفات، أضفها كمصادر file وأعد روابط الرفع
  const uploads: Array<{ seq: number; name: string; uploadUrl: string; chunkBytes: number }> = [];
  let seqOffset = videoUrls.length;
  for (let i = 0; i < fileSources.length; i++) {
    const f = fileSources[i];
    const seq = seqOffset + i;
    await addFileSource(job.jobId, f.name, f.size, f.mime);
    uploads.push({
      seq,
      name: f.name,
      uploadUrl: `/api/upload?job=${job.jobId}&seq=${seq}&chunk=`,
      chunkBytes: cfg.chunkBytes,
    });
  }

  // تنظيف كسول للمهام المنتهية
  await cleanupExpired().catch(() => {});

  const status = uploads.length > 0 ? "uploading" : "queued";
  if (uploads.length > 0) {
    await db().execute({ sql: "UPDATE jobs SET status='uploading' WHERE id=?", args: [job.jobId] });
  }

  return Response.json(
    {
      jobId: job.jobId,
      status,
      statusUrl: `/api/jobs/${job.jobId}`,
      processUrl: `/api/jobs/${job.jobId}/process`,
      expiresAt: job.expiresAt,
      ...(uploads.length > 0 ? { uploads, uploadChunkBytes: cfg.chunkBytes } : {}),
    },
    { status: 201 },
  );
}

export async function GET() {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT id, status, progress, total_sources, video_url, download_url, size, duration, resolution, error, created_at, expires_at FROM jobs ORDER BY created_at DESC LIMIT 50",
  });
  return Response.json({ jobs: r.rows });
}
