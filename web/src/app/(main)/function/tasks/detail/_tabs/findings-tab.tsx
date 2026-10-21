"use client";

import * as React from "react";
import { useWorkspaceState } from "@/hooks/use-workspace-state";
import { SearchIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select";

import { FindingWorkspaceDetail } from "@/components/finding-detail-content";
import { FindingLayoutToggle, FindingPresentation, useFindingPresentation } from "@/components/finding-presentation";
import { FindingSelector } from "@/components/finding-selector";
import { TablePagination } from "@/components/table-pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { findingRowKey, selectFinding } from "@/lib/findings";
import { useStoredSortPreference } from "@/lib/sort-preference";
import type { FindingsPage } from "@/lib/types";

const FIELDS = ["time"] as const;
export function FindingsTab({ taskId }: { taskId: string }) {
  return <TaskFindings key={taskId} taskId={taskId} />;
}
function TaskFindings({ taskId }: { taskId: string }) {
  const presentation = useFindingPresentation("series_task_findings_layout");
  const [sort, setSort] = useStoredSortPreference("series_task_findings_sort", FIELDS, "time", "desc");
  const [query, setQuery] = useWorkspaceState(`task:${taskId}`, "finding-query", "");
  const [severity, setSeverity] = useWorkspaceState(`task:${taskId}`, "finding-severity", "all");
  const [status, setStatus] = useWorkspaceState(`task:${taskId}`, "finding-status", "all");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [data, setData] = React.useState<FindingsPage | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    void revision; // Refresh the current page after a successful mutation.
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = await api.taskFindingsPage(taskId, page, pageSize, sort.direction, {
          ...(query ? { q: query } : {}),
          ...(severity !== "all" ? { severity } : {}),
          ...(status !== "all" ? { status } : {}),
        });
        if (!active) return;
        if (page > Math.max(1, Math.ceil(value.total / pageSize))) {
          setPage(Math.max(1, Math.ceil(value.total / pageSize)));
          return;
        }
        setData(value);
        setSelectedKey((key) => {
          const selected = selectFinding(value.items, key);
          return selected ? findingRowKey(selected) : null;
        });
        setError("");
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(() => void load(), 3000);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [taskId, page, pageSize, sort.direction, revision, query, severity, status]);
  const selected = data ? selectFinding(data.items, selectedKey) : null;
  return (
    <div className="task-findings flex flex-col gap-7">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xl font-medium">所有发现</h2>
        <span className="text-sm text-muted-foreground">
          {data ? `${data.total} 项发现` : error ? "加载失败" : "加载中…"}
        </span>
      </div>
      <div className="findings-search">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="搜索发现"
            placeholder="搜索发现"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </InputGroup>
        <Select
          value={sort.direction}
          onValueChange={(v) => {
            setSort({ field: "time", direction: v as "asc" | "desc" });
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="发现排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="desc">最新发现</SelectItem>
              <SelectItem value="asc">最早发现</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="findings-filters">
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="发现状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {[
                ["all", "所有状态"],
                ["pending", "待处理"],
                ["in_progress", "处理中"],
                ["confirmed", "已确认"],
                ["resolved", "已处理"],
                ["fixed", "已修复"],
                ["false_positive", "误报"],
                ["ignored", "忽略"],
                ["duplicate", "重复"],
                ["risk_accepted", "风险接受"],
              ].map(([v, t]) => (
                <SelectItem value={v} key={v}>
                  {t}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={severity}
          onValueChange={(v) => {
            setSeverity(v);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="发现严重性">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {[
                ["all", "所有严重性"],
                ["critical", "严重"],
                ["high", "高危"],
                ["medium", "中危"],
                ["low", "低危"],
              ].map(([v, t]) => (
                <SelectItem value={v} key={v}>
                  {t}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FindingLayoutToggle value={presentation.layout} onChange={presentation.changeLayout} />
      </div>
      <FindingPresentation
        {...presentation}
        onOpenChange={presentation.setDetailOpen}
        detail={
          selected ? (
            <FindingWorkspaceDetail
              finding={selected}
              contextTask={taskId}
              onChanged={refresh}
              onDelete={async (finding, reason) => {
                if (!finding.finding_id) return;
                await api.deleteFinding(finding.finding_id, reason);
                setSelectedKey(null);
                presentation.setDetailOpen(false);
                refresh();
              }}
            />
          ) : (
            <p>请选择漏洞查看详情。</p>
          )
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          {error && (
            <Alert>
              <AlertDescription>
                加载失败：{error}
                <Button variant="outline" size="sm" onClick={refresh}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!data && !error ? (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          ) : (
            <FindingSelector
              appearance="neo"
              flat={presentation.layout === "flat"}
              items={data?.items ?? []}
              selectedKey={selected ? findingRowKey(selected) : null}
              onSelect={(item) => {
                setSelectedKey(findingRowKey(item));
                presentation.setDetailOpen(true);
              }}
            />
          )}
          {data && (
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={data?.total ?? 0}
              onPageChange={(value) => {
                setData(null);
                setPage(value);
              }}
              onPageSizeChange={(value) => {
                setData(null);
                setPageSize(value);
                setPage(1);
              }}
            />
          )}
        </div>
      </FindingPresentation>
    </div>
  );
}
