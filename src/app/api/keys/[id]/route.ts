// src/app/api/keys/[id]/route.ts — تعطيل/تنشيط (PATCH) + حذف (DELETE)
import { deleteApiKey, ensureSchema, getApiKey, maskKey, updateApiKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const row = await getApiKey(id);
  if (!row) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON غير صالح" }, { status: 400 });
  }
  if (!body.status || !["active", "disabled", "exhausted"].includes(body.status)) {
    return Response.json({ error: "status غير صالح" }, { status: 400 });
  }
  await updateApiKey(id, { status: body.status as "active" | "disabled" | "exhausted" });
  const updated = await getApiKey(id);
  return Response.json({ ...updated, api_key: maskKey(updated!.api_key) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const row = await getApiKey(id);
  if (!row) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteApiKey(id);
  return Response.json({ ok: true });
}
