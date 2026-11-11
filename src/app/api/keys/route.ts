// src/app/api/keys/route.ts — إدارة المفاتيح (GET + POST)
import { ensureSchema, insertApiKey, listApiKeys, maskKey, findDuplicateKey } from "@/lib/turso";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSchema();
  const keys = await listApiKeys();
  const masked = keys.map((k) => ({
    ...k,
    api_key: maskKey(k.api_key),
  }));
  return Response.json({ keys: masked });
}

export async function POST(req: Request) {
  await ensureSchema();
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON غير صالح" }, { status: 400 });
  }
  const provider = body.provider;
  const apiKey = (body.api_key || "").trim();
  const label = (body.label || "").trim();
  if (!provider || !["kie", "cometapi"].includes(provider)) {
    return Response.json({ error: "provider غير صالح (kie أو cometapi)" }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({ error: "api_key مطلوب" }, { status: 400 });
  }
  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  }
  const id = randomUUID();
  await insertApiKey({ id, provider: provider as "kie" | "cometapi", api_key: apiKey, label });
  return Response.json({ id, provider, label, status: "active" }, { status: 201 });
}
