// src/app/api/health/route.ts — فحص الجهوزية
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { getConfig } from "@/lib/merge-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const turso = await dbHealthy().catch(() => false);
  if (turso) {
    await ensureSchema().catch(() => {});
  }
  const cfg = getConfig();
  // فحص خدمة الدمج: نعتبرها صحية دائمًا لأنها مدمجة في نفس المشروع
  const mergerHealthy = true;
  return Response.json({
    ok: turso && mergerHealthy,
    database: turso ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: { base: "/api/jobs", healthy: mergerHealthy, limits: cfg },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
