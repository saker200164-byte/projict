# MCP Media Generator

> خادم MCP (Model Context Protocol) لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج عدة مقاطع في فيديو واحد — مع لوحة إدارة عربية RTL وواجهة برمجية لدمج الفيديو.

## المميزات

- **5 أدوات MCP** على المسار `/mcp`:
  - `generate_image` — توليد صور بـ `gpt-image-2-6/flare-text-to-image`
  - `generate_video` — توليد فيديو بصوت متزامن بـ `grok-imagine-video-1-5-preview`
  - `merge_videos` — دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب
  - `get_task` — تتبع أي مهمة بمعرّفها حتى الاكتمال
  - `list_media` — استرجاع أحدث الوسائط المولّدة
- **تبديل تلقائي تسلسلي للمفاتيح** عند أي فشل (نفاد رصيد، مفتاح خاطئ، حدّ معدّل) — يستأنف نفس المهمة بنفس `task_id` على المفتاح التالي دون أن يرى العميل أي خطأ.
- **لا تنزيل للوسائط على السيرفر** — تُخزّن روابط النتائج فقط في Turso.
- **خدمة دمج فيديو مدمجة** على `/api/jobs` (FFmpeg داخل الدالة، H.264 + AAC CRF 18، حتى 1080p).
- **واجهة إدارة عربية RTL**: مدير مفاتيح، لوحة مهام حية، إعدادات ربط جاهزة للنسخ.
- **واجهة دمج فيديو منفصلة** على `/merger` (تيم داكن، سحب وإفلات، إعادة ترتيب، رفع بأجزاء).

## التقنيات

- Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + shadcn/ui
- `@modelcontextprotocol/sdk` (McpServer + StreamableHTTPServerTransport)
- `@libsql/client` مع Turso عبر HTTP
- `ffmpeg-static` + `ffprobe-static` للدمج داخل دالة Vercel serverless

## متغيرات البيئة (إلزامية على Vercel)

انسخ `.env.example` إلى `.env.local` محليًا واملأ القيم، ثم أضِف نفس القيم في Vercel → Settings → Environment Variables:

| المتغير | الوصف | إلزامي |
|---|---|---|
| `TURSO_DATABASE_URL` | رابط قاعدة Turso مثل `libsql://<db>-<org>.turso.io` | نعم |
| `TURSO_AUTH_TOKEN` | توكن Turso بصلاحيات كتابة | نعم |
| `MCP_ACCESS_TOKEN` | إن ضُبط يُطلب Bearer على `/mcp` | اختياري |
| `MAX_SOURCES` | أقصى عدد مقاطع للدمج (افتراضي 10) | اختياري |
| `SOURCE_MAX_MB` | أقصى حجم لكل مصدر (افتراضي 200) | اختياري |
| `OUTPUT_MAX_MB` | أقصى حجم للناتج (افتراضي 150) | اختياري |
| `MAX_TOTAL_DURATION_SEC` | أقصى مجموع مدد (افتراضي 600) | اختياري |
| `FFMPEG_PRESET` | preset لـ ffmpeg (افتراضي medium) | اختياري |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | تجاوز أسماء الموديلات | اختياري |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | تجاوز أسماء الموديلات | اختياري |

> **ملاحظة أمنية:** `.env*` مُستثنى من Git منذ اليوم الأول. لا تُرفع أسرارًا إلى المستودع.

## إنشاء قاعدة Turso

```bash
# ثبّت أداة Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# أنشئ قاعدة بيانات مجانية
turso db create media-generator

# اجلب رابط القاعدة
turso db show media-generator --url

# أنشئ توكن بصلاحيات كتابة
turso db tokens create media-generator
```

انسخ الرابط والتوكن وضعهما في `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN`.

## النشر على Vercel

1. ارفع المستودع إلى GitHub.
2. اربط المستودع بـ Vercel (New Project → Import).
3. أضِف متغيرات البيئة المذكورة أعلاه في Settings → Environment Variables.
4. Deploy.

البنية متوافقة مع serverless: libSQL يتصل عبر HTTP، ومسار `/mcp` يدعم الـ streaming، ولا يعتمد على أي ملف محلي دائم.

## اختبار محلي

```bash
bun install
bun run dev   # يعمل على http://localhost:3000
```

### اختبار MCP بـ curl

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <من استجابة التهيئة>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# استدعاء أداة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <نفس الجلسة>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_media","arguments":{}}}'
```

### اختبار API الدمج

```bash
# إنشاء مهمة من رابطين
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'

# تنفيذ الدمج
curl -X POST http://localhost:3000/api/jobs/<jobId>/process

# الحالة
curl http://localhost:3000/api/jobs/<jobId>

# تحميل الناتج
curl -L http://localhost:3000/api/jobs/<jobId>/video -o merged.mp4
```

## حدود خطة Vercel المجانية (يجب أن تعرفها)

- **مدة الدالة (Function duration):** 10 ثوانٍ على Hobby، يمكن رفعها إلى 300 ثانية عبر `maxDuration` في `vercel.json` (الحالي مضبوط على 300).
- **حجم الطلب (Request body):** ~4.5MB — لذلك رفع الملفات يتم بأجزاء 4MB.
- **حجم قاعدة Turso المجانية:** 9 GB تخزين + 500 قاعدة بيانات + 1 مليار صف قراءة/25 مليون كتابة شهريًا.
- **عدد عمليات النشر:** 100 عملية بناء يوميًا على Hobby.

## ربط عميل MCP

بعد النشر، انسخ الإعدادات من صفحة `/` (تبويب حسب العميل: ChatGPT / Claude Desktop / Cursor). مثال ChatGPT:

```json
{"mcpServers":{"media-generator":{"url":"https://<your-app>.vercel.app/mcp"}}}
```

## القواعد الذهبية المطبّقة

1. روابط فقط — لا تنزيل أي وسائط إلى السيرفر.
2. ترتيب المفاتيح تسلسلي صارم بترتيب الإضافة (`created_at ASC, id ASC`).
3. لا توقف عند نفاد رصيد: انتقال تلقائي للمفتاح التالي ونفس `task_id`.
4. العميل لا يرى أخطاء مفاتيح/رصيد إطلاقًا.
5. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها مع كل `get_task` (تهدئة ~45 ثانية).
6. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي؛ أخطاء الشبكة = مؤقتة.
7. ملفات الدمج تُحذف بعد 24 ساعة — مذكورة في وصف الأداة والـ instructions.
8. كل رسائل الأدوات والواجهة بالعربية (المصطلحات التقنية بالإنجليزية).
9. إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات.
10. لا أسرار في الكود أو Git.

## الترخيص

MIT
