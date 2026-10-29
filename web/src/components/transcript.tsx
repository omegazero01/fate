"use client";

import * as React from "react";
import {
  InfoIcon,
  CopyIcon,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  CrosshairIcon,
  Flag,
  MessageSquare,
  PaperclipIcon,
  ShieldAlertIcon,
  Terminal,
  UserIcon,
  Wrench,
  XIcon,
} from "lucide-react";
import {plannerRoundView,isPlannerBoundary} from '@/lib/planner-round';
import {PlannerRoundMarker} from '@/components/planner-round-marker';
import {SteeringNotice} from '@/components/steering-notice';
import {isSteering} from '@/lib/steering';
import {useTurnSummaries} from '@/hooks/use-turn-summaries';
import {WorkerWritebacks,WorkerConclusion} from '@/components/worker-writebacks';
import {turnParts,durationLabel,type TurnSummary} from '@/lib/turn-summary';
import {Popover,PopoverTrigger,PopoverContent,PopoverHeader,PopoverTitle,PopoverDescription} from '@/components/ui/popover';
import {Separator} from '@/components/ui/separator';
import {Alert,AlertDescription} from '@/components/ui/alert';
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { conversationTurns, isLifecycle, turnID } from "@/lib/conversation-turns";
import { Message, MessageAvatar, MessageContent, MessageFooter } from "@/components/ui/message";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MessageScrollerItem, useMessageScroller } from "@/components/ui/message-scroller";
import type { Activity } from "@/lib/types";

// ---- per-agent lane color (planner + work#1/#2/#3 …) ---------------------------
const workerColors = ["bg-sky-600", "bg-violet-600", "bg-teal-600", "bg-pink-600", "bg-orange-600"];
function workerColor(name: string): string {
  if (name === "planner") return "bg-amber-600"; // the intent generator, distinct
  if (name === "mainagent") return "bg-primary";
  const m = /#(\d+)/.exec(name);
  const i = m ? (parseInt(m[1], 10) - 1) % workerColors.length : 0;
  return workerColors[Math.max(0, i)];
}

const chip = (worker: string) =>
  "mt-0.5 shrink-0 rounded px-1 text-[9px] font-medium text-white " + workerColor(worker);

// useInView latches true when the ref'd element first comes within `rootMargin` of
// the enclosing scroll viewport. Blocks that always show their full body (user
// bubbles, answers) use it to defer fetching that body until they're about to be
// seen — so opening a long thread doesn't fire a detail request for every off-
// screen step. Observes the ScrollArea viewport (falls back to eager load when
// IntersectionObserver is unavailable, e.g. SSR).
function useInView(rootMargin = "400px"): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    if (inView) return; // latch: once seen, stop observing
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const root = el.closest('[data-slot="scroll-area-viewport"], [data-slot="message-scroller-viewport"]') as HTMLElement | null;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { root, rootMargin },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

// A tool group pairs a tool_use with its matching tool_result (by tool_use_id);
// a run of consecutive conversational steps (text/thinking/result) from the same
// agent is one "message".
type Group =
  | { type: "steering"; key: number; step: Activity }
  | { type: "user"; key: number; step: Activity; intent?: boolean }
  | { type: "answer"; key: number; step: Activity }
  | { type: "round"; key: number; label: string }
  | { type: "tool"; key: number; worker: string; use?: Activity; result?: Activity }
  | { type: "msg"; key: number; worker: string; steps: Activity[] }
;

function groupSteps(steps: Activity[], chat: boolean): Group[] {
  const out: Group[] = [];
  const byToolId = new Map<string, Extract<Group, { type: "tool" }>>();
  for (const s of steps) {
    const callKey = `${s.worker}:${s.intent_id ?? ""}:${s.main_seg ?? 0}:${s.tool_use_id}`;
    if (s.kind === "usage" || isLifecycle(s)) continue; // live token-usage marker — not a rendered step
    if (isSteering(s)) {out.push({type:"steering",key:s.seq,step:s});continue;}
    if (s.kind === "round") {
      out.push({ type: "round", key: s.seq, label: s.summary || "新一轮" }); // planner round boundary
      continue;
    }
    if (s.kind === "user" || s.kind === "intent") {
      // human turn OR the LLM-generated intent leading a worker session — both are
      // right-aligned bubbles; `intent` swaps the avatar to a non-human icon.
      out.push({ type: "user", key: s.seq, step: s, intent: s.kind === "intent" });
      continue;
    }
    // In a chat (main agent) the assistant's text/result IS the answer — render it
    // full (markdown), never collapsed. thinking still folds into a compact block.
    if (s.kind === "result" || (s.kind === "text" || s.kind === "assistant")) {
      out.push({ type: "answer", key: s.seq, step: s });
      continue;
    }
    if (s.kind === "tool_use") {
      const g: Extract<Group, { type: "tool" }> = { type: "tool", key: s.seq, worker: s.worker, use: s };
      if (s.tool_use_id) byToolId.set(callKey, g);
      out.push(g);
      continue;
    }
    if (s.kind === "tool_result") {
      // bind to its tool_use by id (NOT adjacency — tools can run in parallel)
      const g = s.tool_use_id ? byToolId.get(callKey) : undefined;
      if (g && !g.result) g.result = s;
      else out.push({ type: "tool", key: s.seq, worker: s.worker, result: s }); // orphan result
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.type === "msg" && last.worker === s.worker) last.steps.push(s);
    else out.push({ type: "msg", key: s.seq, worker: s.worker, steps: [s] });
  }
  return out;
}

const kindLabel = (k: string) => (k === "thinking" ? "推理" : k === "result" ? "总结" : "说明");

function ActivityTime({ ts }: { ts: string }) {
  const date = new Date(ts);
  if (!ts || Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString("zh-CN")}
      className="text-[10px] text-muted-foreground tabular-nums"
      suppressHydrationWarning
    >
      {date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}
    </time>
  );
}

// toolInputText renders a tool_use input for display. For Bash it pulls the shell
// command out of the raw input JSON ({"command":…,"description":…}) so the UI shows
// the command itself instead of JSON; other tools fall back to the raw text.
function toolInputText(tool: string, raw: string): string {
  if (tool !== "Bash") return raw;
  // full input (expanded detail): parse and pull the command out.
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.command === "string") return o.command;
  } catch {
    // collapsed-row summaries are truncated to ~200 chars by the backend, so the
    // JSON tail is cut off and JSON.parse fails — fall through and extract the
    // "command" field by hand, tolerating the missing closing quote.
  }
  const m = raw.match(/"command"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (m) {
    try {
      // re-wrap the captured body and parse to unescape \n, \", \\, etc.
      return JSON.parse('"' + m[1] + '"');
    } catch {
      // truncated mid-escape — unescape the common sequences best-effort.
      return m[1].replace(/\\(["\\/nrt])/g, (_s, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
    }
  }
  return raw;
}

function ToolBlock({
  group,
  getDetail,
  showWorker,
  focused,
  onLocated,
  focusLabel = "来源调用",
}: {
  group: Extract<Group, { type: "tool" }>;
  getDetail: (seq: number) => Promise<string>;
  showWorker?: boolean;
  focused?: boolean;
  onLocated?: (el: HTMLElement, explicit?: boolean) => void;
  focusLabel?: string;
}) {
  const [open, setOpen] = React.useState(!!focused);
  const root = React.useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const [detail, setDetail] = React.useState<string | null>(null);
  // what we last loaded, keyed by the underlying step seqs. When the tool result
  // arrives after we expanded mid-run (command only), this key changes and the
  // effect below re-fetches — so the output shows up instead of being cached out.
  const loadedKey = React.useRef<string | null>(null);
  const [parts, setParts] = React.useState<{ seq: number; text: string }[]>([]);
  const { use, result } = group;
  const toolName = use?.tool || result?.tool || "工具";
  const ToolIcon = toolName === "Bash" ? Terminal : Wrench;
  const running = !result;
  const ok = !!result && !result.is_error;
  const statusTone = running
    ? "text-muted-foreground"
    : ok
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400";
  const rawCmd =
    use && use.summary.startsWith(toolName) ? use.summary.slice(toolName.length).trimStart() : (use?.summary ?? "");
  const cmd = toolInputText(toolName, rawCmd);
  // status only — the full result lives behind the expand (【输出】), not previewed inline
  const statusText = running ? "执行中…" : ok ? "✓" : "✕ 失败";

  // key over the seqs we'd load; changes when the result (or command) arrives.
  const detailKey = `${use?.seq ?? ""}:${result?.seq ?? ""}:${retry}`;
  React.useEffect(() => {
    if (!open || loadedKey.current === detailKey) return;
    let live = true;
    const segs: { label: string; seq: number }[] = [];
    if (use) segs.push({ label: "命令", seq: use.seq });
    if (result) segs.push({ label: "输出" + (result.is_error ? " ✕" : " ✓"), seq: result.seq });
    setLoadError(false);
    Promise.all(segs.map((x) => getDetail(x.seq).then((d) => d || "（空）")))
      .then((parts) => {
        if (!live) return;
        setDetail(
          segs
            .map(
              (x, i) =>
                `【${x.label}】\n${x.label === "命令" && focusLabel !== "搜索结果" ? toolInputText(toolName, parts[i]) : parts[i]}`,
            )
            .join("\n\n"),
        );
        setParts(
          segs.map((x, i) => ({
            seq: x.seq,
            text: `【${x.label}】\n${x.label === "命令" && focusLabel !== "搜索结果" ? toolInputText(toolName, parts[i]) : parts[i]}`,
          })),
        );
        loadedKey.current = detailKey;
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [open, detailKey, use, result, getDetail, toolName, focusLabel]);

  React.useEffect(() => {
    // A failed detail request is also a settled view: keep its retry control
    // visible at the source call instead of leaving it buried in old history.
    if (!focused || !open || (!detail && !loadError) || !root.current) return;
    if (onLocated) {
      const frame = requestAnimationFrame(() => {
        if (root.current) onLocated(root.current);
      });
      return () => cancelAnimationFrame(frame);
    }
    const el = root.current;
    const viewport = el.closest('[data-slot="scroll-area-viewport"], [data-slot="message-scroller-viewport"]');
    if (!viewport) return;
    const center = () => {
      const rect = el.getBoundingClientRect(),
        bounds = viewport.getBoundingClientRect();
      viewport.scrollTop += rect.top + rect.height / 2 - bounds.top - bounds.height / 2;
    };
    const observer = new ResizeObserver(center);
    observer.observe(el.parentElement ?? el);
    observer.observe(viewport);
    const stop = () => observer.disconnect();
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
      viewport.addEventListener(event, stop, { passive: true, once: true });
    const frame = requestAnimationFrame(center),
      timer = setTimeout(stop, 2000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      stop();
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) viewport.removeEventListener(event, stop);
    };
  }, [focused, open, detail, loadError, onLocated]);

  function toggle() {
    setOpen((o) => !o);
  }

  return (
    <div
      ref={root}
      data-source-call={focused || undefined}
      data-activity-id={use?.seq ?? result?.seq}
      className={cn("text-xs", focused && "rounded-md border border-primary bg-accent/30 p-2")}
    >
      {focused && <Badge variant="outline">{focusLabel}</Badge>}
      <button type="button" onClick={toggle} className="flex w-full items-start gap-2 py-1 text-left hover:bg-muted/40">
        <span className="mt-0.5 text-muted-foreground">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <ToolIcon className={"mt-0.5 size-3.5 shrink-0 " + (running ? "text-sky-600 dark:text-sky-400" : statusTone)} />
        {showWorker && <span className={chip(group.worker)}>{group.worker}</span>}
        <span className="shrink-0 font-medium text-sky-600 dark:text-sky-400">{toolName}</span>
        {cmd && <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{cmd}</span>}
        <span className={"ml-auto shrink-0 font-medium " + statusTone}>{statusText}</span>
      </button>
      {open && (
        <pre
          data-search-body
          className="ml-7 mb-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed"
        >
          {loadError ? (
            <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
              加载失败，重试
            </Button>
          ) : detail ? (
            parts.map((part) => (
              <span key={part.seq} data-search-activity={part.seq}>
                {part.text}
                {"\n\n"}
              </span>
            ))
          ) : (
            "加载中…"
          )}
        </pre>
      )}
    </div>
  );
}

// MessageBlock renders a coalesced agent message (merged streaming text/thinking/
// result fragments into one block) so the conversation reads as messages, not rows.
function MessageBlock({
  group,
  getDetail,
  showWorker,
}: {
  group: Extract<Group, { type: "msg" }>;
  getDetail: (seq: number) => Promise<string>;
  showWorker?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<string | null>(null);
  // like ToolBlock: keyed by the group's step seqs so streamed steps arriving
  // after an early expand re-fetch instead of being cached out.
  const loadedKey = React.useRef<string | null>(null);
  const speak = group.steps.filter((s) => s.kind !== "thinking");
  const hasThinking = group.steps.some((s) => s.kind === "thinking");
  const isError = group.steps.some((s) => s.is_error);
  const body = (speak.length ? speak : group.steps).map((s) => s.summary).join("  ") || "…";
  const Icon = isError ? Flag : MessageSquare;
  const tone = isError ? "text-red-600 dark:text-red-400" : "text-foreground";

  const detailKey = group.steps.map((s) => `${s.seq}:${s.detail?.length??0}`).join(",");
  React.useEffect(() => {
    if (!open || loadedKey.current === detailKey) return;
    let live = true;
    void Promise.all(
      group.steps.map((s) =>
        (s.detail!==undefined?Promise.resolve(s.detail):getDetail(s.seq))
          .then((d) => d || s.summary)
          .catch(() => s.summary),
      ),
    ).then((parts) => {
      if (!live) return;
      setDetail(group.steps.map((s, i) => `【${kindLabel(s.kind)}】\n${parts[i]}`).join("\n\n"));
      loadedKey.current = detailKey;
    });
    return () => {
      live = false;
    };
  }, [open, detailKey, group.steps, getDetail]);

  function toggle() {
    setOpen((o) => !o);
  }

  return (
    <div className="text-xs">
      <button type="button" onClick={toggle} className="flex w-full items-start gap-2 py-1 text-left hover:bg-muted/40">
        <span className="mt-0.5 text-muted-foreground">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <Icon className={"mt-0.5 size-3.5 shrink-0 " + tone} />
        {showWorker && <span className={chip(group.worker)}>{group.worker}</span>}
        <span className={"min-w-0 flex-1 truncate " + tone}>
          {hasThinking ? (group.steps.some(s=>s.streaming)?"正在分析…":"思考过程") : body}
        </span>
      </button>
      {open && (
        <pre className="ml-7 mb-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
          {detail ?? "加载中…"}
        </pre>
      )}
    </div>
  );
}

// UserRow renders a right-aligned chat bubble: either a human turn (the message you
// sent the main agent) or, in a worker session, the LLM-generated intent that leads
// it (intent=true) — same bubble, but a target icon instead of the human avatar.
// summary is a truncated first line, so the full message is pulled from the detail
// and shown in full (bubble is whitespace-pre-wrap, so long/multi-line text wraps).
// fmtBytes renders a human file size for attachment chips.
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

type MsgAttachment = { name: string; path: string; size: number };

// parseUserBody splits a user turn's body into text + attachments. The backend stores
// Detail as JSON {text, attachments} when files were uploaded, else plain text — so we
// parse defensively and fall back to treating the whole body as text.
function parseUserBody(body: string): { text: string; attachments: MsgAttachment[] } {
  if (body.startsWith("{")) {
    try {
      const p = JSON.parse(body);
      if (p && Array.isArray(p.attachments)) {
        return { text: typeof p.text === "string" ? p.text : "", attachments: p.attachments };
      }
    } catch {
      /* plain text that merely starts with "{" */
    }
  }
  return { text: body, attachments: [] };
}

function UserRow({
  step,
  intent,
  getDetail,
}: {
  step: Activity;
  intent?: boolean;
  getDetail: (seq: number) => Promise<string>;
}) {
  const Icon = intent ? CrosshairIcon : UserIcon;
  const [ref, inView] = useInView();
  // Optimistic echoes carry their detail inline; persisted rows lazy-load it on scroll.
  const inline = step.detail ?? null;
  const [full, setFull] = React.useState<string | null>(inline);
  React.useEffect(() => {
    if (inline !== null || step.seq < 0) return; // optimistic/attachment-only messages never fetch a negative id
    if (!inView) return; // fetch the full message only when the bubble nears view
    let live = true;
    getDetail(step.seq)
      .then((d) => {
        if (live) setFull(d || step.summary);
      })
      .catch(() => {
        if (live) setFull(step.summary);
      });
    return () => {
      live = false;
    };
  }, [inView, step.seq, getDetail, step.summary, inline]);
  const parsed = parseUserBody(full ?? step.summary);
  const text=parsed.text,attachments=step.metadata?.attachments??parsed.attachments;
  return (
    <Message ref={ref} data-activity-id={step.seq} align="end" className="mt-3 mb-2">
      <MessageAvatar><Icon className="size-3.5 text-primary" /></MessageAvatar>
      <MessageContent className="w-fit max-w-[85%] items-end gap-1.5">
        {attachments.length > 0 && (
          <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-1.5">
            {attachments.map((a) => (
              <Attachment
                key={a.path}
                state="done" size="xs"
                title={a.path}
              >
                <AttachmentMedia><PaperclipIcon /></AttachmentMedia>
                <AttachmentContent><AttachmentTitle>{a.name}</AttachmentTitle><AttachmentDescription>{fmtBytes(a.size)}</AttachmentDescription></AttachmentContent>
              </Attachment>
            ))}
          </div>
        )}
        {text && (
          <Bubble variant="outline" align="end" className="conversation-user-bubble max-w-full"><BubbleContent className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</BubbleContent></Bubble>
        )}
        <MessageFooter><ActivityTime ts={step.ts} /></MessageFooter>
      </MessageContent>
    </Message>
  );
}

// AnswerBlock renders the agent's FINAL answer (kind="result") in full — never
// collapsed. The summary is a truncated first line, so the full text is pulled
// from the detail and shown inline.
function AnswerBlock({ step, getDetail }: { step: Activity; getDetail: (seq: number) => Promise<string> }) {
  const [ref, inView] = useInView();
  const [full, setFull] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!inView || step.detail || step.seq < 0) return; // fetch the full answer only when it nears view
    let live = true;
    getDetail(step.seq)
      .then((d) => {
        if (live) setFull(d || step.summary);
      })
      .catch(() => {
        if (live) setFull(step.summary);
      });
    return () => {
      live = false;
    };
  }, [inView, step.seq, getDetail, step.summary, step.detail]);
  return (
    <div ref={ref} data-activity-id={step.seq} className="min-w-0 [overflow-wrap:anywhere]">
      {step.is_error && !step.metadata?.worker_feedback ? <span className="whitespace-pre-wrap text-destructive">{step.detail ?? full ?? step.summary}</span>
        : <Markdown text={step.detail ?? full ?? step.summary} />}
    </div>
  );
}

// Focused ordinary messages load their exact body even when outside the viewport.
function LocatedActivity({
  step,
  getDetail,
  onLocated,
}: {
  step: Activity;
  getDetail: (seq: number) => Promise<string>;
  onLocated?: (el: HTMLElement, explicit?: boolean) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [body, setBody] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    setBody(null);
    setError(false);
    getDetail(step.seq)
      .then((v) => {
        if (current) setBody(v || step.summary);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [step.seq, step.summary, getDetail, retry]);
  React.useEffect(() => {
    if (body === null && !error) return;
    const frame = requestAnimationFrame(() => {
      if (root.current) onLocated?.(root.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [body, error, onLocated]);
  return (
    <div ref={root} data-activity-id={step.seq} className="min-w-0 rounded-md border border-primary p-2">
      {error ? (
        <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
          详情加载失败，重试
        </Button>
      ) : body === null ? (
        "加载中…"
      ) : (
        <div data-search-body>
          <Markdown text={body} />
        </div>
      )}
    </div>
  );
}

// ExecView renders an agent execution replay (planner / worker / main agent) in
// the compact, grouped, expand-to-detail format — thinking, tool calls/results,
// and (for the main agent) the human turns. Worker lane chips show only when the
// view actually mixes agents.
function ActivitySteps({
  activity,
  taskId,
  chat,
  fetchDetail,
  focusActivity,
  onLocated,
  focusLabel = "来源调用",
  steeringExpanded = {},
  onSteeringExpanded,
}: {
  steeringExpanded?: Record<number,boolean>;
  onSteeringExpanded?: (seq:number,open:boolean)=>void;
  activity: Activity[];
  taskId?: string;
  chat?: boolean;
  fetchDetail?: (seq: number) => Promise<string>;
  focusActivity?: number;
  onLocated?: (el: HTMLElement, explicit?: boolean) => void;
  focusLabel?: string;
}) {
  const showWorker = new Set(activity.map((a) => a.worker)).size > 1;
  // default detail fetcher: the task-scoped activity endpoint. The chat page passes
  // its own (conversation-scoped) fetcher instead.
  const getDetail = React.useCallback(
    (seq: number) => (fetchDetail ? fetchDetail(seq) : api.activityDetail(seq, taskId).then((r) => r.detail ?? "")),
    [fetchDetail, taskId],
  );
  return (
    <div className="flex flex-col">
      {groupSteps(activity, !!chat).map((g) =>
        g.type === "steering" ? (
          <SteeringNotice key={"s"+g.key} step={g.step} getDetail={getDetail} expanded={steeringExpanded[g.key]??false} onExpandedChange={onSteeringExpanded!} focused={g.key===focusActivity} onLocated={onLocated}/>
        ) : g.type === "round" && g.key === focusActivity ? (
          <LocatedActivity
            key={`located-${g.key}`}
            step={activity.find((a) => a.seq === g.key)!}
            getDetail={getDetail}
            onLocated={onLocated}
          />
        ) : g.type === "round" ? (
          <div key={"r" + g.key} className="my-2 flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {g.label}
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : (g.type === "user" || g.type === "answer") && g.step.seq === focusActivity ? (
          <LocatedActivity key={`located-${g.key}`} step={g.step} getDetail={getDetail} onLocated={onLocated} />
        ) : g.type === "msg" && g.steps.some((s) => s.seq === focusActivity) ? (
          <React.Fragment key={`located-${g.key}`}>
            {g.steps.map((step) =>
              step.seq === focusActivity ? (
                <LocatedActivity key={step.seq} step={step} getDetail={getDetail} onLocated={onLocated} />
              ) : (
                <MessageBlock
                  key={step.seq}
                  group={{ ...g, steps: [step] }}
                  getDetail={getDetail}
                  showWorker={showWorker}
                />
              ),
            )}
          </React.Fragment>
        ) : g.type === "user" ? (
          <UserRow key={"u" + g.key} step={g.step} intent={g.intent} getDetail={getDetail} />
        ) : g.type === "answer" ? (
          <AnswerBlock key={"a" + g.key} step={g.step} getDetail={getDetail} />
        ) : g.type === "tool" ? (
          <ToolBlock
            key={"t" + g.key}
            group={g}
            getDetail={getDetail}
            showWorker={showWorker}
            focused={!!focusActivity && (g.use?.seq === focusActivity || g.result?.seq === focusActivity)}
            onLocated={onLocated}
            focusLabel={focusLabel}
          />
         ) : (
          <MessageBlock key={"m" + g.key} group={g} getDetail={getDetail} showWorker={showWorker} />
        ),
      )}
    </div>
  );
}

type ExecutionProps = React.ComponentProps<typeof ActivitySteps> & {live?:boolean;scrollItems?:boolean;pendingStatus?:string;conversationId?:number};
const roleNames:Record<string,string>={mainagent:'Main',main:'Main',goals:'Goals',planner:'Planner',worker:'Worker',auto:'Auto',pentest:'Pentest',reporter:'Reporter',retester:'Retester'};
function TurnDetails({summary,label,elapsed,conversationId}:{summary?:TurnSummary;label:string;elapsed:string;conversationId?:number}){
  const unknown='未记录',usage=summary?.usage;
  const values:[string,React.ReactNode][]=[
    ['开始时间',summary?.started_at?new Date(summary.started_at).toLocaleString('zh-CN'):unknown],['耗时',elapsed],
    ['模式',({managed:'托管',manual:'手动',conversation:'独立会话'} as Record<string,string>)[summary?.mode??'']??unknown],
    ['角色',roleNames[summary?.role??'']??summary?.role??unknown],
    ...(conversationId?([['会话',`#${conversationId}`]] as [string,React.ReactNode][]):summary?.role==='mainagent'&&summary.main_seg!=null?([['会话',`主 Agent · #${summary.main_seg+1}`]] as [string,React.ReactNode][]):[]),
    ['模型',summary?.models.length?summary.models.join(' → '):unknown],
    ['步骤',summary?.steps??unknown],['工具调用',summary?.tool_calls??unknown],['失败调用',summary?.failed_tool_calls??unknown],
    ['Token',usage?`${usage.total.toLocaleString()}${usage.incomplete?'（部分用量未知）':''}`:unknown],
    ...(usage?([['输入总量 / 输出',`${usage.input} / ${usage.output}`],['未缓存输入',usage.uncached_input??unknown],['缓存读取 / 写入',`${usage.cache_read} / ${usage.cache_write}`],
      ['压缩请求 / Token',usage.compaction_requests===null?unknown:`${usage.compaction_requests} / ${usage.compaction_tokens}`],
      ['失败或中断请求 / Token',usage.failed_requests===null?unknown:`${usage.failed_requests} / ${usage.failed_request_tokens}`]] as [string,React.ReactNode][]):[]),
    ...(summary?.queue_ms!=null?([['执行前等待',`${(summary.queue_ms/1000).toFixed(1)} 秒`]] as [string,React.ReactNode][]):[]),
    ...(summary?.intent_id?([['意图',`#${summary.intent_id}`]] as [string,React.ReactNode][]):[]),
  ];
  return <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="执行详情"><InfoIcon/></Button></PopoverTrigger>
    <PopoverContent align="start" collisionPadding={12} className="w-80 max-w-[calc(100vw-24px)] p-4">
      <PopoverHeader><PopoverTitle>执行详情</PopoverTitle><PopoverDescription>{label} · 仅统计本轮执行</PopoverDescription></PopoverHeader>
      <Separator/>
      <dl className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">{values.map(([name,value])=><div key={name} className="flex items-start justify-between gap-6"><dt className="shrink-0 text-muted-foreground">{name}</dt><dd className="min-w-0 text-right break-words">{value}</dd></div>)}</dl>
      <p className="text-xs text-muted-foreground">一步为一次模型响应。工具调用单独计数；压缩和失败请求的已知用量包含在总 Token 中。</p>
    </PopoverContent>
  </Popover>;
}
function ExecutionTurn({turn,summary,latest,...props}:ExecutionProps&{turn:ReturnType<typeof conversationTurns>[number];summary?:TurnSummary;latest:boolean}){
  const getDetail=React.useCallback((seq:number)=>props.fetchDetail?props.fetchDetail(seq):api.activityDetail(seq,props.taskId).then(r=>r.detail??''),[props.fetchDetail,props.taskId]);
  const last=turn.steps.at(-1)!;
  const terminal=turn.steps.findLast(s=>isLifecycle(s)||s.metadata?.event_type==='outcome');
  // A durable terminal activity may arrive before its summary in the same SSE batch.
  const status=summary?.revision&&summary.revision>=(terminal?.seq??0)?summary.status:terminal?.metadata?.status??summary?.status;
  const ended=!!terminal||!!status&&!['running','unknown','awaiting_confirmation'].includes(status);
  const streaming=turn.steps.some(s=>s.streaming);
  const live=!ended&&(streaming||(props.live&&latest)||status==='running');
  const interrupted=turn.steps.some(s=>s.interrupted)||status==='interrupted';
  const pending=turn.steps.some(t=>t.kind==='tool_use'&&!turn.steps.some(s=>s.kind==='tool_result'&&s.tool_use_id===t.tool_use_id));
  const failed=terminal?.is_error||status==='failed'||status==='blocked';
  const label=status==='awaiting_confirmation'?'等待宿主确认':!ended&&props.pendingStatus&&latest?'等待停止确认':failed?'失败':status==='stopped'||status==='paused'?'已停止':status==='exhausted'?'预算耗尽':interrupted?'执行已中断':ended?'已完成':live?(pending?'执行工具中':streaming?'正在生成':'等待模型响应'):'历史记录';
  const [now,setNow]=React.useState(Date.now);
  React.useEffect(()=>{if(!live)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[live]);
  const elapsed=durationLabel(summary?.started_at??null,summary?.finished_at??terminal?.ts??null,now);
  const {final,process:rawProcess}=turnParts(turn.steps,summary);
  const planning=plannerRoundView(turn.steps,summary,live,ended);
  const process=planning?rawProcess.filter(a=>!isPlannerBoundary(a)):rawProcess;
  const workerResults=!!props.taskId&&!props.conversationId&&ended&&(summary?.role==='worker'||last.worker.startsWith('work#'));
  const [steeringFocus,setSteeringFocus]=React.useState<number>();
  const [steeringExpanded,setSteeringExpanded]=React.useState<Record<number,boolean>>({});
  const onSteeringExpanded=React.useCallback((seq:number,open:boolean)=>setSteeringExpanded(old=>({...old,[seq]:open})),[]);
  React.useEffect(()=>{setSteeringFocus(undefined);if(props.focusActivity!=null)onSteeringExpanded(props.focusActivity,true);},[props.focusActivity,onSteeringExpanded]);
  const focus=steeringFocus??props.focusActivity;
  const steeringJump=React.useRef<number|undefined>(undefined);
  const locate=React.useCallback((el:HTMLElement)=>{
    const explicit=steeringJump.current!=null&&el.dataset.activityId===String(steeringJump.current);
    if(explicit)steeringJump.current=undefined;
    props.onLocated?.(el,explicit);
  },[props.onLocated]);
  const stepProps={...props,onLocated:locate,focusActivity:focus,steeringExpanded,onSteeringExpanded};
  // Search can reveal the original duplicate receipt without corrupting the normal assembly.
  const focusedOriginal=turn.steps.find(s=>s.seq===focus&&!(planning&&isPlannerBoundary(s)));
  const processSteps=focusedOriginal&&focusedOriginal.seq!==final?.seq&&!process.some(s=>s.seq===focus)?[...process,focusedOriginal].sort((a,b)=>a.seq-b.seq):process;
  const hasProcess=processSteps.length>0&&(processSteps.some(s=>isSteering(s)||['thinking','tool_use','tool_result','round'].includes(s.kind))||(summary?.steps??0)>1);
  const [manualOpen,setManualOpen]=React.useState<{open:boolean;focus?:number}|undefined>(undefined);
  const focusInside=!!focus&&processSteps.some(s=>s.seq===focus);
  const open=(focusInside&&manualOpen?.focus!==focus)||(manualOpen?.open??(live||!summary?.started_at));
  const steering=processSteps.filter(isSteering);
  const errorText=summary?.error??(failed?terminal?.detail||terminal?.summary:undefined);
  const failedTools=summary?.failed_tool_calls??new Set(processSteps.filter(s=>s.kind==='tool_result'&&s.is_error).map(s=>s.tool_use_id??s.seq)).size;
  const statusClass=cn('execution-status text-sm',failed||status==='exhausted'?'text-destructive':status==='completed'||status==='done'?'text-[var(--status-success)]':'text-muted-foreground',live&&'shimmer');
  async function copy(){try{const entries=final?[final]:processSteps.filter(s=>['text','assistant','result'].includes(s.kind));const bodies=await Promise.all(entries.map(s=>s.detail??(s.seq>0?getDetail(s.seq):Promise.resolve(s.summary))));await navigator.clipboard.writeText(bodies.join('\n\n'));toast.success('已复制');}catch{toast.error('复制失败');}}
  if(turn.steps.every(isSteering))return <ActivitySteps {...stepProps} activity={turn.steps}/>;
  if(turn.user)return <UserRow step={last} intent={last.kind==='intent'} getDetail={getDetail}/>;
  if(last.metadata?.worker_feedback||last.worker==='system')return <Message align="start"><MessageContent><Bubble variant="muted"><BubbleContent><ActivitySteps {...stepProps} activity={turn.steps}/></BubbleContent></Bubble></MessageContent></Message>;
  return <Message data-turn-id={turn.key} data-run-status={label} align="start"><MessageContent>
    {planning&&<PlannerRoundMarker round={planning} focusActivity={focus} onLocated={props.onLocated}/> }
    <Bubble variant="ghost" className="w-full max-w-full"><BubbleContent className="flex w-full min-w-0 flex-col gap-4 py-2">
      <div className="flex flex-wrap items-center gap-2"><span role="status" className={statusClass}><span className="execution-status-dot" aria-hidden="true"/>{label}</span><span aria-hidden="true" className="text-muted-foreground">/</span><span className="text-sm text-muted-foreground tabular-nums">{elapsed}</span><TurnDetails summary={summary} label={label} elapsed={elapsed} conversationId={props.conversationId}/></div>
      {hasProcess?<Collapsible open={open} onOpenChange={open=>{setManualOpen({open,focus:props.focusActivity});setSteeringFocus(undefined);}}>
        <CollapsibleTrigger asChild><Button variant="ghost" className="h-auto w-full justify-start whitespace-normal px-0 py-2 text-left"><ChevronRight className={cn('transition-transform',open&&'rotate-90')}/><span>{live?'执行中':ended?(failed?'执行失败':['completed','done'].includes(status??'')?'执行完成':'执行记录'):'历史过程'}</span><span className="font-normal text-muted-foreground">{summary?.steps==null?'步骤未记录':`${summary.steps} 步`} · {summary?.tool_calls==null?'调用数未记录':`${summary.tool_calls} 次工具调用`}{failedTools>0?` · ${failedTools} 次失败`:''}</span></Button></CollapsibleTrigger>
        {!open&&steering.length>0&&<Button variant="outline" size="sm" onClick={()=>{const seq=steering[0].seq;steeringJump.current=seq;setManualOpen({open:true,focus:seq});setSteeringFocus(seq);onSteeringExpanded(seq,true);}}><Flag/>有 {steering.length} 条纠偏</Button>}
        <CollapsibleContent className="min-w-0 border-l pl-3 sm:pl-5"><ActivitySteps {...stepProps} activity={processSteps}/></CollapsibleContent>
      </Collapsible>:processSteps.length>0?<ActivitySteps {...stepProps} activity={processSteps}/>:null}
      {errorText&&!final&&<Alert variant={failed||status==='exhausted'?'destructive':'default'}><AlertDescription>{errorText}</AlertDescription></Alert>}
      {final&&<div data-final-answer="true">{workerResults?<WorkerConclusion focused={focus===final.seq}><ActivitySteps {...stepProps} activity={[final]}/></WorkerConclusion>:<ActivitySteps {...stepProps} activity={[final]}/>}</div>}
      {workerResults&&<WorkerWritebacks key={`${props.taskId}:${turn.key}`} task={props.taskId!} turn={summary?.turn_id??turnID(last)??turn.key} status={status} revision={terminal?.seq??summary?.revision??last.seq}/>}
    </BubbleContent></Bubble>
    <MessageFooter className="gap-3"><Button variant="ghost" size="icon-sm" onClick={()=>void copy()} disabled={!final&&!processSteps.some(s=>["text","assistant","result"].includes(s.kind)&&!!(s.detail||s.summary))} aria-label="复制答复"><CopyIcon/></Button><ActivityTime ts={terminal?.ts??last.ts}/>{last.inherited&&<Badge variant="outline">来源任务 · 只读</Badge>}</MessageFooter>
  </MessageContent></Message>;
}
// Native scroller owns the jump and disables follow-to-bottom for this explicit
// navigation. The negative margin locates the control within its enclosing turn.
function ScrollingExecutionTurn(props:React.ComponentProps<typeof ExecutionTurn>) {
  const {scrollToMessage}=useMessageScroller();
  const locate=React.useCallback((el:HTMLElement,explicit?:boolean)=>{
    if(props.onLocated){props.onLocated(el,explicit);return;}
    const item=el.closest<HTMLElement>('[data-slot="message-scroller-item"]');
    if(item)scrollToMessage(props.turn.key,{align:'start',scrollMargin:12-(el.getBoundingClientRect().top-item.getBoundingClientRect().top)});
  },[props.onLocated,props.turn.key,scrollToMessage]);
  return <ExecutionTurn {...props} onLocated={locate}/>;
}
function ExecView(props:ExecutionProps) {
  const turns=conversationTurns(props.activity);
  const summaries=useTurnSummaries(props.taskId,props.conversationId,props.activity.map(turnID).filter((id):id is string=>!!id));
  return <>{turns.map((turn,index)=>{
    const id=turn.steps.map(turnID).find(Boolean);
    const Turn=props.scrollItems?ScrollingExecutionTurn:ExecutionTurn;
    const body=<Turn {...props} turn={turn} summary={id?summaries[id]:undefined} latest={index===turns.length-1}/>;
    return props.scrollItems?<MessageScrollerItem key={turn.key} messageId={turn.key}>{body}</MessageScrollerItem>:<div key={turn.key} className="my-2 min-w-0">{body}</div>;
  })}</>;
}

// Transcript renders a session's activity as a compact grouped execution replay:
// human turns, thinking, tool calls (command+result paired), and messages — for
// the main agent (interactive) and worker/planner (read-only) alike.
export function Transcript({
  activity,
  live,
  taskId,
  chat,
  fetchDetail,
  focusActivity,
  focusedSeq,
  onLocated,
  focusLabel = "来源调用",
  scrollItems,
  pendingStatus,
  conversationId,
}: {
  conversationId?:number;
  pendingStatus?:string;
  activity: Activity[];
  scrollItems?: boolean;
  live?: boolean;
  taskId?: string;
  chat?: boolean;
  fetchDetail?: (seq: number) => Promise<string>;
  focusActivity?: number;
  focusedSeq?: number;
  onLocated?: (el: HTMLElement, explicit?: boolean) => void;
  focusLabel?: string;
}) {
  const detailFetcher=React.useRef(fetchDetail);
  detailFetcher.current=fetchDetail;
  const stableDetail=React.useCallback((seq:number)=>detailFetcher.current?detailFetcher.current(seq):api.activityDetail(seq,taskId).then(r=>r.detail??''),[taskId]);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const [focusPadding, setFocusPadding] = React.useState(0);
  React.useLayoutEffect(() => {
    if (focusedSeq == null) {
      setFocusPadding(0);
      return;
    }
    const viewport = transcriptRef.current?.closest('[data-slot="scroll-area-viewport"], [data-slot="message-scroller-viewport"]');
    if (!viewport) return;
    const measure = () => setFocusPadding(viewport.clientHeight / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [focusedSeq]);
  const content=<ExecView conversationId={conversationId} activity={activity} live={live} scrollItems={scrollItems} pendingStatus={pendingStatus}
    taskId={taskId} chat={chat} fetchDetail={stableDetail} focusActivity={focusActivity??focusedSeq} onLocated={onLocated} focusLabel={focusLabel}/>;
  // The native scroller measures its direct DOM children. A wrapper (even with
  // display:contents) hides the message geometry and breaks manual scrolling.
  if(scrollItems)return content;
  return <div ref={transcriptRef} className="flex flex-col gap-1" style={focusPadding?{paddingBlock:focusPadding}:undefined}>{content}</div>;
}
