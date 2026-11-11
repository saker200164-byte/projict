// src/app/api/config/route.ts — حدود الخدمة
import { getConfig } from "@/lib/merge-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getConfig());
}
