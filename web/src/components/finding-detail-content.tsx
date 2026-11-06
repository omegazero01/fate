"use client";
import {FindingReproductionPanel} from "@/components/finding-reproduction";

import * as React from "react";

import Link from "next/link";

import { toast } from "sonner";

import { CopyButton } from "@/components/copy-button";
import {FindingEvidencePanel} from "@/components/finding-evidence-panel";
import { FindingDeleteDialog } from "@/components/finding-delete-dialog";
import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { FINDING_STATUSES, findingRowKey, SEVERITIES } from "@/lib/findings";
import { statusMeta } from "@/lib/status";
import type { Finding, FindingStatus, Severity } from "@/lib/types";

type DetailProps = {
  finding: Finding;
  contextTask?: string;
  onChanged?: (finding: Finding) => void;
  onDelete?: (finding: Finding, reason: string) => Promise<void>;
  onDeepen?: (finding: Finding) => void;
};

// Key the loader by provenance as well as identity: stale requests must never paint
// a different selection or carry writable data into an inherited context.
export function FindingWorkspaceDetail(props: DetailProps) {
  return <FindingDetailLoader key={`${props.contextTask ?? "global"}:${findingRowKey(props.finding)}`} {...props} />;
}

function FindingDetailLoader(props: DetailProps) {
  const { finding: summary, contextTask } = props;
  const [finding, setFinding] = React.useState<Finding | null>(summary.finding_id || contextTask ? null : summary);
  const [error, setError] = React.useState("");
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const callbacks = React.useRef(props);
  callbacks.current = props;
  React.useEffect(() => {
    // Refresh cheap list metadata without fetching reports or traffic bodies.
    setFinding((current) =>
      current
        ? {
            ...current,
            name: summary.name,
            vulnclass: summary.vulnclass,
            severity: summary.severity,
            status: summary.status,
            summary: summary.summary,
            inherited: summary.inherited,
            source_task_id: summary.source_task_id,
          }
        : current,
    );
  }, [summary]);
  React.useEffect(() => {
    void revision; // Explicit mutation/retry invalidation; not a polling dependency.
    void summary.evidence_version;
    void summary.report_evidence_version;
    if (!summary.finding_id && !contextTask) return;
    let active = true;
    const request = summary.finding_id
      ? api.getFinding(summary.finding_id, contextTask)
      : api.taskLegacyFinding(contextTask ?? "", summary.id);
    request
      .then((value) => {
        if (active) {
          setFinding(value);
          setError("");
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [
    summary.finding_id,
    summary.id,
    summary.evidence_version,
    summary.report_evidence_version,
    contextTask,
    revision,
  ]);
  const changed = React.useCallback(() => {
    refresh();
    callbacks.current.onChanged?.(callbacks.current.finding);
  }, []);
  if (error)
    return (
      <Alert>
        <AlertDescription>
          漏洞详情加载失败：{error}
          <Button variant="outline" size="sm" onClick={refresh}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!finding)
    return (
      <div className="flex min-h-48 items-center justify-center gap-2" role="status">
        <Spinner />
        加载漏洞详情…
      </div>
    );
  return (
    <FindingDetailContent
      finding={finding}
      contextTask={contextTask}
      onRefresh={changed}
      onDelete={props.onDelete}
      onDeepen={props.onDeepen}
    />
  );
}

export function FindingDetailContent({
  finding,
  contextTask,
  onRefresh,
  onDelete,
  onDeepen,
}: Omit<DetailProps, "onChanged"> & { onRefresh: () => void }) {
  const id = finding.finding_id ?? "";
  const readOnly = !!finding.inherited || !id;
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    name: finding.name ?? "",
    vulnclass: finding.vulnclass,
    severity: finding.severity,
  });
  async function mutate(action: () => Promise<unknown>) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await action();
      onRefresh();
      setEditing(false);
      toast.success("已保存");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const detailHref = id
    ? `/function/findings/detail?id=${encodeURIComponent(id)}${contextTask ? `&context_task=${encodeURIComponent(contextTask)}` : ""}`
    : null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>漏洞详情</CardTitle>
            <div className="flex flex-wrap gap-2">
              {detailHref && (
                <Button asChild variant="outline" size="sm">
                  <Link href={detailHref}>独立详情 / 链路图 ↗</Link>
                </Button>
              )}
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ name: finding.name ?? "", vulnclass: finding.vulnclass, severity: finding.severity });
                    setEditing(true);
                  }}
                >
                  编辑
                </Button>
              )}
              {!readOnly && onDeepen && finding.task_id && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => onDeepen(finding)}>
                  深化测试
                </Button>
              )}
              {!readOnly && onDelete && <FindingDeleteDialog finding={finding} disabled={busy} onDelete={onDelete} />}
            </div>
          </div>
          <h2 className="break-words font-semibold text-base">{finding.name || finding.vulnclass || "未分类"}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge domain="severity" value={finding.severity} dot />
            <StatusBadge domain="finding" value={finding.status} dot />
            {finding.inherited && (
              <Badge variant="outline">来源任务 #{finding.source_task_id || finding.task_id} · 只读</Badge>
            )}
            <span className="text-muted-foreground text-xs">{new Date(finding.ts).toLocaleString("zh-CN")}</span>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap gap-3">
            <Select
              value={finding.severity}
              disabled={readOnly || busy}
              onValueChange={(value) => void mutate(() => api.setFindingSeverity(id, value as Severity))}
            >
              <SelectTrigger aria-label="严重等级">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SEVERITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {statusMeta("severity", value).label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={finding.status}
              disabled={readOnly || busy}
              onValueChange={(value) => void mutate(() => api.setFindingStatus(id, value as FindingStatus))}
            >
              <SelectTrigger aria-label="处理状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FINDING_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {statusMeta("finding", value).label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {finding.task_id && (
              <Button variant="link" asChild>
                <Link href={`/function/tasks/detail?id=${finding.task_id}`}>任务 #{finding.task_id}</Link>
              </Button>
            )}
          </div>
          <div>
            <h3 className="mb-2 font-medium">完整摘要</h3>
            <p className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words">
              {finding.summary || "暂无摘要。"}
            </p>
          </div>
          <div>
            <h3 className="mb-2 font-medium">关联资产</h3>
            <div className="flex flex-wrap gap-2">
              {finding.assets?.length ? (
                finding.assets.map((asset) => (
                  <Badge className="max-w-full whitespace-normal break-all" key={asset.id} variant="outline">
                    {asset.type} · {asset.label}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground">暂无关联资产。</span>
              )}
            </div>
          </div>
          <details open={!finding.reproduction}><summary>原始证据与历史报告</summary>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">证据 / PoC</h3>
              {finding.evidence && <CopyButton text={finding.evidence} />}
            </div>
            <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
              {finding.evidence || "暂无证据。"}
            </pre>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">详细报告</h3>
              {finding.report && <CopyButton text={finding.report} />}
            </div>
            {finding.report_stale && (
              <Alert>
                <AlertDescription>流量证据已变更，详细报告待更新。</AlertDescription>
              </Alert>
            )}
            <div className="max-h-[60vh] overflow-auto">
              {finding.report ? (
                <Markdown text={finding.report} />
              ) : (
                <p className="text-muted-foreground">暂无详细报告。</p>
              )}
            </div>
          </div>
          </details>
        </CardContent>
      </Card>
      {id&&<FindingReproductionPanel key={`${id}:${contextTask??""}`} finding={finding} contextTask={contextTask} readOnly={readOnly} onChanged={onRefresh}/>}
      {id ? <FindingEvidencePanel finding={finding} contextTask={contextTask} readOnly={readOnly} /> : (
        <Alert>
          <AlertDescription>
            此为历史探索节点，未关联持久化漏洞记录，仅展示已有证据；不提供流量绑定或复测操作。
          </AlertDescription>
        </Alert>
      )}
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!busy) setEditing(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑漏洞</DialogTitle>
            <DialogDescription>修改名称、类型和严重等级，不更改原始证据。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="finding-name">名称</FieldLabel>
              <Input
                id="finding-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="finding-class">类型</FieldLabel>
              <Input
                id="finding-class"
                value={draft.vulnclass}
                onChange={(e) => setDraft({ ...draft, vulnclass: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel>严重等级</FieldLabel>
              <Select
                value={draft.severity}
                onValueChange={(value) => setDraft({ ...draft, severity: value as Severity })}
              >
                <SelectTrigger aria-label="编辑严重等级">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SEVERITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {statusMeta("severity", value).label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              disabled={busy || !draft.vulnclass.trim()}
              onClick={() =>
                void mutate(() =>
                  api.updateFinding(id, { ...draft, name: draft.name.trim(), vulnclass: draft.vulnclass.trim() }),
                )
              }
            >
              {busy && <Spinner />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
