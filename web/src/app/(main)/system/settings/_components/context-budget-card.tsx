"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { CONTEXT_BUDGET_KEYS, contextBudgetFromK, readContextBudgets, type ContextBudgetKey } from "@/lib/context-budget";

const labels = { planner_context_budget_tokens: "Planner 上下文（K Token）", worker_context_budget_tokens: "Worker 上下文（K Token）" };
type Draft = Record<ContextBudgetKey, string>;

export function ContextBudgetCard() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const values = readContextBudgets(await api.settings());
      setDraft({ planner_context_budget_tokens: String(values.planner_context_budget_tokens / 1000), worker_context_budget_tokens: String(values.worker_context_budget_tokens / 1000) });
    } catch (error) {
      setLoadError((error as Error).message);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const invalid = draft !== null && CONTEXT_BUDGET_KEYS.some(key => contextBudgetFromK(draft[key]) === null);
  async function save() {
    if (!draft || invalid || loading || loadError) return;
    const patch = { planner_context_budget_tokens: contextBudgetFromK(draft.planner_context_budget_tokens)!, worker_context_budget_tokens: contextBudgetFromK(draft.worker_context_budget_tokens)! };
    setSaving(true);
    setSaved(false);
    try {
      const confirmed = readContextBudgets(await api.setSettings(patch));
      if (CONTEXT_BUDGET_KEYS.some(key => confirmed[key] !== patch[key])) throw new Error("服务端未确认保存值，请刷新后核对。");
      setSaved(true);
      toast.success("上下文配置已保存，在下一次对应执行会话启动时生效");
    } catch (error) { toast.error(`保存失败：${(error as Error).message}`); }
    finally { setSaving(false); }
  }

  return <Card className="mb-4 break-inside-avoid md:mb-6">
    <CardHeader>
      <CardTitle>Agent 上下文</CardTitle>
      <CardDescription>
        分别设置 Planner 和 Worker 的自动压缩阈值。1K = 1,000 Token；不是模型调用轮数或累计用量上限。
      </CardDescription>
    </CardHeader>
    <CardContent>
      <FieldGroup>
        {CONTEXT_BUDGET_KEYS.map(key => {
          const error = draft !== null && contextBudgetFromK(draft[key]) === null;
          return <Field key={key} data-invalid={error} data-disabled={loading || saving || !!loadError}>
            <FieldLabel htmlFor={key}>{labels[key]}</FieldLabel>
            <Input id={key} inputMode="decimal" value={draft?.[key] ?? ""} placeholder={loading ? "加载中…" : "如 48、64 或 0"}
              disabled={loading || saving || !!loadError} aria-invalid={error} aria-describedby={`${key}-help${error ? ` ${key}-error` : ""}`}
              onChange={event => { setDraft(previous => previous && { ...previous, [key]: event.target.value }); setSaved(false); }} />
            <FieldDescription id={`${key}-help`}>{key.startsWith("planner") ? "默认 48K。" : "默认 0，沿用 pi 自动策略。"} 填 0 使用 pi 自动策略；自定义范围 8.192–1000K。</FieldDescription>
            {error && <FieldError id={`${key}-error`}>请输入 0 或 8.192–1000，最多三位小数；不能为空。</FieldError>}
          </Field>;
        })}
        <FieldDescription>
          较小阈值可减少输入，但会更频繁地生成摘要。超出所选模型容量时自动收紧并预留空间；模型容量仍在 LLM 配置中设置。
          保存后不打断当前执行，下一轮 Planner、下一次 Worker 执行或恢复时生效。原始会话和证据保留。
        </FieldDescription>
        {loadError && <FieldError>{loadError}</FieldError>}
        {saved && <FieldDescription role="status">已保存 · 下一次对应执行会话生效</FieldDescription>}
      </FieldGroup>
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      {loadError ? <Button variant="outline" disabled={loading} onClick={() => void load()}>重新加载</Button> : <>
        <Button disabled={loading || saving || invalid || !draft} onClick={() => void save()}>
          {saving && <Loader2Icon data-icon="inline-start" className="animate-spin" />}保存上下文配置
        </Button>
        <Button variant="outline" disabled={loading || saving || !draft} onClick={() => { setDraft({ planner_context_budget_tokens: "48", worker_context_budget_tokens: "0" }); setSaved(false); }}>填入默认值</Button>
      </>}
    </CardFooter>
  </Card>;
}
