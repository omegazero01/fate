"use client";

import * as React from "react";
import Link from "next/link";
import { GraphNodeReader } from "@/components/graph-node-reader";
import type { GraphPage } from "@/lib/graph-browse";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  BugIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CompassIcon,
  FlagIcon,
  FlaskConicalIcon,
  LayersIcon,
  LightbulbIcon,
  type LucideIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  TargetIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { startPolling } from "@/lib/polling";
import { api } from "@/lib/api";
import { type Tone, toneClasses, toneDot } from "@/lib/status";
import type { ExploreKind, TaskNode } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE_SIZES = [20, 50, 100];
const POLL_MS = 8000;

type KindMeta = { label: string; icon: LucideIcon; dot: string; chip: string };

// 播报板自己的展示元数据。刻意不复用探索链路图那份:图是拓扑视角(节点卡片、连线配色),
// 播报是流水视角(时间轴行),两边的信息密度和配色需求不同,各自演进更省事。
const KIND_META: Record<string, KindMeta> = {
  begin: {
    label: "起点",
    icon: FlagIcon,
    dot: "bg-slate-500",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
  },
  task: {
    label: "根任务",
    icon: FlagIcon,
    dot: "bg-slate-500",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
  },
  goal: {
    label: "目标",
    icon: TargetIcon,
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  intent: {
    label: "意图",
    icon: CompassIcon,
    dot: "bg-blue-500",
    chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  fact: {
    label: "事实",
    icon: FlaskConicalIcon,
    dot: "bg-amber-500",
    chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  finding: {
    label: "漏洞",
    icon: BugIcon,
    dot: "bg-rose-500",
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
  hint: {
    label: "提示",
    icon: LightbulbIcon,
    dot: "bg-violet-500",
    chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  digest: {
    label: "压缩",
    icon: LayersIcon,
    dot: "bg-teal-500",
    chip: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  },
};

// 可筛选的类型。起点(fact/state=origin)不单独列,它跟着「事实」一起过滤。
const FILTER_KINDS: ExploreKind[] = ["goal", "intent", "fact", "finding", "hint", "digest"];

const REL_LABEL: Record<string, string> = {
  spawns: "派生",
  derived_from: "意图链",
  yields: "产出",
  proves: "证明",
  covers: "压缩",
};

// goal / intent 的状态语义由全局 status 表提供(StatusBadge);其余类型的状态只在
// 图和播报里出现,这里补一份。
const STATE_META: Record<string, Record<string, { label: string; tone: Tone }>> = {
  fact: {
    origin: { label: "起点", tone: "slate" },
    confirmed: { label: "已确认", tone: "green" },
    dismissed: { label: "已否定", tone: "slate" },
  },
  finding: {
    confirmed: { label: "已确认", tone: "red" },
    dismissed: { label: "已排除", tone: "slate" },
  },
  hint: {
    active: { label: "待采纳", tone: "violet" },
    consumed: { label: "已采纳", tone: "slate" },
  },
  digest: {
    active: { label: "生效中", tone: "green" },
    superseded: { label: "已替代", tone: "slate" },
  },
};

// 任务根是 state=origin 的 fact,播报里读作「起点」。
function viewKind(n: TaskNode): string {
  return n.type === "fact" && n.state === "origin" ? "begin" : n.type;
}

const SUMMARY_FIELDS: Record<string, string[]> = {
  begin: ["summary", "description"],
  task: ["summary", "description"],
  goal: ["text"],
  intent: ["summary"],
  fact: ["summary"],
  finding: ["name", "summary"],
  hint: ["text", "summary"],
  digest: ["body", "summary"],
};

function summaryOf(n: TaskNode): string {
  const raw = n.payload ?? "";
  if (!raw.trim()) return "";
  for (const field of [...(SUMMARY_FIELDS[viewKind(n)] ?? []), "summary"]) {
    try {
      const obj: unknown = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        const v = (obj as Record<string, unknown>)[field];
        if (typeof v === "string" && v.trim()) return v;
      }
    } catch {
      return raw; // 非 JSON payload:原样播报
    }
  }
  return raw;
}

function relTime(ts: number, now: number): string {
  if (!now || !ts) return "";
  const sec = Math.max(0, (now - ts) / 1000);
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const dayFmt = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const clockFmt = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function NodeStateBadge({ node }: { node: TaskNode }) {
  if (node.type === "goal") return <StatusBadge domain="goal" value={node.state} dot />;
  if (node.type === "intent") return <StatusBadge domain="intent" value={node.state} dot />;
  const meta = STATE_META[node.type]?.[node.state];
  if (!meta) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        toneClasses[meta.tone],
      )}
    >
      <span className={cn("size-1.5 rounded-full", toneDot[meta.tone])} />
      {meta.label}
    </span>
  );
}

function KindChip({ kind }: { kind: string }) {
  const meta = KIND_META[kind] ?? KIND_META.fact;
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", meta.chip)}>{meta.label}</span>
  );
}

// 一条播报涉及的上下游:上游 = 指向本节点的边,下游 = 本节点指出去的边。
function BroadcastRelations({taskID,nodeID}:{taskID:string;nodeID:string}) {
 const [page,setPage]=React.useState<GraphPage>(),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
 const controller=React.useRef<AbortController|null>(null);
 const load=React.useCallback(async(before?:string,revision?:string)=>{
  controller.current?.abort();const c=new AbortController();controller.current=c;setBusy(true);setError('');
  try{const r=await api.graphPage(taskID,{mode:'relations',focus:nodeID,before,revision},undefined,c.signal);if(!c.signal.aborted&&!r.unchanged)setPage(r);}
  catch(e){if(!c.signal.aborted){setPage(undefined);setError(e instanceof Error?e.message:'关联读取失败');}}
  finally{if(!c.signal.aborted)setBusy(false);}
 },[taskID,nodeID]);
 React.useEffect(()=>{void load();return()=>controller.current?.abort();},[load]);
 const refs=Object.fromEntries((page?.nodes??[]).map(n=>[n.id,n]));
 return <section className="flex flex-col gap-2">
  <p className="text-xs text-muted-foreground">关联关系：本页 {page?.edges.length??0} / 共 {page?.total??'…'}</p>
  {page?.edges.map(e=>{const other=e.src===nodeID?e.dst:e.src;return <Link key={`${e.src}:${e.rel}:${e.dst}`} className="text-xs underline" href={`/function/tasks/detail?${new URLSearchParams({id:taskID,tab:'graph',node:other})}`}>{e.src===nodeID?'下游':'上游'} · {REL_LABEL[e.rel]??e.rel} · #{other} {refs[other]?summaryOf(refs[other]):''}</Link>;})}
  <div className="flex gap-2">{(page?.before||error)&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load()}>重新读取第一页关联</Button>}{page?.next_before&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(page.next_before!,page.revision)}>下一页关联</Button>}</div>
  {busy&&<p role="status" className="text-xs text-muted-foreground">读取关联中…</p>}{error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
 </section>;
}

function BroadcastRow({ node, taskId, now, fresh }: { node: TaskNode; taskId: string; now: number; fresh: boolean }) {
  const [open, setOpen] = React.useState(false);
  const kind = viewKind(node);
  const meta = KIND_META[kind] ?? KIND_META.fact;
  const Icon = meta.icon;
  const ts = Date.parse(node.ts);
  const summary = summaryOf(node);


  return (
    <div className={cn("relative grid grid-cols-[4.5rem_1.75rem_1fr] gap-x-2", fresh && "bg-primary/5")}>
      {/* 时间列 */}
      <div className="py-3 text-right text-xs text-muted-foreground tabular-nums">
        <div>{Number.isNaN(ts) ? "--:--:--" : clockFmt.format(ts)}</div>
        <div className="text-[11px] opacity-70">{relTime(ts, now)}</div>
      </div>

      {/* 时间轴:竖线 + 类型圆点 */}
      <div className="relative flex justify-center">
        <span className="absolute inset-y-0 w-px bg-border" />
        <span
          className={cn(
            "relative mt-3.5 flex size-6 items-center justify-center rounded-full text-white ring-4 ring-background",
            meta.dot,
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </div>

      {/* 内容列 */}
      <div className="min-w-0 border-b py-3 pr-1 last:border-b-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-start gap-2 text-left"
        >
          <ChevronRightIcon
            className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <KindChip kind={kind} />
              <NodeStateBadge node={node} />
              {node.priority > 0 && (kind === "goal" || kind === "intent") && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">P{node.priority}</span>
              )}
              {fresh && (
                <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  新
                </span>
              )}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{node.origin || "system"}</span>
            </div>
            <p className={cn("mt-1 text-sm", !open && "line-clamp-2")}>{summary || `节点 #${node.id}`}</p>
          </div>
        </button>

        {open && (
          <div className="mt-2 ml-5 flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                节点 <code className="font-mono">#{node.id}</code>
              </span>
              <span>类型 {meta.label}</span>
              <span>来源 {node.origin || "system"}</span>
              <span>{Number.isNaN(ts) ? node.ts : new Date(ts).toLocaleString("zh-CN")}</span>
            </div>
            <GraphNodeReader taskID={taskId} nodeID={node.id} kind={node.type} />
            <BroadcastRelations taskID={taskId} nodeID={node.id} />
          </div>
        )}
      </div>
    </div>
  );
}

export function BroadcastTab({ taskId }: { taskId: string }) {
  const [kinds, setKinds] = React.useState<ExploreKind[]>([]);
  const [queryInput, setQueryInput] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [order, setOrder] = React.useState<"asc" | "desc">("desc");
  const [page, setPage] = React.useState(1);
  const [size, setSize] = React.useState(20);
  const [live, setLive] = React.useState(true);

  const [items, setItems] = React.useState<TaskNode[]>([]);
  const revisionRef=React.useRef<string|undefined>(undefined);
  const [loadError, setLoadError] = React.useState("");
  const polling = React.useRef<ReturnType<typeof startPolling> | null>(null);
  const [total, setTotal] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);
  const [freshIDs, setFreshIDs] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState(0);
  const [now, setNow] = React.useState(0);

  const seenRef = React.useRef<Set<string>>(new Set());
  const baselineRef = React.useRef<number | null>(null);
  const streamRef = React.useRef("");
  // 只有「最新在前的第 1 页」才是真正的直播位；其余位置轮询只更新未读计数，
  // 不动列表，免得翻页/展开时内容在脚下变。
  const atLive = page === 1 && order === "desc";

  React.useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // 输入防抖:打字停 300ms 才真正查询,并回到第一页。
  React.useEffect(() => {
    if(queryInput===query)return;
    const t = setTimeout(() => {
      setQuery(queryInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [queryInput,query]);

  React.useEffect(() => {
    let alive = true;
    let rendered = false; // 本次查询是否已经把内容渲染出来过
    // 换任务/筛选/排序 = 换了一条播报流:清掉「新」标记和未读基线。翻页不算换流,
    // 否则回到最新时就没有未读计数可算了。
    const stream = `${taskId}|${kinds.join(",")}|${query}|${order}|${size}`;
    if (streamRef.current !== stream) {
      streamRef.current = stream;
      revisionRef.current=undefined;
      seenRef.current = new Set();
      baselineRef.current = null;
      setPending(0);
    }
    const load = (signal: AbortSignal) =>
      api
        .explorationNodes(taskId, { page, size, kinds, q: query, order, countOnly: !atLive && rendered,revision:page>1&&!rendered?revisionRef.current:undefined }, signal)
        .then((r) => {
          if (!alive || signal.aborted) return;
          if(!atLive&&rendered&&revisionRef.current!==r.revision){
            setItems([]);setLoadError('图谱已变化，请重新读取当前页');rendered=false;revisionRef.current=undefined;setTotal(r.total);return;
          }
          setLoadError("");
          // 直播位每轮都刷新;其它位置只渲染第一次,之后轮询仅更新未读计数。
          if (atLive || !rendered) {
            rendered = true;
            revisionRef.current=r.revision;
            setItems(r.items);
          }
          setTotal(r.total);
          if (atLive) {
            const seen = seenRef.current;
            setFreshIDs(seen.size === 0 ? new Set() : new Set(r.items.filter((n) => !seen.has(n.id)).map((n) => n.id)));
            seenRef.current = new Set(r.items.map((n) => n.id));
            baselineRef.current = r.total;
            setPending(0);
          } else {
            const base = baselineRef.current;
            setPending(base === null ? 0 : Math.max(0, r.total - base));
          }
          setLoaded(true);
        })
        .catch((e: Error) => {
          if (alive && (!signal.aborted || signal.reason?.message?.includes("超时"))) {
            setLoadError(e.message);
            setItems([]);rendered=false;revisionRef.current=undefined;
            setLoaded(true);
          }
        });
    const next = startPolling(load, live ? POLL_MS : null);
    polling.current = next;
    return () => {
      alive = false;
      next.stop();
    };
  }, [taskId, page, size, kinds, query, order, live, atLive]);

  const toggleKind = (kind: ExploreKind) => {
    setKinds((cur) => (cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]));
    setPage(1);
  };

  const backToLive = () => {
    setPage(1);
    setOrder("desc");
    setPending(0);
  };

  const pageCount = Math.max(1, Math.ceil(total / size));
  const start = total === 0 ? 0 : (page - 1) * size + 1;
  const end = (page - 1) * size + items.length;

  // 换任务或筛选后条数变少时,把越界的页码收回来。
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  // 按天分组:播报流按日期断行,长任务翻页时还能认出「这是哪天的事」。
  const groups: Array<{ day: string; rows: TaskNode[] }> = [];
  for (const node of items) {
    const ts = Date.parse(node.ts);
    const day = Number.isNaN(ts) ? "未知日期" : dayFmt.format(ts);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(node);
    else groups.push({ day, rows: [node] });
  }

  return (
    <Card className="overflow-hidden py-0">
      {loadError && (
        <p role="alert">
          {loadError}
          <Button variant="ghost" onClick={() => polling.current?.refresh()}>
            重试
          </Button>
        </p>
      )}
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="relative w-full sm:w-64">
          <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索内容 / 来源 / 节点 id"
            className="h-8 pl-8"
            aria-label="搜索播报"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {FILTER_KINDS.map((kind) => {
            const meta = KIND_META[kind];
            const active = kinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={active}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
                  active ? meta.chip : "border-transparent text-muted-foreground hover:bg-accent",
                )}
              >
                {meta.label}
              </button>
            );
          })}
          {kinds.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setKinds([]);
                setPage(1);
              }}
            >
              清除
            </Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              setOrder((o) => (o === "desc" ? "asc" : "desc"));
              setPage(1);
            }}
            aria-label={order === "desc" ? "当前最新在前，点击改为最早在前" : "当前最早在前，点击改为最新在前"}
          >
            {order === "desc" ? <ArrowDownIcon /> : <ArrowUpIcon />}
            {order === "desc" ? "最新在前" : "最早在前"}
          </Button>
          <Button
            variant={live ? "outline" : "secondary"}
            size="sm"
            className="h-8"
            onClick={() => setLive((v) => !v)}
            aria-label={live ? "暂停自动刷新" : "恢复自动刷新"}
          >
            {live ? <PauseIcon /> : <PlayIcon />}
            {live ? "自动刷新" : "已暂停"}
          </Button>
        </div>
      </div>

      {/* 离开直播位时的未读提示 */}
      {!atLive && pending > 0 && (
        <button
          type="button"
          onClick={backToLive}
          className="flex w-full items-center justify-center gap-1.5 border-b bg-primary/10 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
        >
          <ArrowUpToLineIcon className="size-3.5" />
          {pending > 99 ? "99+" : pending} 条新播报 · 回到最新
        </button>
      )}

      <CardContent className="px-4 py-0">
        {!loaded ? (
          <div className="flex flex-col gap-3 py-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {loadError ? "当前内容未加载，请重试。" : query || kinds.length > 0 ? "没有符合条件的播报。" : "这个任务还没有产生探索节点。"}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.day}>
              <div className="py-2 pl-[6.25rem] text-xs font-medium text-muted-foreground">{group.day}</div>
              {group.rows.map((node) => (
                <BroadcastRow key={node.id} node={node} taskId={taskId} now={now} fresh={freshIDs.has(node.id)} />
              ))}
            </div>
          ))
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <Select
          value={String(size)}
          onValueChange={(v) => {
            setSize(Number(v));
            setPage(1);
          }}
        >
          <SelectTrigger size="sm" className="h-7 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} / 页
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="tabular-nums">
          {start}–{end} / {total}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="上一页"
          >
            <ChevronLeftIcon />
          </Button>
          <span className="tabular-nums">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            aria-label="下一页"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
