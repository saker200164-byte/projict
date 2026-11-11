// src/app/api/cron/route.ts — تنظيف يومي للمهام المنتهية
import { ensureSchema } from "@/lib/turso";
import { cleanupExpired } from "@/lib/merge-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  await ensureSchema();
  const n = await cleanupExpired();
  return Response.json({ ok: true, deleted: n });
}

export const POST = GET;
