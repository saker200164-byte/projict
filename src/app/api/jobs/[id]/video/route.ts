// src/app/api/jobs/[id]/video/route.ts — بث الفيديو الناتج بدعم Range
import { ensureSchema } from "@/lib/turso";
import { readOutputRange, getOutputChunkCount } from "@/lib/merge-engine";
import { db } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const url = new URL(req.url);
  const download = url.searchParams.get("download") === "1";

  const chunkCount = await getOutputChunkCount(id);
  if (chunkCount === 0) {
    return new Response("Not Found", { status: 404 });
  }

  // اقرأ الحجم الكلي
  const total = await getTotalSize(id);
  if (total === 0) return new Response("Not Found", { status: 404 });

  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }
      const { data } = await readOutputRange(id, start, end);
      return new Response(data as unknown as BodyInit, {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(data.length),
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }

  // لا يوجد Range — اقرأ كل الناتج
  const { data } = await readOutputRange(id, 0, total - 1);
  return new Response(data as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ...(download ? { "Content-Disposition": `attachment; filename="merged-${id}.mp4"` } : {}),
    },
  });
}

async function getTotalSize(jobId: string): Promise<number> {
  const r = await db().execute({
    sql: "SELECT SUM(length(data)) AS total FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  const n = (r.rows[0] as { total?: number | null }).total ?? 0;
  return typeof n === "number" ? n : 0;
}
