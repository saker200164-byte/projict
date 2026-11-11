"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Trash2, Power, PowerOff, Plus, RefreshCw, Key, Activity, Link as LinkIcon, Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ApiKey {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function KeyManager() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<"kie" | "cometapi">("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys || []);
    } catch (e) {
      toast({ variant: "destructive", title: "خطأ", description: "تعذّر تحميل المفاتيح" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ variant: "destructive", title: "خطأ", description: "المفتاح مطلوب" });
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast({ variant: "destructive", title: "خطأ", description: j.error || "فشل الإضافة" });
        return;
      }
      toast({ title: "تمت الإضافة", description: "أُضيف المفتاح بنجاح" });
      setApiKey("");
      setLabel("");
      await load();
    } catch {
      toast({ variant: "destructive", title: "خطأ", description: "تعذّر الاتصال" });
    } finally {
      setAdding(false);
    }
  };

  const toggleKey = async (k: ApiKey) => {
    const newStatus = k.status === "disabled" ? "active" : "disabled";
    try {
      const r = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!r.ok) {
        const j = await r.json();
        toast({ variant: "destructive", title: "خطأ", description: j.error });
        return;
      }
      toast({ title: newStatus === "active" ? "نُشِّط المفتاح" : "عُطِّل المفتاح" });
      await load();
    } catch {
      toast({ variant: "destructive", title: "خطأ", description: "تعذّر التحديث" });
    }
  };

  const deleteKey = async (k: ApiKey) => {
    if (!confirm(`حذف المفتاح "${k.label || k.api_key}"؟`)) return;
    try {
      const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json();
        toast({ variant: "destructive", title: "خطأ", description: j.error });
        return;
      }
      toast({ title: "حُذف المفتاح" });
      await load();
    } catch {
      toast({ variant: "destructive", title: "خطأ", description: "تعذّر الحذف" });
    }
  };

  const statusColor = (s: ApiKey["status"]) =>
    s === "active"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
      : s === "exhausted"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
        : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

  const statusLabel = (s: ApiKey["status"]) =>
    s === "active" ? "نشط" : s === "exhausted" ? "مستنزف" : "معطّل";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          مدير المفاتيح
        </CardTitle>
        <CardDescription>
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
          تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 sm:grid-cols-[140px_1fr_1fr_auto]">
          <Select value={provider} onValueChange={(v) => setProvider(v as "kie" | "cometapi")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="kie">kie.ai</SelectItem>
              <SelectItem value="cometapi">CometAPI</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="تسمية اختيارية (مثل: حساب العمل)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input
            placeholder="مفتاح API"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            dir="ltr"
          />
          <Button onClick={addKey} disabled={adding}>
            <Plus className="h-4 w-4 ml-1" />
            إضافة
          </Button>
        </div>

        {/* قائمة المفاتيح */}
        <div className="space-y-2 max-h-96 overflow-y-auto pe-1">
          {loading && <p className="text-sm text-muted-foreground py-4 text-center">جارٍ التحميل…</p>}
          {!loading && keys.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.
            </p>
          )}
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm hover:bg-muted/50 transition-colors"
            >
              <div className="flex-1 min-w-[180px]">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="font-mono">
                    {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                  </Badge>
                  <Badge className={statusColor(k.status)}>{statusLabel(k.status)}</Badge>
                  {k.label && <span className="text-muted-foreground">— {k.label}</span>}
                </div>
                <div className="font-mono text-xs text-muted-foreground" dir="ltr">{k.api_key}</div>
                <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3">
                  <span>الاستخدام: {k.usage_count}</span>
                  <span className="text-emerald-600">نجاح: {k.success_count}</span>
                  <span className="text-red-600">فشل: {k.fail_count}</span>
                  {k.last_error && (
                    <span className="text-red-600" title={k.last_error}>
                      آخر خطأ: {k.last_error.slice(0, 60)}
                      {k.last_error.length > 60 ? "…" : ""}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggleKey(k)}
                  title={k.status === "disabled" ? "تنشيط" : "تعطيل"}
                >
                  {k.status === "disabled" ? (
                    <PowerOff className="h-4 w-4" />
                  ) : (
                    <Power className="h-4 w-4" />
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteKey(k)} title="حذف">
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
