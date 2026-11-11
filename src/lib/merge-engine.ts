// src/lib/merge-engine.ts — محرك دمج الفيديو الحقيقي (يعمل داخل Vercel serverless)
// يعتمد ffmpeg-static + ffprobe-static للمعالجة داخل الدالة نفسها.
// يخزّن النتائج في Turso على شكل أجزاء (chunks) بحد 2MB لكل صف.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { db } from "./turso";

const MAX_SOURCES = Number(process.env.MAX_SOURCES || 10);
const SOURCE_MAX_MB = Number(process.env.SOURCE_MAX_MB || 200);
const OUTPUT_MAX_MB = Number(process.env.OUTPUT_MAX_MB || 150);
const MAX_TOTAL_DURATION = Number(process.env.MAX_TOTAL_DURATION_SEC || 600);
const PRESET = process.env.FFMPEG_PRESET || "medium";
const CHUNK_BYTES = 2 * 1024 * 1024; // حد HTTP في Turso

/** يتأكد من صلاحية تنفيذ ffmpeg — قد يفقدها في الاستضافة. */
function ensureExecutable(binaryPath: string): string {
  if (!binaryPath) throw new Error("ffmpeg binary not found");
  if (existsSync(binaryPath)) {
    try {
      const st = statSync(binaryPath);
      if ((st.mode & 0o111) === 0) {
        // انسخه إلى /tmp بصلاحية 755
        const tmp = join(tmpdir(), `ffmpeg-${randomUUID()}`);
        copyFileSync(binaryPath, tmp);
        chmodSync(tmp, 0o755);
        return tmp;
      }
      return binaryPath;
    } catch {
      return binaryPath;
    }
  }
  throw new Error(`ffmpeg binary missing: ${binaryPath}`);
}

const FFMPEG = ensureExecutable(ffmpegStatic as unknown as string);
const FFPROBE = (ffprobeStatic as { path: string }).path;

/** ffprobe لمصدر: يعيد المدة، الدقة، معدل الإطارات، وجود صوت. */
export interface SourceInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export function probeSource(file: string): Promise<SourceInfo> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ];
    const proc = spawn(FFPROBE, args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${err || code}`));
        return;
      }
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s: { codec_type?: string }) => s.codec_type === "video");
        const a = (j.streams || []).find((s: { codec_type?: string }) => s.codec_type === "audio");
        const duration = parseFloat(j.format?.duration || (v?.duration ?? "0"));
        const width = v?.width || 0;
        const height = v?.height || 0;
        const fps = parseFps(v?.r_frame_rate);
        resolve({ duration: duration || 0, width, height, fps, hasAudio: !!a });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseFps(rate?: string): number {
  if (!rate) return 30;
  const m = rate.match(/^(\d+)\/(\d+)$/);
  if (m) {
    const num = parseInt(m[1], 10);
    const den = parseInt(m[2], 10);
    return den === 0 ? 30 : num / den;
  }
  const n = parseFloat(rate);
  return isNaN(n) ? 30 : n;
}

/** يحوّل النسبة إلى نص تقدم واضح. */
export function parseProgress(line: string, totalDurationUs: number): number | null {
  // out_time_us=...
  const m = line.match(/out_time_us=(\d+)/);
  if (m && totalDurationUs > 0) {
    const us = parseInt(m[1], 10);
    return Math.min(100, Math.round((us / totalDurationUs) * 100));
  }
  return null;
}

/** تنفيذ الدمج الكامل لمهمة — ينزّل/يسحب المصادر، يرمّز، يحفظ الناتج. */
export async function processMergeJob(jobId: string): Promise<{
  status: "done" | "failed";
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
}> {
  const workDir = join(tmpdir(), `merge-${jobId}-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const sourcesDir = join(workDir, "sources");
  mkdirSync(sourcesDir, { recursive: true });

  try {
    // اجلب المصادر
    const srcRows = await db().execute({
      sql: "SELECT seq, kind, url, name FROM sources WHERE job_id = ? ORDER BY seq ASC",
      args: [jobId],
    });
    if (srcRows.rows.length === 0) {
      return failed(jobId, "لا توجد مصادر للدمج");
    }
    if (srcRows.rows.length > MAX_SOURCES) {
      return failed(jobId, `تجاوز عدد المصادر (${srcRows.rows.length} > ${MAX_SOURCES})`);
    }

    const totalDurationUs = await computeTotalDurationUs(jobId);
    // نزّل/اسحب كل مصدر
    const files: string[] = [];
    let totalBytes = 0;
    let totalDuration = 0;

    for (let i = 0; i < srcRows.rows.length; i++) {
      const row = srcRows.rows[i] as { seq: number; kind: string; url: string | null; name: string | null };
      const outFile = join(sourcesDir, `src_${i}.mp4`);

      if (row.kind === "url" && row.url) {
        // تنزيل مباشر مع التحقق من الحجم أثناء التنزيل
        const res = await fetch(row.url);
        if (!res.ok || !res.body) {
          return failed(jobId, `فشل تحميل المصدر ${i + 1}: HTTP ${res.status}`);
        }
        const maxBytes = SOURCE_MAX_MB * 1024 * 1024;
        const writer = createWriteStream(outFile);
        let written = 0;
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            written += value.byteLength;
            if (written > maxBytes) {
              writer.close();
              return failed(jobId, `المصدر ${i + 1} يتجاوز الحد ${SOURCE_MAX_MB}MB`);
            }
            writer.write(Buffer.from(value));
            // تحديث التقدم 0-40% أثناء التنزيل
            const pct = Math.min(40, Math.round(((i + written / maxBytes) / srcRows.rows.length) * 40));
            await updateProgress(jobId, pct);
          }
        } finally {
          reader.releaseLock();
          writer.end();
        }
      } else if (row.kind === "file") {
        // اجمع الأجزاء من source_chunks
        await assembleFile(jobId, row.seq, outFile);
        const st = statSync(outFile);
        if (st.size > SOURCE_MAX_MB * 1024 * 1024) {
          return failed(jobId, `المصدر ${i + 1} يتجاوز الحد ${SOURCE_MAX_MB}MB`);
        }
        totalBytes += st.size;
        await updateProgress(jobId, Math.min(40, Math.round(((i + 1) / srcRows.rows.length) * 40)));
      } else {
        return failed(jobId, `نوع مصدر غير معروف: ${row.kind}`);
      }
      files.push(outFile);
    }

    // probe كل مصدر
    const infos: SourceInfo[] = [];
    for (const f of files) {
      const info = await probeSource(f);
      infos.push(info);
      totalDuration += info.duration;
    }
    if (totalDuration > MAX_TOTAL_DURATION) {
      return failed(jobId, `مجموع المدن (${totalDuration.toFixed(1)}ث) يتجاوز الحد ${MAX_TOTAL_DURATION}ث`);
    }

    // أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)
    let maxW = 0, maxH = 0;
    for (const info of infos) {
      if (info.width > maxW) maxW = info.width;
      if (info.height > maxH) maxH = info.height;
    }
    maxW = Math.min(1920, maxW);
    maxH = Math.min(1080, maxH);
    if (maxW % 2 !== 0) maxW -= 1;
    if (maxH % 2 !== 0) maxH -= 1;

    // بناء filter_complex: scale + pad + fps + setsar + format لكل مدخل، ثم concat
    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const hasAudio = infos[i].hasAudio;
      const v = `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`;
      const a = hasAudio
        ? `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        : `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${infos[i].duration.toFixed(2)}[a${i}]`;
      filterParts.push(v, a);
      concatInputs.push(`[v${i}][a${i}]`);
    }
    const filter = filterParts.join(";") + `;${concatInputs.join("")}concat=n=${files.length}:v=1:a=1[vout][aout]`;

    const outputFile = join(workDir, "output.mp4");

    // شغّل ffmpeg
    const args = [
      "-y",
      ...files.flatMap((_, i) => ["-i", files[i]]),
      "-filter_complex", filter,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", PRESET,
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      outputFile,
    ];

    await runFfmpeg(args, (line) => {
      const pct = parseProgress(line, Math.round(totalDuration * 1_000_000));
      if (pct !== null) {
        // 40-90% أثناء الترميز
        const scaled = 40 + Math.round((pct / 100) * 50);
        updateProgress(jobId, scaled).catch(() => {});
      }
    });

    // تحقق من حجم الناتج
    const outStat = statSync(outputFile);
    if (outStat.size > OUTPUT_MAX_MB * 1024 * 1024) {
      return failed(jobId, `حجم الناتج يتجاوز الحد ${OUTPUT_MAX_MB}MB`);
    }

    // probe الناتج للمدة والدقة
    const outInfo = await probeSource(outputFile);
    const resolution = `${outInfo.width}x${outInfo.height}`;

    // خزّن الناتج في output_chunks (بحد 2MB لكل صف)
    await storeOutput(jobId, outputFile);

    // حدّث المهمة
    await db().execute({
      sql: `UPDATE jobs SET status='done', progress=100, video_url=?, download_url=?, size=?, duration=?, resolution=? WHERE id=?`,
      args: [
        `/api/jobs/${jobId}/video`,
        `/api/jobs/${jobId}/video?download=1`,
        outStat.size,
        outInfo.duration,
        resolution,
        jobId,
      ],
    });
    // احذف source_chunks — الناتج فقط هو المطلوب
    await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });

    return {
      status: "done",
      videoUrl: `/api/jobs/${jobId}/video`,
      downloadUrl: `/api/jobs/${jobId}/video?download=1`,
      size: outStat.size,
      duration: outInfo.duration,
      resolution,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db().execute({ sql: "UPDATE jobs SET status='failed', error=? WHERE id=?", args: [msg, jobId] });
    return { status: "failed", error: msg };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* تجاهل */
    }
  }
}

async function computeTotalDurationUs(jobId: string): Promise<number> {
  // نحتاج probe المصادر أولاً — لكن نُحسبها داخل process loop فعليًا
  return 0; // placeholder — يُعاد حسابها عند الحاجة
}

async function updateProgress(jobId: string, progress: number) {
  await db().execute({ sql: "UPDATE jobs SET progress=? WHERE id=?", args: [progress, jobId] });
}

async function storeOutput(jobId: string, file: string) {
  const buf = await import("node:fs/promises").then((m) => m.readFile(file));
  const chunks = Math.ceil(buf.length / CHUNK_BYTES);
  for (let i = 0; i < chunks; i++) {
    const slice = buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    await db().execute({
      sql: "INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)",
      args: [jobId, i, slice],
    });
  }
}

async function assembleFile(jobId: string, seq: number, outFile: string) {
  // اقرأ الأجزاء بتدفّق صفحات 8 صفوف
  const writer = createWriteStream(outFile);
  let chunk = 0;
  const PAGE = 8;
  for (;;) {
    const r = await db().execute({
      sql: "SELECT chunk, data FROM source_chunks WHERE job_id=? AND seq=? AND chunk >= ? ORDER BY chunk ASC LIMIT ?",
      args: [jobId, seq, chunk, PAGE],
    });
    if (r.rows.length === 0) break;
    for (const row of r.rows) {
      const data = row.data as Uint8Array;
      writer.write(Buffer.from(data));
    }
    chunk += r.rows.length;
    if (r.rows.length < PAGE) break;
  }
  await new Promise<void>((resolve) => writer.end(() => resolve()));
}

function runFfmpeg(args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    let buffer = "";
    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) onLine(line);
      }
    });
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${err.slice(-2000)}`));
    });
    proc.on("error", reject);
  });
}

async function failed(jobId: string, message: string) {
  await db().execute({ sql: "UPDATE jobs SET status='failed', error=? WHERE id=?", args: [message, jobId] });
  return { status: "failed" as const, error: message };
}

/** إجمالي عدد صفوف output_chunks — يُستخدم لبث الفيديو مع Range. */
export async function getOutputChunkCount(jobId: string): Promise<number> {
  const r = await db().execute({
    sql: "SELECT COUNT(*) AS cnt FROM output_chunks WHERE job_id=?",
    args: [jobId],
  });
  const n = (r.rows[0] as { cnt?: number }).cnt ?? 0;
  return n;
}

/** يقرأ نطاقًا من البايتات من الناتج المخزّن. */
export async function readOutputRange(
  jobId: string,
  start: number,
  end: number,
): Promise<{ data: Buffer; totalSize: number }> {
  // اقرأ كل الأجزاء (نظّفها للذاكرة — الناتج بحد 150MB لكننا نقرأ النطاق المطلوب فقط)
  const firstChunk = Math.floor(start / CHUNK_BYTES);
  const lastChunk = Math.floor(end / CHUNK_BYTES);
  const offsetInFirst = start % CHUNK_BYTES;
  const offsetInLast = end % CHUNK_BYTES;

  const r = await db().execute({
    sql: "SELECT chunk, data FROM output_chunks WHERE job_id=? AND chunk >= ? AND chunk <= ? ORDER BY chunk ASC",
    args: [jobId, firstChunk, lastChunk],
  });
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for (const row of r.rows) {
    const data = Buffer.from(row.data as Uint8Array);
    chunks.push(data);
    totalSize += data.length;
  }
  if (chunks.length === 0) {
    return { data: Buffer.alloc(0), totalSize: 0 };
  }
  // اقرأ الحجم الكلي من قاعدة البيانات
  const totalR = await db().execute({
    sql: "SELECT SUM(length(data)) AS total FROM output_chunks WHERE job_id=?",
    args: [jobId],
  });
  const total = (totalR.rows[0] as { total?: number | null }).total ?? 0;

  const buf = Buffer.concat(chunks);
  // اقطع الجزء الأول والآخر
  let result = buf.subarray(offsetInFirst);
  const wantedLen = end - start + 1;
  if (result.length > wantedLen) result = result.subarray(0, wantedLen);
  return { data: result, totalSize: total };
}

/** إنشاء مهمة دمج + مصادرها في القاعدة. */
export async function createMergeJob(videos: string[]): Promise<{
  jobId: string;
  status: string;
  expiresAt: string;
}> {
  const jobId = randomUUID().replace(/-/g, "").slice(0, 12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db().execute({
    sql: `INSERT INTO jobs (id, status, progress, total_sources, expires_at) VALUES (?, 'queued', 0, ?, ?)`,
    args: [jobId, videos.length, expiresAt],
  });
  for (let i = 0; i < videos.length; i++) {
    await db().execute({
      sql: `INSERT INTO sources (job_id, seq, kind, url) VALUES (?, ?, 'url', ?)`,
      args: [jobId, i, videos[i]],
    });
  }
  // تنظيف كسول للمهام المنتهية
  await cleanupExpired().catch(() => {});
  return { jobId, status: "queued", expiresAt };
}

/** الحالة الكاملة لمهمة دمج. */
export async function getMergeJob(jobId: string): Promise<{
  status: string;
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
} | null> {
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [jobId] });
  const row = r.rows[0] as
    | { status?: string; progress?: number; video_url?: string | null; download_url?: string | null; error?: string | null }
    | undefined;
  if (!row) return null;
  // قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  if (row.error && (!row.status || row.status === "failed")) {
    return { status: "failed", progress: 100, error: row.error };
  }
  return {
    status: row.status || "queued",
    progress: row.progress ?? 0,
    videoUrl: row.video_url || undefined,
    downloadUrl: row.download_url || undefined,
    error: row.error || undefined,
  };
}

/** حذف شامل لمهمة الدمج. */
export async function deleteMergeJob(jobId: string): Promise<void> {
  await db().batch([
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
  ]);
}

/** تنظيف المهام المنتهية (24 ساعة). */
export async function cleanupExpired(): Promise<number> {
  const r = await db().execute({
    sql: "SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
  });
  let n = 0;
  for (const row of r.rows) {
    const id = (row as { id: string }).id;
    await deleteMergeJob(id);
    n++;
  }
  return n;
}

/** إضافة مصدر نوع ملف + رفع أجزائه. */
export async function addFileSource(jobId: string, name: string, size: number, mime: string): Promise<number> {
  const r = await db().execute({
    sql: "SELECT COUNT(*) AS cnt FROM sources WHERE job_id = ?",
    args: [jobId],
  });
  const seq = ((r.rows[0] as { cnt?: number }).cnt ?? 0) as number;
  await db().execute({
    sql: "INSERT INTO sources (job_id, seq, kind, name, size, mime, status) VALUES (?, ?, 'file', ?, ?, ?, 'uploading')",
    args: [jobId, seq, name, size, mime],
  });
  return seq;
}

/** رفع جزء من ملف مصدر. */
export async function uploadSourceChunk(jobId: string, seq: number, chunk: number, data: Buffer): Promise<void> {
  await db().execute({
    sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
    args: [jobId, seq, chunk, data],
  });
}

/** حدود الخدمة العامة. */
export function getConfig() {
  return {
    maxSources: MAX_SOURCES,
    sourceMaxMb: SOURCE_MAX_MB,
    outputMaxMb: OUTPUT_MAX_MB,
    maxTotalDurationSec: MAX_TOTAL_DURATION,
    preset: PRESET,
    chunkBytes: CHUNK_BYTES,
    version: "2.0.0",
  };
}
