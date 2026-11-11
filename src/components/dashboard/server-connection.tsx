"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link as LinkIcon, Copy, Check, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة بـ gpt-image-2-6/flare-text-to-image." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي بـ grok-imagine-video-1-5-preview." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب." },
  { name: "get_task", desc: "تتبع حالة أي مهمة بمعرّفها حتى الاكتمال." },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المولّدة من قاعدة البيانات." },
];

export function ServerConnection() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
    // الحصول على origin بعد التركيب (client-side فقط) — يُستخدم لربط MCP
    if (typeof window !== "undefined") {
      const o = window.location.origin;
      // نؤجّل التحديث قليلًا لتجنّب cascading renders
      const id = setTimeout(() => setOrigin(o), 0);
      return () => clearTimeout(id);
    }
  }, []);

  const mcpUrl = `${origin}/mcp`;
  const token = health?.authRequired ? "<your-mcp-access-token>" : "";

  const configs = {
    chatgpt: {
      title: "ChatGPT / GPT Agents SDK",
      json:
        token ?
          JSON.stringify(
            { mcpServers: { "media-generator": { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
            null,
            2,
          )
        : JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl } } }, null, 2),
      note: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
    },
    claude: {
      title: "Claude Desktop (claude_desktop_config.json)",
      json: JSON.stringify(
        {
          mcpServers: {
            "media-generator": {
              type: "http",
              url: mcpUrl,
              ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
            },
          },
        },
        null,
        2,
      ),
      note: "ضع هذا في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
    },
    cursor: {
      title: "Cursor / Windsurf / Cline (mcp.json)",
      json: JSON.stringify(
        {
          mcpServers: {
            "media-generator": {
              url: mcpUrl,
              ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
            },
          },
        },
        null,
        2,
      ),
      note: "ضع هذا في ملف mcp.json داخل مجلد الإعداد الخاص بالأداة.",
    },
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
    toast({ title: "نُسخ", description: "نُسخ إلى الحافظة" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="h-5 w-5" />
          ربط السيرفر
        </CardTitle>
        <CardDescription>انسخ الإعدادات الجاهزة لأي عميل MCP.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* رابط MCP */}
        <div>
          <label className="text-sm font-medium mb-1 block">رابط خادم MCP</label>
          <div className="flex gap-2">
            <Input value={mcpUrl} readOnly dir="ltr" />
            <Button variant="outline" size="icon" onClick={() => copy(mcpUrl, "url")}>
              {copied === "url" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* تبويبات */}
        <Tabs defaultValue="chatgpt">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor / Windsurf</TabsTrigger>
          </TabsList>
          {(["chatgpt", "claude", "cursor"] as const).map((k) => (
            <TabsContent key={k} value={k} className="space-y-2">
              <pre className="text-xs rounded-lg border bg-muted/50 p-3 overflow-x-auto max-h-64" dir="ltr">
                {configs[k].json}
              </pre>
              <p className="text-xs text-muted-foreground">{configs[k].note}</p>
              <Button variant="outline" size="sm" onClick={() => copy(configs[k].json, k)}>
                {copied === k ? <Check className="h-4 w-4 ml-1" /> : <Copy className="h-4 w-4 ml-1" />}
                نسخ JSON
              </Button>
            </TabsContent>
          ))}
        </Tabs>

        {/* رقائق الأدوات */}
        <div>
          <div className="text-sm font-medium mb-2 flex items-center gap-1">
            <Wrench className="h-4 w-4" />
            الأدوات المتاحة
          </div>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <Badge key={t.name} variant="outline" className="font-mono text-xs" title={t.desc}>
                {t.name}
              </Badge>
            ))}
          </div>
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {TOOLS.map((t) => (
              <li key={t.name}>
                <span className="font-mono">{t.name}</span> — {t.desc}
              </li>
            ))}
          </ul>
        </div>

        {/* ملاحظة كهرمانية */}
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ —
          وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress
          notifications) حتى لا تنقطع العملية.
        </div>
      </CardContent>
    </Card>
  );
}
