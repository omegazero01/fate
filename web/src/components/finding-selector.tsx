"use client";

import { ChevronRightIcon } from "lucide-react";
import { statusMeta } from "@/lib/status";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { findingRowKey, fmtTime } from "@/lib/findings";
import type { Finding } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FindingSelector({
  flat = false,
  appearance = "default",
  items,
  selectedKey,
  onSelect,
  selectedIds,
  onToggleSelected,
  onToggleSelectedPage,
  selectAllLabel = "选择当前页全部",
}: {
  flat?: boolean;
  appearance?: "default" | "neo";
  items: Finding[];
  selectedKey: string | null;
  onSelect: (finding: Finding) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string, checked: boolean) => void;
  onToggleSelectedPage?: (ids: string[], checked: boolean) => void;
  selectAllLabel?: string;
}) {
  const selectable = items.filter(
    (item): item is Finding & { finding_id: string } => !!item.finding_id && !item.inherited,
  );
  const checked = selectable.filter((item) => selectedIds?.has(item.finding_id)).length;
  if(appearance==="neo") return <section className="finding-list" aria-label="漏洞选择列表">
    {items.map(item=><Button key={findingRowKey(item)} variant="outline" className="finding-list-row" aria-pressed={selectedKey===findingRowKey(item)} onClick={()=>onSelect(item)}>
      <span className="finding-severity-dot" data-severity={item.severity} aria-hidden="true"/>
      <span className="finding-list-copy"><span className="finding-list-title">{item.name||item.vulnclass||"未分类"}</span><span className="finding-list-meta"><span>{statusMeta("severity",item.severity).label}</span><span>·</span><span>{statusMeta("finding",item.status).label}</span><span>·</span><span>{fmtTime(item.ts)}</span>{item.assets?.length?<><span>·</span><span>{item.assets.map(a=>a.label).join("、")}</span></>:null}{item.inherited&&<Badge variant="outline">来源 #{item.source_task_id||item.task_id} · 只读</Badge>}</span></span><ChevronRightIcon data-icon="inline-end"/>
    </Button>)}
    {!items.length&&<p className="py-16 text-center text-muted-foreground">没有匹配的发现。</p>}
  </section>;
  return (
    <div className="flex min-w-0 flex-col gap-2 p-3">
      {onToggleSelectedPage && (
        <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs">
          <Checkbox
            aria-label={selectAllLabel}
            disabled={!selectable.length}
            checked={checked > 0 && checked < selectable.length ? "indeterminate" : checked > 0}
            onCheckedChange={(value) =>
              onToggleSelectedPage(
                selectable.map((item) => item.finding_id),
                value === true,
              )
            }
          />
          {selectAllLabel}
        </div>
      )}
      <section
        className={cn("flex flex-col gap-2", !flat && "max-h-[36rem] overflow-y-auto")}
        aria-label="漏洞选择列表"
      >
        {items.map((item) => (
          <div key={findingRowKey(item)} className="flex min-w-0 items-start gap-2">
            {onToggleSelected && (
              <Checkbox
                className="mt-4 shrink-0"
                aria-label={`导出 ${item.name || item.vulnclass}`}
                disabled={!item.finding_id || item.inherited}
                checked={!!item.finding_id && !!selectedIds?.has(item.finding_id)}
                onCheckedChange={(value) => item.finding_id && onToggleSelected(item.finding_id, value === true)}
              />
            )}
            <Button
              variant={selectedKey === findingRowKey(item) ? "secondary" : "ghost"}
              className={cn(
                "h-auto min-w-0 flex-1 flex-col items-start gap-2 whitespace-normal p-3 text-left",
                flat && "sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
              )}
              aria-pressed={selectedKey === findingRowKey(item)}
              onClick={() => onSelect(item)}
            >
              <span className="line-clamp-2 break-words font-medium">{item.name || item.vulnclass || "未分类"}</span>
              <span className="flex flex-wrap gap-2">
                <StatusBadge domain="severity" value={item.severity} dot />
                <StatusBadge domain="finding" value={item.status} dot />
              </span>
              {flat && (
                <span className="min-w-0 break-words text-xs text-muted-foreground">
                  资产：{item.assets?.map((asset) => asset.label).join("、") || "未关联资产"}
                </span>
              )}
              {flat && <span className="text-xs text-muted-foreground">发现时间：{fmtTime(item.ts)}</span>}
              {item.inherited ? (
                <Badge variant="outline">来源 #{item.source_task_id || item.task_id} · 只读</Badge>
              ) : (
                item.task_id && (
                  <span className="text-muted-foreground text-xs">
                    任务 {item.task_description || `#${item.task_id}`}
                  </span>
                )
              )}
            </Button>
          </div>
        ))}
        {!items.length && <p className="py-10 text-center text-muted-foreground text-sm">没有匹配的发现。</p>}
      </section>
    </div>
  );
}
