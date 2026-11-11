// src/app/mcp/route.ts — خادم MCP على المسار /mcp (Streamable HTTP)
// runtime=nodejs، dynamic=force-dynamic. يستخدم McpServer + StreamableHTTPServerTransport الرسميين.
// الأدوات بمخططات Zod (متطلب SDK).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ensureSchema, getTask, listRecentTasks } from "@/lib/turso";
import { runGeneration, refreshTask } from "@/lib/generator";
import { runMerge, refreshMergeTask } from "@/lib/merger-client";
import { MODELS } from "@/lib/models";
import { randomUUID } from "node:crypto";
import {
  generateImageSchema,
  generateVideoSchema,
  getTaskSchema,
  listMediaSchema,
  mergeVideosSchema,
} from "@/lib/mcp-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

function makeServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.tool(
    "generate_image",
    "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns the image URL when finished within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
    generateImageSchema,
    async (args) => {
      try {
        await ensureSchema();
        const res = await runGeneration({
          type: "image",
          model: args.model || "gpt-image-2-6/flare-text-to-image",
          prompt: args.prompt,
          params: {
            aspectRatio: args.aspect_ratio,
            resolution: args.resolution,
            background: args.background,
            outputFormat: args.output_format,
          },
          waitSeconds: args.wait_seconds ?? 90,
        });

        if (res.kind === "completed") {
          const url = res.urls[0];
          return {
            content: [
              { type: "text", text: `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}` },
            ],
          };
        }
        if (res.kind === "processing") {
          return {
            content: [
              {
                type: "text",
                text: `⏳ المهمة قيد المعالجة — task_id: ${res.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
              },
            ],
          };
        }
        if (res.kind === "failed") {
          return { content: [{ type: "text", text: `❌ فشلت المهمة: ${res.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: res.error }], isError: true };
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ خطأ داخلي: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );

  // 2) generate_video
  server.tool(
    "generate_video",
    "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Video takes minutes: short wait with progress then a task_id — poll with get_task every ~10 seconds.",
    generateVideoSchema,
    async (args) => {
      try {
        await ensureSchema();
        const res = await runGeneration({
          type: "video",
          model: args.model || "grok-imagine-video-1-5-preview",
          prompt: args.prompt,
          params: {
            aspectRatio: args.aspect_ratio,
            resolution: args.resolution,
            imageUrl: args.image_url,
            enableAudio: args.enable_audio,
            duration: args.duration,
          },
          waitSeconds: args.wait_seconds ?? 25,
        });

        if (res.kind === "completed") {
          const url = res.urls[0];
          return {
            content: [{ type: "text", text: `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${url}` }],
          };
        }
        if (res.kind === "processing") {
          return {
            content: [
              { type: "text", text: `⏳ المهمة قيد المعالجة — task_id: ${res.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.` },
            ],
          };
        }
        if (res.kind === "failed") {
          return { content: [{ type: "text", text: `❌ فشلت المهمة: ${res.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: res.error }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ خطأ داخلي: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // 3) merge_videos
  server.tool(
    "merge_videos",
    "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — like those from generate_video) or 'task_ids' (for COMPLETED video generation tasks, their result URLs are resolved from the DB in order — ideal after generating several clips). Merging is usually fast: short wait with progress then a task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    mergeVideosSchema,
    async (args) => {
      try {
        await ensureSchema();
        const urlsFromTasks: string[] = [];
        const failedTasks: string[] = [];
        if (args.task_ids && args.task_ids.length > 0) {
          for (const tid of args.task_ids) {
            const row = await getTask(tid);
            if (!row || row.type !== "video") {
              failedTasks.push(tid);
              continue;
            }
            const urls = row.result_urls_json ? (JSON.parse(row.result_urls_json) as string[]) : [];
            if (row.status === "completed" && urls.length > 0) {
              urlsFromTasks.push(urls[0]);
            } else {
              failedTasks.push(tid);
            }
          }
        }
        const directUrls: string[] = args.urls || [];
        const allUrls = [...urlsFromTasks, ...directUrls];

        if (allUrls.length < 2) {
          const details = failedTasks.length
            ? ` معرّفات فاشلة: ${failedTasks.join(", ")}`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${details}`,
              },
            ],
            isError: true,
          };
        }

        const res = await runMerge({
          urls: allUrls,
          waitSeconds: args.wait_seconds ?? 60,
        });

        if (res.kind === "completed") {
          const url = res.urls[0];
          return {
            content: [
              {
                type: "text",
                text: `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${url}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
              },
            ],
          };
        }
        if (res.kind === "processing") {
          return {
            content: [
              { type: "text", text: `⏳ المهمة قيد المعالجة — task_id: ${res.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.` },
            ],
          };
        }
        if (res.kind === "failed") {
          return { content: [{ type: "text", text: `❌ فشلت المهمة: ${res.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: res.error }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ خطأ داخلي: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // 4) get_task
  server.tool(
    "get_task",
    "Track any task by id — image/video generation AND merging (reads the Turso DB and updates from the provider/service if still running). Poll every ~10 seconds; when completed you'll find the result URLs — show them and stop polling.",
    getTaskSchema,
    async (args) => {
      try {
        await ensureSchema();
        const row = await getTask(args.task_id);
        if (!row) {
          return { content: [{ type: "text", text: `❌ المهمة غير موجودة: ${args.task_id}` }], isError: true };
        }
        let updated = row;
        if (row.status === "processing" || row.status === "pending") {
          if (row.type === "merge") {
            updated = (await refreshMergeTask(args.task_id)) ?? row;
          } else {
            updated = (await refreshTask(args.task_id)) ?? row;
          }
        }
        const status = updated.status;
        const progress = updated.progress ?? 0;
        const urls = updated.result_urls_json ? (JSON.parse(updated.result_urls_json) as string[]) : [];

        if (status === "completed") {
          if (updated.type === "image") {
            const url = urls[0];
            return {
              content: [{ type: "text", text: `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}` }],
            };
          }
          if (updated.type === "video") {
            const url = urls[0];
            return { content: [{ type: "text", text: `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${url}` }] };
          }
          const url = urls[0];
          return {
            content: [
              {
                type: "text",
                text: `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${url}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
              },
            ],
          };
        }
        if (status === "failed") {
          return {
            content: [{ type: "text", text: `❌ فشلت المهمة: ${updated.error_message || "غير معروف"}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `⏳ المهمة قيد المعالجة — task_id: ${args.task_id}\nالتقدم: ${progress}%\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ خطأ داخلي: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // 5) list_media
  server.tool(
    "list_media",
    "Recent images/videos/merges stored with their URLs from the database (no regeneration) — to recall previous results.",
    listMediaSchema,
    async (args) => {
      try {
        await ensureSchema();
        const rows = await listRecentTasks(args.limit ?? 10, {
          type: args.type,
          status: args.status,
        });
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "لا توجد نتائج مطابقة في قاعدة البيانات." }] };
        }
        const lines = rows.map((r) => {
          const urls = r.result_urls_json ? (JSON.parse(r.result_urls_json) as string[]) : [];
          const urlList = urls.length ? `\n  الروابط: ${urls.join(" | ")}` : "";
          return `- [${r.status}] ${r.type} | ${r.model} | task_id: ${r.id} | التقدم: ${r.progress}%${urlList}`;
        });
        return {
          content: [{ type: "text", text: `أحدث ${rows.length} مهمة:\n${lines.join("\n")}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ خطأ داخلي: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  return server;
}

// ============ route handlers ============

// خريطة الجلسات: نحتفظ بـ transport لكل session_id لتجاوز مشكلة الـ serverless stateless
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

async function checkAuth(req: Request): Promise<{ ok: boolean; status?: number; message?: string }> {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return { ok: true };
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== token) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  return { ok: true };
}

export async function POST(req: Request) {
  const auth = await checkAuth(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureSchema();

  const sessionId = req.headers.get("mcp-session-id") || undefined;

  // طلب تهيئة جديد (لا session-id) — أنشئ transport جديد
  if (!sessionId) {
    let body: { method?: string } = {};
    try {
      body = await req.clone().json();
    } catch {
      /* ignore */
    }
    if (body.method === "initialize") {
      const newSid = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSid,
        enableJsonResponse: false,
      });
      const server = makeServer();
      await server.connect(transport);
      sessions.set(newSid, { transport, server });
      // مرّر الطلب للـ transport
      const res = await transport.handleRequest(req);
      // نظّف الجلسات القديمة بعد ساعة (lazy)
      setTimeout(() => sessions.delete(newSid), 60 * 60 * 1000);
      return res;
    }
    // طلب بدون session وبدون initialize — مرفوض
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no session" }, id: null }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // طلب على جلسة قائمة
  const session = sessions.get(sessionId);
  if (!session) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Server not initialized" }, id: null }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const res = await session.transport.handleRequest(req);
  return res;
}

export async function DELETE(req: Request) {
  const auth = await checkAuth(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), {
      status: auth.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const sessionId = req.headers.get("mcp-session-id") || undefined;
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      await session.server.close().catch(() => {});
      sessions.delete(sessionId);
    }
  }
  return new Response(null, { status: 200 });
}

export async function GET(req: Request) {
  // GET يدعم SSE streaming لكن نُرجع 405 مبسّط لتفادي التعقيد
  return new Response(
    JSON.stringify({ error: "GET not supported on /mcp. Use POST with JSON-RPC." }),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST, DELETE" } },
  );
}
