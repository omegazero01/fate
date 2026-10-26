"use client";
import {notifyTurnSummaries} from '@/lib/turn-summary';

import { preserveTranscriptPosition } from "@/lib/transcript-scroll";
import { openActivityStream } from "@/lib/activity-event-source";
import { withLiveStreams, mergeConversationActivities, type StreamSnapshot } from "@/lib/conversation-turns";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "@/components/ui/message-scroller";
import * as React from "react";
import {useWorkspaceState} from "@/hooks/use-workspace-state";
import { lastMainActivity } from "@/lib/worker-feedback";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SourceTranscript } from "@/components/source-transcript";

import {
  ArrowUpIcon,
  SlidersHorizontalIcon,
  GaugeIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  HistoryIcon,
  ListChecksIcon,
  Loader2Icon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  RotateCwIcon,
  ShieldAlertIcon,
  SquareIcon,
  Trash2Icon,
  UserIcon,
  WifiOffIcon,
  XIcon,
  ZapOffIcon,
} from "lucide-react";
import { toast } from "sonner";

import { TodoPopover } from "@/components/todo-popover";
import { Transcript } from "@/components/transcript";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { MentionTextarea } from "@/components/mention-textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, sseUrl } from "@/lib/api";
import { shouldSubmitOnKey, useChatSendMode } from "@/lib/chat-send-mode";
import { MOCK } from "@/lib/mock/enabled";
import { taskAssetSourceLabel, taskAssetTypeLabel } from "@/lib/task-assets";
import { toolCallRevision } from "@/lib/tool-calls";
import type {
  Activity,
  ChatAttachment,
  IntentAsset,
  Session,
  SessionStatus,
  SessionTokenUsage,
  TaskLLMResolution,
  TaskLLMResolutions,
  TaskNode,
  TokenTotal,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { RelatedSessions, RelatedSessionDetail } from "./related-sessions";
import { MainConversation, SessionWorkspace } from "./session-workspace";
import { WorkerQueue } from "./worker-queue";

// resolutionLabel names the LLM a session runs on. The badge shows this alone and
// keeps the model id in its tooltip. Env-backed configs can arrive without a name,
// so fall back to the model id rather than rendering an empty badge.
function resolutionLabel(r: TaskLLMResolution): string {
  return r.name || r.model || "未命名配置";
}

// fmtBytes renders a human file size for attachment chips (mirrors transcript.tsx).
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

// ── Reliability model (see docs/task-session-history-sse-remediation.md) ──────────
// The task's activity is NO LONGER one unbounded `allActivity` array replayed from
// SSE since=0. Instead:
//   • Each UI session (main | plan | intent:<id>) has its own lazily-loaded, reverse-
//     paginated cache (SessionState below). Opening a session loads only its latest
//     page; scrolling up pages older history in.
//   • A single task-level SSE (opened at since=snapshot_cursor from the first history
//     page) tails ALL agents' new activity; frames are dispatched by session_key.
//   • History + SSE meet gap-free at snapshot_cursor and are merged by seq (dedup),
//     so refresh / tab-switch / sleep / reconnect never drop the newest records.

const PAGE = 200; // history page size
const SYSTEM_SCAN_PAGE = 500; // generic activity pages scanned to recover sparse system audit events
const MAX_KEEP = 4000; // per-session in-memory cap; older pages re-fetched on scroll-up
const STREAM_WINDOW_MS = 5000; // "live" = activity seen within this window
// One session's lazily-loaded, reverse-paginated cache. `lastTs`/`unread` are kept
// live even for sessions that were never opened, so the list shows liveness + unread
// without holding their full history.
type SessionState = {
  items: Activity[];
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean; // older history remains above the loaded window
  earliestSeq: number; // earliest loaded id — reverse-pagination anchor
  unread: number;
  lastTs: string; // most-recent activity time (drives live badge; updated even when unloaded)
  error?: string;
};
type SessionStore = Record<string, SessionState>;

function emptyState(): SessionState {
  return {
    items: [],
    loaded: false,
    loading: false,
    loadingMore: false,
    hasMore: false,
    earliestSeq: 0,
    unread: 0,
    lastTs: "",
  };
}

// sessionKeyOf routes an activity to its stable session key. worker="planner" covers
// BOTH the Goal Agent's round-0 decomposition and the Planner (single Plan session).
function sessionKeyOf(a: Activity): string {
  if (a.worker === "system" || a.kind === "llm_switch" || a.kind === "llm_failover") return "system";
  if (a.worker === "mainagent" || a.worker === "main") return `main:${a.main_seg ?? 0}`; // one key per conversation segment
  if (a.worker === "planner" || a.worker === "goals") return "plan";
  if (a.intent_id) return `intent:${a.intent_id}`;
  return "unknown";
}

// mergeBySeq unions two activity lists by seq (dedup) in ascending seq order. Every
// data source — latest page, older page, SSE compensation, live tail — goes through
// this, so history responses can never clobber live records received meanwhile.
const mergeBySeq = mergeConversationActivities;

// statusIcon maps a session status to its icon. Worker terminal states are
// distinct & color-coded: 完成(绿勾圈) / 取消停止(琥珀斜杠圈) / 出错(红叉圈) /
// 步数耗尽(紫). running=蓝色转圈, pending(待领取)=灰时钟.
function statusIcon(status: SessionStatus) {
  switch (status) {
    case "running": // 执行中
      return <Loader2Icon className="size-3.5 animate-spin text-blue-500" />;
    case "paused":
      return <PauseIcon className="size-3.5 text-amber-500" />;
    case "pending": // 待领取(open intent)
      return <ClockIcon className="size-3.5 text-muted-foreground" />;
    case "done": // 完成
      return <CircleCheckIcon className="size-3.5 text-emerald-500" />;
    case "stopped": // 取消/停止(被 planner 终止)
      return <CircleSlashIcon className="size-3.5 text-amber-500" />;
    case "blocked": // 出错
      return <CircleXIcon className="size-3.5 text-red-500" />;
    case "exhausted": // 步数耗尽(撞 max_turns)
      return <ZapOffIcon className="size-3.5 text-violet-500" />;
  }
}

// fmtTokens renders a compact token count (1234 → 1.2k, 2_000_000 → 2M).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

const TokenMetrics = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span"> & {
    input: number;
    cache: number;
    output: number;
    labels?: "short" | "long";
  }
>(({ input, cache, output, labels = "short", className, ...props }, ref) => {
  const names = labels === "short" ? ["入", "缓", "出"] : ["input", "cache", "output"];
  const values = [input, cache, output];
  return (
    <span
      ref={ref}
      className={cn("inline-flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground", className)}
      {...props}
    >
      {values.map((value, index) => (
        <React.Fragment key={names[index]}>
          <span>{names[index]}</span>
          <Badge variant="secondary" className="h-5 px-1.5 font-mono tabular-nums">
            {fmtTokens(value)}
          </Badge>
        </React.Fragment>
      ))}
    </span>
  );
});
TokenMetrics.displayName = "TokenMetrics";

// fmtDuration renders an elapsed milliseconds span compactly (90s → 1m30s).
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

const roleMeta = {
  mainagent: { label: "主 Agent", icon: UserIcon },
  planner: { label: "目标与规划", icon: BrainIcon },
  worker: { label: "Workers", icon: RadioIcon },
  system: { label: "系统审计", icon: HistoryIcon },
} as const;

// The main-agent session is the interactive entry point of this tab and has no
// dedicated backend "sessions" endpoint — it is a fixed UI affordance whose
// transcript is the main-agent activity stream (worker="mainagent") for the task.
// A main-agent session is one resettable conversation segment. Segment 0 is the
// original session; "新建会话" creates further segments (seq 1,2,…) so the agent
// starts on a clean transcript while the task's graph/assets/goal stay shared. Each
// segment is a switchable UI session; only the current (highest) one is writable.
const mainSessionId = (seg: number) => `s-main-${seg}`;
const mainSessionKey = (seg: number) => `main:${seg}`;
const mainSessionTitle = (seg: number) => `主 Agent · 会话 #${seg + 1}`;
const MAIN_ID = mainSessionId(0);
const MAIN_SESSION: Session = {
  id: MAIN_ID,
  role: "mainagent",
  title: mainSessionTitle(0),
  status: "running",
  live: true,
  last_activity: "",
  seg: 0,
};

// The planner session is, like the main-agent session, a fixed UI affordance with
// no dedicated backend "sessions" endpoint — its transcript is every activity step
// the planner emits (worker === "planner", which also carries the Goal Agent's
// round-0 decomposition; the planner carries no intent_id since it generates intents).
const PLANNER_ID = "s-planner";
const PLANNER_SESSION: Session = {
  id: PLANNER_ID,
  role: "planner",
  title: "目标与规划 · Goals / Planner",
  status: "running",
  live: true,
  last_activity: "",
};

// LLM provider switches are task-level audit events rather than agent output. The
// history endpoint has no "system" filter, so this fixed session is populated by
// scanning the generic incremental activity endpoint and then tailed by task SSE.
const SYSTEM_ID = "s-system";
const SYSTEM_SESSION: Session = {
  id: SYSTEM_ID,
  role: "system",
  title: "系统事件 · LLM 故障转移",
  status: "done",
  live: false,
  last_activity: "",
};

// keyForSession maps a UI Session → its stable store key (main:<seg> | plan | intent:<id>).
function keyForSession(s: Session): string {
  if (s.role === "mainagent") return `main:${s.seg ?? 0}`;
  if (s.role === "planner") return "plan";
  if (s.role === "system") return "system";
  return `intent:${s.intent_id}`;
}

// Map an exploration intent (TaskNode) state → a session status the UI renders.
function intentStatus(state: string): SessionStatus {
  switch (state) {
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "exhausted":
      return "exhausted";
    case "stopped":
      return "stopped";
    case "paused":
      return "paused";
    case "open": // 待领取，区别于执行中
      return "pending";
    default: // running
      return "running";
  }
}

// Derive worker sessions from running/open intents — there is no backend
// sessions endpoint, so intents (≈ worker units) are the closest real source.
function intentToSession(n: TaskNode): Session {
  const label = (n.payload ?? "").trim();
  const state = intentStatus(n.state);
  return {
    id: n.id,
    role: "worker",
    title: label || `Intent ${n.id}`,
    status: state,
    live: !n.inherited && state === "running",
    last_activity: n.ts,
    intent_id: n.id,
    source_task_id: n.source_task_id,
    inherited: n.inherited,
  };
}

function SessionItem({
  s,
  active,
  displayTitle,
  unread,
  onClick,
  onCancel,
  onResume,
  onDelete,
  selected,
  onSelect,
  controlling,
  executionCancelled,
}: {
  s: Session;
  active: boolean;
  displayTitle: string;
  unread?: number;
  onClick: () => void;
  onCancel?: () => void;
  onResume?: () => void;
  onDelete?: () => void;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  controlling?: boolean;
  executionCancelled?: boolean;
}) {
  const icon = executionCancelled ? (
    <CircleSlashIcon className="size-3.5 text-violet-400 dark:text-violet-300" />
  ) : s.role === "worker" ? (
    statusIcon(s.status)
  ) : s.live ? (
    <Loader2Icon className="size-3.5 animate-spin text-blue-500" />
  ) : null;

  const cancellable =
    s.role === "worker" &&
    !s.inherited &&
    !executionCancelled &&
    (s.status === "pending" || s.status === "running" || s.status === "paused");
  return (
    <div
      className={cn(
        "group/session flex w-full items-center rounded-md transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {onSelect && (
        <Checkbox
          className="ml-2 shrink-0"
          checked={selected}
          disabled={controlling}
          onCheckedChange={(value) => onSelect(value === true)}
          aria-label={`选择 Worker #${s.intent_id}`}
        />
      )}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-sm"
      >
        {icon ?? <span className="size-3.5 shrink-0" />}
        {s.intent_id && (
          <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            #{s.intent_id}
          </span>
        )}
        {s.inherited && s.source_task_id && (
          <Badge variant="outline" className="shrink-0">
            来源 #{s.source_task_id}
          </Badge>
        )}
        <span
          className={cn("min-w-0 flex-1 truncate text-sm font-medium", executionCancelled && "text-muted-foreground")}
        >
          {displayTitle}
        </span>
        {executionCancelled && (
          <Badge variant="outline" className="shrink-0">
            已取消执行
          </Badge>
        )}
        {!active && unread ? (
          <span className="inline-flex min-w-4 items-center justify-center rounded-md bg-blue-500/15 px-1 text-[10px] font-medium tabular-nums text-blue-600 dark:text-blue-400">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
        {s.live && (
          <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
            <span className="size-1 animate-pulse rounded-full bg-blue-500" />
            实时
          </span>
        )}
      </button>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          title="删除 Worker"
          aria-label="删除 Worker"
          disabled={controlling}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      )}
      {cancellable && (
        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover/session:opacity-100 sm:group-focus-within/session:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onCancel}
            disabled={controlling}
            title="取消 Worker 执行"
            aria-label="取消 Worker 执行"
          >
            <CircleSlashIcon />
          </Button>
        </div>
      )}
    </div>
  );
}

function truncateWorkerAssetLabel(value: string, maxChars = 30): string {
  const chars = Array.from(value.trim());
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function WorkerAssetBadge({ assets }: { assets: IntentAsset[] }) {
  const displayAssets = assets.filter(
    (asset) => asset.type === "root_domain" || asset.type === "subdomain" || asset.type === "ip",
  );
  if (displayAssets.length === 0) return null;

  const first = displayAssets[0];
  const firstRawLabel = first.label.trim() || `#${first.asset_id}`;
  const firstLabel = truncateWorkerAssetLabel(firstRawLabel);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="max-w-60 shrink-0 font-normal" title={firstRawLabel}>
          <span className="truncate">当前资产：{firstLabel}</span>
          {displayAssets.length > 1 && <span className="shrink-0 tabular-nums">+{displayAssets.length - 1}</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-sm">
        <div className="flex flex-col gap-2">
          {displayAssets.map((asset) => (
            <div key={`${asset.intent_id}-${asset.asset_id}`} className="min-w-0">
              <div className="break-all font-mono text-xs">{asset.label.trim() || `#${asset.asset_id}`}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {taskAssetTypeLabel(asset.type)} · {taskAssetSourceLabel(asset.source)}
                {asset.inherited ? ` · 来源任务 #${asset.source_task_id}` : ""}
              </div>
              <div className="mt-0.5 [overflow-wrap:anywhere] text-xs">{asset.source_summary}</div>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function SessionsTab({
  taskId,
  processOpen, onProcessOpenChange, onOpenSettings,
  workerExecutionAllowed = true,
}: {
  taskId: string;
  workerExecutionAllowed?: boolean;
  processOpen: boolean; onProcessOpenChange: (open:boolean)=>void;
  onOpenSettings?:()=>void;
}) {
  const [relatedSession,setRelatedSession]=React.useState<import("@/lib/types").Conversation|null>(null);
  const [selectedSessionId, setActiveId] = React.useState(MAIN_ID);
  const [sourceIntent, setSourceIntent] = React.useState<TaskNode | null>(null);
  const [sourceSession, setSourceSession] = React.useState<Session | null>(null);
  const route = useRouter();
  const params = useSearchParams();
  const focusSession = params.get("session") || "";
  const focusSeq = Number(params.get("activity"));
  const focused =
    Number.isSafeInteger(focusSeq) && focusSeq > 0 && /^(main:\d+|plan|intent:[1-9]\d*)$/.test(focusSession);
  const invalidFocus = (params.has("session") || params.has("activity")) && !focused;
  const clearFocus = () => {
    const next = new URLSearchParams(params);
    next.delete("session");
    next.delete("activity");
    route.replace(`/function/tasks/detail?${next}`, { scroll: false });
  };
  const activeId = selectedSessionId;
  // Main-agent conversation segments (newest-first); currentSeg is the writable one.
  const [mainSegs, setMainSegs] = React.useState<{ seq: number; created_at: string }[]>([{ seq: 0, created_at: "" }]);
  const [currentSeg, setCurrentSeg] = React.useState(0);
  const [viewedMainSeg,setViewedMainSeg]=React.useState<number|null>(null);
  const [creatingMain, setCreatingMain] = React.useState(false);
  const [confirmNewMain, setConfirmNewMain] = React.useState(false);
  // 手机端（<lg）会话列表默认折叠：屏幕高度本就紧张，列表若固定占掉 10~15rem，
  // 下方的会话记录会被挤到只剩标题与输入框。折叠后记录区拿到几乎全部高度，
  // 点标题栏可展开选会话，选完自动收起。桌面端不受影响（lg 起始终展开）。
  const [listOpen, setListOpen] = React.useState(true);
  // Per-session lazily-loaded caches, keyed by session_key (main | plan | intent:<id>).
  const [store, setStore] = React.useState<SessionStore>({});
  // Worker sessions derived from exploration intents (paged past the old 300 cap).
  const [intents, setIntents] = React.useState<TaskNode[]>([]);
  const [intentAssets, setIntentAssets] = React.useState<IntentAsset[]>([]);
  const [olderIntentAssets, setOlderIntentAssets] = React.useState<IntentAsset[]>([]);
  const [olderIntents, setOlderIntents] = React.useState<TaskNode[]>([]);
  const [firstIntentsHasMore, setFirstIntentsHasMore] = React.useState(false);
  const [olderIntentsHasMore, setOlderIntentsHasMore] = React.useState(false);
  const [hasLoadedOlderIntentsPage, setHasLoadedOlderIntentsPage] = React.useState(false);
  const [loadingOlderIntents, setLoadingOlderIntents] = React.useState(false);
  const [input, setInput] = useWorkspaceState(`task:${taskId}`,"main-draft","");
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [mainChatRunning, setMainChatRunning] = React.useState<boolean | null>(null);
  const [controllingIntent, setControllingIntent] = React.useState<string | null>(null);
  const [workerSelectionMode, setWorkerSelectionMode] = React.useState(false);
  React.useEffect(() => {
    void taskId; // Task changes reset the selection scope.
    setWorkerSelectionMode(false);
    setSelectedWorkers(new Set());
    setDeleteWorkers([]);
    deletedWorkerIds.current.clear();
  }, [taskId]);
  const [selectedWorkers, setSelectedWorkers] = React.useState<Set<string>>(new Set());
  const [deleteWorkers, setDeleteWorkers] = React.useState<Session[]>([]);
  const deletedWorkerIds = React.useRef(new Set<string>());
  const [batchCancelIds, setBatchCancelIds] = React.useState<string[]>([]);
  const [cancelIntent, setCancelIntent] = React.useState<Session | null>(null);
  const [cancelReason, setCancelReason] = React.useState("");
  // 方式1 文件上传:选好的附件(已落到任务工作目录 uploads/),随下条消息一起发。
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function pickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const r = await api.chatUpload("task", taskId, Array.from(files));
      setAttachments((prev) => [...prev, ...r.attachments]);
    } catch (e) {
      toast.error(`上传失败：${(e as Error).message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Start a fresh main-agent session: only the segment counter advances — the task's
  // graph/assets/goal are untouched, so the agent continues over the same task with a
  // clean context. The old segment stays as read-only history you can switch back to.
  async function createMainSession() {
    if (creatingMain) return;
    setCreatingMain(true);
    try {
      const r = await api.newMainSession(taskId);
      setMainSegs((prev) => [{ seq: r.seq, created_at: r.created_at }, ...prev.filter((m) => m.seq !== r.seq)]);
      setCurrentSeg(r.current ?? r.seq);
      // Seed an empty, loaded state so the new (empty) session renders immediately.
      setStore((prev) => ({ ...prev, [mainSessionKey(r.seq)]: { ...emptyState(), loaded: true } }));
      setActiveId(mainSessionId(r.seq));
      setListOpen(false);
      setInput("");
    } catch (e) {
      toast.error(`新建会话失败：${(e as Error).message}`);
    } finally {
      setCreatingMain(false);
      setConfirmNewMain(false);
    }
  }

  const patchIntentState = React.useCallback(
    (intentId: string, state?: string, cancelled?: boolean, reason?: string, executorActive?: boolean) => {
      const patch = (rows: TaskNode[]) =>
        state
          ? rows.map((row) => {
              if (row.id !== intentId) return row;
              let payload = row.payload;
              if (cancelled !== undefined) {
                try {
                  const p = JSON.parse(payload || "{}");
                  payload = JSON.stringify({
                    ...p,
                    cancelled_by_user: cancelled,
                    ...(reason ? { cancel_reason: reason } : {}),
                  });
                } catch {
                  /* Refreshed server rows will reconcile malformed legacy payloads. */
                }
              }
              return { ...row, state, payload, ...(executorActive === undefined ? {} : { executor_active: executorActive }) };
            })
          : rows.filter((row) => row.id !== intentId);
      setIntents(patch);
      setOlderIntents(patch);
    },
    [],
  );

  const [pausingIntent, setPausingIntent] = React.useState<string | null>(null);

  const controlWorker = React.useCallback(
    async (session: Session, action: "pause" | "resume" | "cancel", reason?: string) => {
      if (!session.intent_id || session.inherited || controllingIntent) return;
      setControllingIntent(session.intent_id);
      if (action === "pause") setPausingIntent(session.intent_id);
      try {
        const result = await api.controlIntent(taskId, session.intent_id, action, reason);
        patchIntentState(session.intent_id, result.state, result.cancelled_by_user, result.cancel_reason, result.state === "running" || result.execution_confirmed === false);
        if (action === "pause") {
          if(result.execution_confirmed===false)toast.info(`Worker #${session.intent_id} 正在停止，等待执行器退出`);
          else toast.success(`Worker #${session.intent_id} 已暂停`);
        } else if (action === "resume") {
          toast.success(`Worker #${session.intent_id} 已恢复执行`);
        } else {
          // 取消 = 停止意图并附原因（不销毁意图与产出）；保留会话，状态置为 stopped。
          toast.success(`Worker #${session.intent_id} 已取消执行`);
          setCancelReason("");
        }
      } catch (error) {
        toast.error(`Worker 操作失败：${(error as Error).message}`);
      } finally {
        setControllingIntent(null);
        setPausingIntent(null);
        setCancelIntent(null);
      }
    },
    [controllingIntent, patchIntentState, taskId],
  );

  const controlWorkerBatch = async (ids: string[], action: "cancel" | "resume", reason?: string) => {
    if (controllingIntent || ids.length === 0) return;
    setControllingIntent("batch");
    const succeeded = new Set<string>();
    const failures: string[] = [];
    try {
      for (const id of ids) {
        try {
          const result = await api.controlIntent(taskId, id, action, reason);
          patchIntentState(id, result.state, result.cancelled_by_user, result.cancel_reason, result.state === "running" || result.execution_confirmed === false);
          succeeded.add(id);
        } catch (error) {
          failures.push(`#${id}：${(error as Error).message}`);
        }
      }
      setSelectedWorkers((previous) => new Set([...previous].filter((id) => !succeeded.has(id))));
      const label = action === "cancel" ? "取消执行" : "开启执行";
      if (succeeded.size) toast.success(`${succeeded.size} 个 Worker 已${label}`);
      if (failures.length)
        toast.error(`${failures.length} 个 Worker 操作失败，已保留选择`, { description: failures.join("；") });
    } finally {
      setControllingIntent(null);
      setBatchCancelIds([]);
      setCancelReason("");
    }
  };

  // SSE connection state — surfaced so a dropped realtime link is visible, never
  // silently shown as "no messages".
  const [sseLive, setSseLive] = React.useState(false);
  // Whole-task token total (all agents), polled from the backend aggregate.
  const [taskTokens, setTaskTokens] = React.useState<TokenTotal | null>(null);
  const [sessionTokens, setSessionTokens] = React.useState<Record<string, SessionTokenUsage>>({});
  const [llmResolutions, setLLMResolutions] = React.useState<TaskLLMResolutions | null>(null);
  // Refs backing SSE/loading without re-render churn.
  const snapshotRef = React.useRef(0); // task-level snapshot cursor → SSE since=
  const esRef = React.useRef<ReturnType<typeof openActivityStream> | null>(null);
  // Transient provider text is separate from the durable, sequence-numbered transcript.
  const [streaming, setStreaming] = React.useState<StreamSnapshot[]>([]);
  const activeKeyRef = React.useRef(mainSessionKey(0)); // current session key (for SSE dispatch/unread)
  const atBottomRef = React.useRef(true); // transcript pinned to bottom?
  const llmToastSeqRef = React.useRef<Set<number>>(new Set());
  const chatStatusRequestRef = React.useRef(0);
  const firstIntentsRef = React.useRef<TaskNode[]>([]);
  // Per-key request token: a stale response for a key is ignored (guards fast
  // latest/older interleaving). Writes are ALWAYS keyed, so a late response can only
  // touch its own session cache — never the currently-viewed one (see §7.5).
  const reqTokenRef = React.useRef<Record<string, number>>({});
  // Keys with a latest-page load in flight — dedups the double trigger where the
  // first-load effect and the active-session effect both want "main" on mount (the
  // former also opens the SSE, so it must not be pre-empted).
  const loadingKeysRef = React.useRef<Set<string>>(new Set());

  // ── store helpers ──────────────────────────────────────────────────────────────
  const patchStore = React.useCallback((key: string, fn: (s: SessionState) => SessionState) => {
    setStore((prev) => ({ ...prev, [key]: fn(prev[key] ?? emptyState()) }));
  }, []);

  // Load a session's LATEST page (before=0) on first open. Keyed + request-token
  // guarded so a switch away can't corrupt the view.
  const loadSession = React.useCallback(
    (key: string) => {
      if (MOCK) return; // MOCK preloads everything up front
      if (loadingKeysRef.current.has(key)) return; // already in flight (e.g. main on mount)
      loadingKeysRef.current.add(key);
      const token = (reqTokenRef.current[key] ?? 0) + 1;
      reqTokenRef.current[key] = token;
      patchStore(key, (s) => ({ ...s, loading: true, error: undefined }));

      if (key === "system") {
        void (async () => {
          let since = 0;
          let systemItems: Activity[] = [];
          for (;;) {
            const page = await api.activity(taskId, { since, limit: SYSTEM_SCAN_PAGE });
            if (reqTokenRef.current[key] !== token) return;
            systemItems = mergeBySeq(
              systemItems,
              page.items.filter(
                (item) => item.worker === "system" || item.kind === "llm_switch" || item.kind === "llm_failover",
              ),
            );
            if (page.items.length < SYSTEM_SCAN_PAGE || page.cursor <= since) break;
            since = page.cursor;
          }
          patchStore(key, (s) => {
            const items = mergeBySeq(systemItems, s.items);
            return {
              ...s,
              items,
              loaded: true,
              loading: false,
              hasMore: false,
              earliestSeq: items.length ? items[0].seq : 0,
              unread: 0,
              lastTs: items.length ? items[items.length - 1].ts : s.lastTs,
              error: undefined,
            };
          });
        })()
          .catch((error) => {
            if (reqTokenRef.current[key] !== token) return;
            patchStore(key, (s) => ({
              ...s,
              loading: false,
              error: (error as Error).message || "加载失败",
            }));
          })
          .finally(() => loadingKeysRef.current.delete(key));
        return;
      }

      api
        .activityHistory(taskId, key, 0, PAGE)
        .then((r) => {
          if (reqTokenRef.current[key] !== token) return; // superseded
          if (r.snapshotCursor > snapshotRef.current) snapshotRef.current = r.snapshotCursor;
          patchStore(key, (s) => {
            const items = mergeBySeq(r.items, s.items); // keep any live frames arrived meanwhile
            return {
              ...s,
              items,
              loaded: true,
              loading: false,
              hasMore: r.hasMore,
              earliestSeq: items.length ? items[0].seq : 0,
              unread: 0,
              error: undefined,
            };
          });
        })
        .catch((e) => {
          if (reqTokenRef.current[key] !== token) return;
          patchStore(key, (s) => ({ ...s, loading: false, error: (e as Error).message || "加载失败" }));
        })
        .finally(() => loadingKeysRef.current.delete(key));
    },
    [taskId, patchStore],
  );

  // Load one older page (scroll-up) for a session, preserving scroll position.
  const loadEarlier = React.useCallback(
    (key: string, viewport: () => HTMLElement | null) => {
      const st = store[key];
      if (!st || st.loadingMore || !st.hasMore || !st.earliestSeq) return;
      const restore = preserveTranscriptPosition(viewport());
      patchStore(key, (s) => ({ ...s, loadingMore: true }));
      api
        .activityHistory(taskId, key, st.earliestSeq, PAGE)
        .then((r) => {
          patchStore(key, (s) => {
            const items = mergeBySeq(r.items, s.items);
            return {
              ...s,
              items,
              loadingMore: false,
              hasMore: r.hasMore,
              earliestSeq: items.length ? items[0].seq : s.earliestSeq,
            };
          });

        })
        .catch(() => {
          patchStore(key, (s) => ({ ...s, loadingMore: false }));
        }).finally(restore);
    },
    [taskId, store, patchStore],
  );

  // ── task token total (whole task, all agents) ───────────────────────────────────
  React.useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .tokenStats(taskId)
        .then((r) => {
          if (!alive) return;
          setTaskTokens(r.total);
          setSessionTokens(Object.fromEntries(r.sessions.map((item) => [item.session, item])));
        })
        .catch(() => {
          // Polling is best-effort; the next interval retries automatically.
        });
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [taskId]);

  React.useEffect(() => {
    let alive = true;
    setMainChatRunning(null);
    const load = () => {
      const request = ++chatStatusRequestRef.current;
      return api
        .chatStatus(taskId)
        .then(({ running }) => {
          if (alive && chatStatusRequestRef.current === request) setMainChatRunning(running);
        })
        .catch(() => {
          // Keep the last authoritative value. Before the first success, recent
          // activity remains a conservative fallback.
        });
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId]);

  React.useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .taskLLMResolution(taskId)
        .then((value) => {
          if (alive) setLLMResolutions(value);
        })
        .catch(() => {
          // Polling is best-effort; the next interval retries automatically.
        });
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId]);

  // Re-render on a timer so "streaming" liveness recomputes as activity goes stale.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1500);
    return () => clearInterval(id);
  }, []);

  // ── first load + single task SSE ────────────────────────────────────────────────
  // On task open: load Main's latest page, take the task-level snapshot cursor from
  // it, THEN open ONE task SSE at since=snapshot_cursor. History covers id≤cursor and
  // the SSE covers id>cursor with no gap. The SSE tails ALL agents; frames are routed
  // by session_key. EventSource auto-reconnects and (via our `id:` lines → Last-Event-
  // ID) resumes from the DB, so a dropped realtime link self-heals; seq-merge dedups.
  React.useEffect(() => {
    setStore({});
    setIntents([]);
    setIntentAssets([]);
    setOlderIntentAssets([]);
    setOlderIntents([]);
    setFirstIntentsHasMore(false);
    setOlderIntentsHasMore(false);
    setHasLoadedOlderIntentsPage(false);
    setTaskTokens(null);
    setSessionTokens({});
    setLLMResolutions(null);
    setSseLive(false);
    setActiveId(MAIN_ID); // a stale worker id from the previous task must not leak in
    setMainSegs([{ seq: 0, created_at: "" }]);
    setCurrentSeg(0);
    snapshotRef.current = 0;
    llmToastSeqRef.current = new Set();
    reqTokenRef.current = {};
    // Reserve the initial main key so the active-session effect (which fires for main on
    // mount) won't double-load it and pre-empt the SSE opened here.
    loadingKeysRef.current = new Set([mainSessionKey(0)]);
    let alive = true;
    let pending: Activity[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushActivities = () => {
      flushTimer = undefined;
      if (!alive || !pending.length) return;
      const batches = new Map<string, Activity[]>();
      for (const activity of pending) {
        const key = sessionKeyOf(activity);
        const batch = batches.get(key) ?? [];
        batch.push(activity);
        batches.set(key, batch);
      }
      pending = [];
      const activeK = activeKeyRef.current;
      const atBottom = atBottomRef.current;
      setStore((prev) => {
        const next = { ...prev };
        for (const [key, batch] of batches) {
          const cur = prev[key] ?? emptyState();
          const lastTs = lastMainActivity(batch)?.ts ?? cur.lastTs;
          if (!cur.loaded && !cur.loading && key !== activeK) {
            const accounting = batch.filter((item) => item.kind === "usage" || item.kind === "result");
            next[key] = {
              ...cur,
              items: mergeBySeq(cur.items, accounting).slice(-4),
              lastTs,
              unread: cur.unread + batch.length,
            };
            continue;
          }
          let items = mergeBySeq(cur.items, batch);
          let hasMore = cur.hasMore;
          let earliestSeq = cur.earliestSeq;
          // Preserve scrolled-up history; trimmed rows remain available via pagination.
          if ((key !== activeK || atBottom) && items.length > MAX_KEEP) {
            items = items.slice(-MAX_KEEP);
            hasMore = true;
            earliestSeq = items[0].seq;
          }
          next[key] = {
            ...cur,
            items,
            lastTs,
            hasMore,
            earliestSeq,
            unread: key === activeK ? 0 : cur.unread + batch.length,
          };
        }
        return next;
      });
    };

    // MOCK demo: no SSE backend — pull one activity snapshot and bucket by session.
    if (MOCK) {
      api
        .activity(taskId)
        .then((r) => {
          if (!alive) return;
          const buckets: SessionStore = {};
          for (const a of r.items) {
            const k = sessionKeyOf(a);
            if (!buckets[k]) buckets[k] = emptyState();
            buckets[k].items.push(a);
          }
          for (const k of Object.keys(buckets)) {
            const st = buckets[k];
            st.items.sort((p, q) => p.seq - q.seq);
            st.loaded = true;
            st.hasMore = false;
            st.earliestSeq = st.items.length ? st.items[0].seq : 0;
            st.lastTs = lastMainActivity(st.items)?.ts ?? "";
          }
          buckets[mainSessionKey(0)] ??= { ...emptyState(), loaded: true };
          buckets.system ??= { ...emptyState(), loaded: true };
          setStore(buckets);
        })
        .catch(() =>
          setStore({
            [mainSessionKey(0)]: { ...emptyState(), loaded: true },
            system: { ...emptyState(), loaded: true },
          }),
        );
      return () => {
        alive = false;
      };
    }

    const token = (reqTokenRef.current.mainboot ?? 0) + 1;
    reqTokenRef.current.mainboot = token;
    let bootKey = mainSessionKey(0);
    // Resolve the main-agent segments first, then load the CURRENT segment's history and
    // open the SSE from its snapshot cursor. The SSE tails all segments and routes each
    // frame by session_key (main:<seg>), so switching segments needs no new stream.
    api
      .mainSessions(taskId)
      .then((ms) => {
        if (!alive || reqTokenRef.current.mainboot !== token) throw new Error("superseded");
        const segs = ms.sessions.length ? ms.sessions : [{ seq: 0, created_at: "" }];
        setMainSegs(segs);
        setCurrentSeg(ms.current);
        bootKey = mainSessionKey(ms.current);
        if (bootKey !== mainSessionKey(0)) loadingKeysRef.current.delete(mainSessionKey(0));
        loadingKeysRef.current.add(bootKey);
        // A late bootstrap response must not undo a user selection.
        setActiveId(selected => selected === MAIN_ID ? mainSessionId(ms.current) : selected);
        patchStore(bootKey, (s) => ({ ...s, loading: true }));
        return api.activityHistory(taskId, bootKey, 0, PAGE);
      })
      .then((r) => {
        if (!alive || reqTokenRef.current.mainboot !== token) return;
        snapshotRef.current = r.snapshotCursor;
        patchStore(bootKey, (s) => {
          const items = mergeBySeq(r.items, s.items);
          return {
            ...s,
            items,
            loaded: true,
            loading: false,
            hasMore: r.hasMore,
            earliestSeq: items.length ? items[0].seq : 0,
            unread: 0,
          };
        });
        // Open the single task SSE from the snapshot cursor.
        let streamCursor=r.snapshotCursor;
        esRef.current = openActivityStream(
          ()=>sseUrl(`/api/exploration/activity/stream?task=${encodeURIComponent(taskId)}&since=${streamCursor}`), es=>{
        es.addEventListener("turn_summary",event=>{if(alive){try{notifyTurnSummaries(`task:${taskId}`,JSON.parse((event as MessageEvent).data));}catch{/* history repairs */}}});
        es.addEventListener("streams", event => {
          if(!alive)return;
          try {
            const items = JSON.parse((event as MessageEvent).data).items;
            // Durable rows precede their snapshot removal in the same SSE batch.
            // Commit both state updates together, bypassing the replay throttle.
            if (flushTimer !== undefined) clearTimeout(flushTimer);
            flushActivities();
            setStreaming(items);
          } catch {setSseLive(false);}
        });
        es.addEventListener("access_revoked",()=>{if(alive){setStore({});setStreaming([]);esRef.current?.close();toast.error("任务已删除或授权已撤销");}});
        es.onmessage = (e) => {
          if (!alive) return;
          let a: Activity;
          try {
            a = JSON.parse(e.data) as Activity;
          } catch {
            return; // ignore malformed frame
          }
          if ((a.kind === "llm_switch" || a.kind === "llm_failover") && !llmToastSeqRef.current.has(a.seq)) {
            llmToastSeqRef.current.add(a.seq);
            const transition = a.metadata?.llm_transition;
            if (transition?.mode === "exhausted" || a.is_error) {
              toast.error(a.summary, { id: `task-${taskId}-llm-${a.seq}` });
            } else if (transition?.mode === "automatic") {
              toast.success(a.summary, { id: `task-${taskId}-llm-${a.seq}` });
            } else {
              toast.info(a.summary, { id: `task-${taskId}-llm-${a.seq}` });
            }
            void api
              .taskLLMResolution(taskId)
              .then((value) => {
                if (alive) setLLMResolutions(value);
              })
              .catch(() => {
                // The periodic resolver poll will retry if this event-triggered refresh fails.
              });
          }
          streamCursor=Math.max(streamCursor,a.seq);
          pending.push(a);
          // Replay can arrive in hundreds of frames. Merge once per session per
          // batch instead of repeatedly sorting its entire history for every frame.
          if (flushTimer === undefined) flushTimer = setTimeout(flushActivities, 50);
        };
        },value=>{if(alive)setSseLive(value);});
      })
      .catch((err) => {
        if (!alive || reqTokenRef.current.mainboot !== token) return;
        if ((err as Error).message === "superseded") return;
        patchStore(bootKey, (s) => ({ ...s, loading: false, error: (err as Error).message || "加载失败" }));
      })
      .finally(() => loadingKeysRef.current.delete(bootKey));

    return () => {
      alive = false;
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      pending = [];
      esRef.current?.close();
      setStreaming([]);
      esRef.current = null;
    };
  }, [taskId, patchStore]);

  React.useEffect(() => {
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      return api
        .taskIntentAssets(taskId, 0, 300, controller.signal)
        .then((assets) => {
          if (active) setIntentAssets(assets);
        })
        .catch(() => {
          // The next poll retries; Worker controls and transcripts remain available.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [taskId]);

  // ── worker (intent) session list — paged, poll first page lightly ───────────────
  React.useEffect(() => {
    let active = true;
    let inFlight = false;
    firstIntentsRef.current = [];
    setIntents([]);
    setOlderIntents([]);
    setFirstIntentsHasMore(false);
    setOlderIntentsHasMore(false);
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      return api
        .intentsPage(taskId, 0, 300)
        .then((r) => {
          if (!active) return;
          r.items = r.items.filter((item) => !deletedWorkerIds.current.has(item.id));
          const freshIds = new Set(r.items.map((item) => item.id));
          const oldestFreshId = r.items.reduce((minimum, item) => Math.min(minimum, Number(item.id)), Infinity);
          const displaced = r.hasMore
            ? firstIntentsRef.current.filter((item) => !freshIds.has(item.id) && Number(item.id) < oldestFreshId)
            : [];
          if (displaced.length > 0) {
            setOlderIntents((previous) => {
              const byId = new Map(previous.map((item) => [item.id, item]));
              for (const item of displaced) byId.set(item.id, item);
              return [...byId.values()];
            });
          }
          firstIntentsRef.current = r.items;
          setIntents(r.items);
          setFirstIntentsHasMore(r.hasMore);
        })
        .catch(() => {
          // Polling is best-effort; the next interval retries automatically.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [taskId]);

  const loadOlderIntents = React.useCallback(() => {
    if (loadingOlderIntents) return;
    const all = [...intents, ...olderIntents];
    const minId = all.reduce((m, n) => Math.min(m, Number(n.id)), Infinity);
    if (!Number.isFinite(minId)) return;
    setLoadingOlderIntents(true);
    Promise.all([api.intentsPage(taskId, minId, 300), api.taskIntentAssets(taskId, minId, 300)])
      .then(([r, assets]) => {
        setOlderIntents((prev) => {
          const seen = new Set([...intents, ...prev].map((n) => n.id));
          return [...prev, ...r.items.filter((n) => !seen.has(n.id))];
        });
        setOlderIntentAssets((previous) => {
          const seen = new Set(previous.map((asset) => `${asset.intent_id}:${asset.asset_id}:${asset.source_task_id}`));
          return [
            ...previous,
            ...assets.filter((asset) => !seen.has(`${asset.intent_id}:${asset.asset_id}:${asset.source_task_id}`)),
          ];
        });
        setOlderIntentsHasMore(r.hasMore);
        setHasLoadedOlderIntentsPage(true);
      })
      .catch(() => {
        // A later manual retry can fetch this page again.
      })
      .finally(() => setLoadingOlderIntents(false));
  }, [taskId, intents, olderIntents, loadingOlderIntents]);

  React.useEffect(() => {
    if (!focused || !focusSession.startsWith("intent:")) return;
    let alive = true;
    const id = focusSession.slice(7);
    void api
      .intentsPage(taskId, Number(id) + 1, 1)
      .then((page) => {
        if (alive) setSourceIntent(page.items.find((n) => n.id === id) ?? null);
      })
      .catch(() => {
        /* The history endpoint reports an unavailable source. */
      });
    return () => {
      alive = false;
    };
  }, [taskId, focused, focusSession]);

  // Combined, de-duplicated worker list (newest first page + older loaded pages).
  const allIntents = React.useMemo(() => {
    const byId = new Map<string, TaskNode>();
    if (sourceIntent) byId.set(sourceIntent.id, sourceIntent);
    for (const n of olderIntents) byId.set(n.id, n);
    for (const n of intents) byId.set(n.id, n); // fresh poll wins over older snapshot
    return [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
  }, [intents, olderIntents, sourceIntent]);
  const intentAssetsByID = React.useMemo(() => {
    const grouped = new Map<string, IntentAsset[]>();
    for (const asset of [...intentAssets, ...olderIntentAssets]) {
      const key = String(asset.intent_id);
      const current = grouped.get(key);
      if (current) current.push(asset);
      else grouped.set(key, [asset]);
    }
    return grouped;
  }, [intentAssets, olderIntentAssets]);

  const workerSessions = React.useMemo(
    () => allIntents.filter((item) => !deletedWorkerIds.current.has(item.id)).map(intentToSession),
    [allIntents],
  );
  const intentsHasMore = hasLoadedOlderIntentsPage ? olderIntentsHasMore : firstIntentsHasMore;

  // For each worker session (intent), derive the display title from the intent
  // payload summary. Also store the full TaskNode for the hover-JSON tooltip.
  const sessionMeta = React.useMemo(() => {
    const map = new Map<
      string,
      { title: string; json: unknown; executionCancelled: boolean; executionCancelReason: string }
    >();
    for (const node of allIntents) {
      let title = `Intent ${node.id}`;
      let parsedPayload: unknown = node.payload;
      let executionCancelled = false;
      let executionCancelReason = "";
      if (node.payload) {
        try {
          const p = JSON.parse(node.payload);
          parsedPayload = p;
          if (p?.summary) title = String(p.summary);
          if (p?.cancelled_by_user) {
            executionCancelled = true;
            executionCancelReason = String(p.cancel_reason ?? "");
          }
        } catch {
          title = node.payload.trim() || title;
        }
      }
      const json = { ...node, payload: parsedPayload };
      map.set(node.id, { title, json, executionCancelled, executionCancelReason });
    }
    return map;
  }, [allIntents]);

  // Liveness from each session's last-seen activity time (kept fresh by the 1.5s tick).
  const recentLive = React.useCallback(
    (key: string) => {
      const ts = store[key]?.lastTs;
      if (!ts) return false;
      const t = Date.parse(ts);
      return t > 0 && Date.now() - t < STREAM_WINDOW_MS;
    },
    [store],
  );
  const currentMainKey = mainSessionKey(currentSeg);
  const plannerLive = recentLive("plan");

  // Which main segment is streaming RIGHT NOW. A main turn is serialized per task, so at
  // most one segment is live. Gate on the real running flag (sending / mainChatRunning)
  // rather than "recent activity", and drop it the moment the turn's terminal record
  // (kind='result', or an error) lands — otherwise the badge lingers for STREAM_WINDOW_MS
  // after the agent already finished. null = nothing running.
  const liveMainSeg = React.useMemo<number | null>(() => {
    if (!(sending || mainChatRunning)) return null;
    // the streaming segment is the one with the freshest activity (incl. the just-sent turn)
    let seg = currentSeg;
    let bestTs = -1;
    for (const m of mainSegs) {
      const raw = store[mainSessionKey(m.seq)]?.lastTs;
      const ts = raw ? Date.parse(raw) : -1;
      if (ts > bestTs) {
        bestTs = ts;
        seg = m.seq;
      }
    }
    const items = store[mainSessionKey(seg)]?.items ?? [];
    const last = lastMainActivity(items);
    if (last && (last.kind === "result" || (last.kind === "text" && last.is_error))) return null;
    return seg;
  }, [sending, mainChatRunning, mainSegs, store, currentSeg]);

  // Every main-agent segment is an independent, interactive session (like the top-level
  // chat conversations) — you can talk in any of them, newest-first.
  const selectableWorkers = workerSessions.filter(
    (worker) =>
      !worker.inherited &&
      worker.intent_id &&
      (["pending", "running", "paused"].includes(worker.status) || sessionMeta.get(worker.id)?.executionCancelled),
  );
  const selectedVisibleWorkers = selectableWorkers.filter((worker) => selectedWorkers.has(worker.intent_id!));
  const batchCancellable = selectedVisibleWorkers.filter((worker) =>
    ["pending", "running", "paused"].includes(worker.status),
  );
  const batchResumable = selectedVisibleWorkers.filter(
    (worker) => worker.status === "paused" && workerExecutionAllowed && !allIntents.some(n => n.id === worker.intent_id && n.executor_active),
  );
  const batchDeletable = selectedVisibleWorkers.filter(
    (worker) => worker.status === "pending" || sessionMeta.get(worker.id)?.executionCancelled,
  );
  const deletionBusy = React.useRef(false);
  const performWorkerDelete = async () => {
    if (controllingIntent || deletionBusy.current || !deleteWorkers.length) return;
    deletionBusy.current = true;
    setControllingIntent("delete");
    const removed = new Set<string>();
    const failures: string[] = [];
    try {
      for (const worker of deleteWorkers) {
        const id = worker.intent_id!;
        try {
          await api.deleteWorker(taskId, id);
          removed.add(id);
          deletedWorkerIds.current.add(id);
          setIntents((items) => items.filter((item) => item.id !== id));
          setOlderIntents((items) => items.filter((item) => item.id !== id));
          firstIntentsRef.current = firstIntentsRef.current.filter((item) => item.id !== id);
          setStore((previous) => {
            const next = { ...previous };
            delete next[keyForSession(worker)];
            return next;
          });
          setActiveId((current) => (current === worker.id ? MAIN_ID : current));
        } catch (e) {
          failures.push(`#${id}：${(e as Error).message}`);
        }
      }
      setSelectedWorkers((previous) => new Set([...previous].filter((id) => !removed.has(id))));
      if (removed.size) toast.success(`已删除 ${removed.size} 个 Worker，已有产出保留`);
      if (failures.length) toast.error("部分 Worker 未删除，已保留选择", { description: failures.join("；") });
      const fresh = await api.intentsPage(taskId, 0, 300);
      setIntents(fresh.items.filter((item) => !deletedWorkerIds.current.has(item.id)));
    } catch (e) {
      toast.error(`刷新失败：${(e as Error).message}`);
    } finally {
      setControllingIntent(null);
      setDeleteWorkers([]);
      deletionBusy.current = false;
    }
  };
  const allWorkersSelected = selectableWorkers.length > 0 && selectedVisibleWorkers.length === selectableWorkers.length;
  const toggleWorkerSelection = (id: string, checked: boolean) => {
    setSelectedWorkers((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const mainSessions = React.useMemo<Session[]>(
    () =>
      mainSegs.map((m) => ({
        id: mainSessionId(m.seq),
        role: "mainagent",
        title: mainSessionTitle(m.seq),
        status: "running",
        live: m.seq === liveMainSeg,
        last_activity: m.created_at,
        seg: m.seq,
      })),
    [mainSegs, liveMainSeg],
  );

  const sessions = React.useMemo(() => {
    const items = [...mainSessions, { ...PLANNER_SESSION, live: plannerLive }, ...workerSessions, SYSTEM_SESSION];
    return items;
  }, [mainSessions, workerSessions, plannerLive]);

  const grouped = {
    mainagent: sessions.filter((s) => s.role === "mainagent"),
    planner: sessions.filter((s) => s.role === "planner"),
    worker: sessions.filter((s) => s.role === "worker"),
    system: sessions.filter((s) => s.role === "system"),
  };

  const focusedSession: Session | undefined = focused
    ? sessions.find((s) => keyForSession(s) === focusSession) ||
      (focusSession === "plan"
        ? PLANNER_SESSION
        : focusSession.startsWith("main:")
          ? {
              ...MAIN_SESSION,
              id: mainSessionId(Number(focusSession.split(":")[1])),
              seg: Number(focusSession.split(":")[1]),
              title: mainSessionTitle(Number(focusSession.split(":")[1])),
            }
          : {
              id: focusSession.split(":")[1],
              role: "worker",
              intent_id: focusSession.split(":")[1],
              title: `Worker · 意图 #${focusSession.split(":")[1]}`,
              status: "done",
              live: false,
              last_activity: "",
            })
    : undefined;
  const active =
    focusedSession ??
    sessions.find((s) => s.id === activeId) ??
    (sourceSession?.id === activeId ? sourceSession : MAIN_SESSION);
  const isMain = active.role === "mainagent";
  const isPlanner = active.role === "planner";
  const isSystem = active.role === "system";
  const activeKey = keyForSession(active);
  const activeState = store[activeKey];
  // A main turn is serialized per task (chat lock), so "busy" is task-wide: while any
  // main segment is mid-turn the active composer is disabled. Clear it the moment the
  // active session's terminal record (kind='result', or an error) lands, so the input
  // re-enables immediately instead of waiting for the next chat-status poll.
  const activeItems = activeState?.items ?? [];
  const activeLast = lastMainActivity(activeItems);
  const activeSettled =
    !!activeLast && (activeLast.kind === "result" || (activeLast.kind === "text" && activeLast.is_error));
  const mainSeg=isMain?(active.seg??currentSeg):(viewedMainSeg??currentSeg);
  const mainKey=mainSessionKey(mainSeg);
  const mainState=store[mainKey];
  const mainBusy=sending||(mainChatRunning??recentLive(mainKey));
  React.useEffect(()=>{if(isMain)setViewedMainSeg(active.seg??currentSeg);},[isMain,active.seg,currentSeg]);
  React.useEffect(()=>{loadSession(mainKey);},[mainKey,loadSession]);
  React.useEffect(()=>{if(focused)onProcessOpenChange(!isMain);},[focused,isMain,onProcessOpenChange]);
  // 折叠态（手机端）标题栏要替代整张列表：显示当前会话名 + 其它会话的未读合计，
  // 否则收起后既不知道自己在看哪个会话，也看不到别处有新消息。
  const activeDisplayTitle = (active.role === "worker" ? sessionMeta.get(active.id)?.title : "") || active.title;
  const hiddenUnread = React.useMemo(
    () => Object.entries(store).reduce((sum, [key, s]) => (key === activeKey ? sum : sum + s.unread), 0),
    [store, activeKey],
  );

  // Keep the SSE dispatcher's notion of the active session current, and lazily load
  // + clear unread whenever the active session changes. Recheck after boot resolves
  // the current segment: it releases the initial main:0 reservation, which may
  // still be selected by an activity link into an older segment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cache updates must not reactivate the current session.
  React.useEffect(() => {
    activeKeyRef.current = activeKey;
    const st = store[activeKey];
    if (!st || (!st.loaded && !st.loading)) {
      loadSession(activeKey);
    } else if (st.unread) {
      patchStore(activeKey, (s) => ({ ...s, unread: 0 }));
    }
  }, [activeKey, currentSeg]);

  // Main agent is the human↔orchestrator CONSOLE: only the conversation (user msgs +
  // the main agent's own replies/steps). Planner session shows planner steps; a
  // worker session shows only its intent's activity, led by the intent objective.
  const activity = React.useMemo(() => {
    const items = activeState?.items ?? [];
    // Optimistic user rows reconcile with durable records by request/turn ID.
    if (isMain) return items;
    if (isPlanner || isSystem) return items;
    // Worker session: the intent leads the transcript as a right-aligned "user"-style
    // message (the task handed to this worker), followed by its execution steps.
    const intentTitle = sessionMeta.get(active.id)?.title ?? active.title;
    const intentMsg: Activity = {
      seq: -1, // sorts/leads before any real step (real seq ≥ 0)
      worker: items[0]?.worker ?? active.id, // reuse the lane so no worker chips appear
      ts: active.last_activity || "",
      kind: "intent", // LLM-generated objective — rendered as a distinct (non-human) bubble
      summary: intentTitle,
      source_task_id: active.source_task_id,
      inherited: active.inherited,
    };
    return [intentMsg, ...items];
  }, [
    isMain,
    isPlanner,
    isSystem,
    activeState,
    active.id,
    active.title,
    active.last_activity,
    active.source_task_id,
    active.inherited,
    sessionMeta,
  ]);

  // seq of this session's most-recent TodoWrite call — for the Todo popover.
  const latestTodoSeq = React.useMemo(() => {
    for (let i = activity.length - 1; i >= 0; i--) {
      const a = activity[i];
      if (a.kind === "tool_use" && a.tool === "TodoWrite") return a.seq;
    }
    return null;
  }, [activity]);

  // Ledger snapshots already include completed requests from a live execution.
  // Never add the cumulative native usage frame on top of a server snapshot.
  const tokenForSession = React.useCallback((key:string):TokenTotal=>sessionTokens[key]??{
    input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,usage_complete:false,
  },[sessionTokens]);

  const activeTokens = tokenForSession(activeKey);
  const tokenTotal = {
    i: activeTokens.input_tokens,
    o: activeTokens.output_tokens,
    cr: activeTokens.cache_read_tokens,
    any:
      activeTokens.input_tokens +
        activeTokens.output_tokens >
      0,
  };

  // Run duration = span from this session's first step to its last (for a live
  // session, "now" so it ticks up — the 1.5s setTick above re-renders it).
  const runDuration = React.useMemo(() => {
    let min = Infinity,
      max = 0;
    for (const a of activity) {
      const t = Date.parse(a.ts);
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    if (!Number.isFinite(min) || max === 0) return null;
    const end = active.live ? Date.now() : max;
    return Math.max(0, end - min);
  }, [activity, active.live]);

  // ---- transcript auto-scroll (open → bottom; stick to bottom unless scrolled up) ----
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const viewport = React.useCallback(
    () => (contentRef.current?.closest('[data-slot="scroll-area-viewport"], [data-slot="message-scroller-viewport"]') as HTMLElement | null) ?? null,
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId intentionally rebinds the scroll listener.
  React.useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const onScroll = () => {
      atBottomRef.current = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 60;
      if (vp.scrollTop <= 80) loadEarlier(activeKeyRef.current, viewport); // near top → older page
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [viewport, focused, activeId, loadEarlier]);
  function stop() {
    if (stopping) return;
    setStopping(true);
    void api.stopChat(taskId).then(result=>{if(result.status!=="waiting_for_executor")setStopping(false);}).catch(()=>{setStopping(false);toast.error("停止请求失败，请重试");});
  }

  React.useEffect(()=>{if(mainChatRunning===false&&!sending)setStopping(false);},[mainChatRunning,sending]);

  function send() {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || sending || mainBusy) return;
    const requestID=crypto.randomUUID();
    const sentKey=mainKey;
    patchStore(sentKey,s=>({...s,items:mergeBySeq(s.items,[{seq:-Date.now(),worker:"mainagent",main_seg:mainSeg,kind:"user",summary:text,detail:text,ts:new Date().toISOString(),turn_id:requestID,metadata:{turn_id:requestID,attachments:atts}}])}));
    setInput("");
    setAttachments([]);
    setSending(true);
    chatStatusRequestRef.current++;
    api
      .chat(text, taskId, atts.length > 0 ? atts : undefined, mainSeg,requestID)
      .then(({ mode }) => {
        chatStatusRequestRef.current++;
        setMainChatRunning(mode === "llm");
      })
      .catch(async (e) => {
        try {
          const history=await api.activityHistory(taskId,sentKey,0,PAGE);
          patchStore(sentKey,s=>({...s,items:mergeBySeq(s.items,history.items)}));
          if(history.items.some(a=>(a.turn_id??a.metadata?.turn_id)===requestID)) {toast.info("消息已接收，正在同步执行状态");return;}
          patchStore(sentKey,s=>({...s,items:s.items.filter(a=>a.turn_id!==requestID)}));
          setInput(text);setAttachments(atts);
          toast.error(`发送失败：${(e as Error).message}`);
        } catch {toast.error("发送状态待确认，恢复连接后核对记录，请勿重复发送");}
      })
      .finally(() => setSending(false));
  }

  const workerExiting=allIntents.some(n=>n.id===active.intent_id&&n.executor_active===true&&n.state!=="running");
  const mainLoaded = !!store[currentMainKey]?.loaded;
  // 发送键位由系统设置决定（localStorage），默认 Enter 发送。
  const sendMode = useChatSendMode();
  // What the transcript pane should show for the active session.
  const showLoader = !activeState || (activeState.loading && !activeState.loaded);
  const resolutionForSession = (session: Session): TaskLLMResolution | undefined => {
    if (!llmResolutions || session.inherited || session.role === "system") return undefined;
    if (session.role === "mainagent") return llmResolutions.mainagent;
    if (session.role === "planner") return llmResolutions.planner;
    return llmResolutions.worker;
  };
  const activeResolution = resolutionForSession(active);
  const activeAssets =
    active.role === "worker" && active.intent_id ? intentAssetsByID.get(active.intent_id) : undefined;

  const composer=(
<div className="task-composer">
                {attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {attachments.map((a) => (
                      <div
                        key={a.path}
                        className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs"
                        title={a.path}
                      >
                        <PaperclipIcon className="size-3 shrink-0 text-primary" />
                        <span className="max-w-[160px] truncate">{a.name}</span>
                        <span className="text-muted-foreground">{fmtBytes(a.size)}</span>
                        <button
                          type="button"
                          className="ml-0.5 text-muted-foreground hover:text-foreground"
                          onClick={() => setAttachments((p) => p.filter((x) => x.path !== a.path))}
                          title="移除"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void pickFiles(e.target.files)}
                />
                <InputGroup className="min-h-9 has-disabled:opacity-100">
                  {onOpenSettings && <InputGroupAddon align="block-start"><InputGroupButton variant="outline" className="composer-config" onClick={onOpenSettings}><GaugeIcon data-icon="inline-start"/>任务配置</InputGroupButton></InputGroupAddon>}
                  <MentionTextarea
                    inputGroup
                    rows={1}
                    aria-label="给主 Agent 发消息"
                    placeholder={
                      mainBusy ? "主 Agent 正在运行，可输入 /btw 提问…" : "给主 Agent 发消息，@ 引用漏洞、资产等…"
                    }
                    value={input}
                    disabled={sending}
                    onValueChange={setInput}
                    onKeyDown={(e) => {
                      if (!shouldSubmitOnKey(e, sendMode)) return;
                      e.preventDefault();
                      send();
                    }}
                    className="max-h-36 min-h-9 overflow-y-auto"
                  />
                  <InputGroupAddon align="block-end">
                    {onOpenSettings && <InputGroupButton size="icon-sm" variant="ghost" onClick={onOpenSettings} aria-label="打开任务设置"><SlidersHorizontalIcon/></InputGroupButton>}
                    <InputGroupButton
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={mainBusy || uploading}
                      title="上传文件"
                      aria-label="上传文件"
                    >
                      {uploading ? <Loader2Icon className="animate-spin" /> : <PaperclipIcon />}
                    </InputGroupButton>
                    {false && (
                      <InputGroupButton size="icon-xs" onClick={send} aria-label="发送旁路问题">
                        <ArrowUpIcon />
                      </InputGroupButton>
                    )}
                    {mainBusy ? (
                      <InputGroupButton
                        className="composer-send ml-auto"
                        size="icon-sm"
                        variant="destructive"
                        onClick={stop}
                        disabled={stopping}
                        title="停止当前执行"
                        aria-label="停止当前执行"
                      >
                        {stopping ? <Loader2Icon className="animate-spin" /> : <SquareIcon />}
                      </InputGroupButton>
                    ) : (
                      <InputGroupButton
                        className="composer-send ml-auto"
                        size="icon-sm"
                        variant="default"
                        onClick={send}
                        disabled={(!input.trim() && attachments.length === 0) || sending}
                        title="发送消息"
                        aria-label="发送消息"
                      >
                        {sending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
                      </InputGroupButton>
                    )}
                  </InputGroupAddon>
                </InputGroup>
              </div>
  );
  const agentList=(

        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card">
          <div className="border-b px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setListOpen(true)}
                aria-expanded={listOpen}
                aria-controls="session-list-panel"
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium text-muted-foreground lg:pointer-events-none"
              >
                <ChevronDownIcon
                  className={cn("size-3.5 shrink-0 transition-transform lg:hidden", !listOpen && "-rotate-90")}
                />
                <span className="shrink-0">会话列表</span>
                {!listOpen && (
                  <>
                    <span className="min-w-0 truncate text-foreground lg:hidden" title={activeDisplayTitle}>
                      · {activeDisplayTitle}
                    </span>
                    {hiddenUnread > 0 && (
                      <span className="inline-flex min-w-4 shrink-0 items-center justify-center rounded-md bg-blue-500/15 px-1 text-[10px] font-medium tabular-nums text-blue-600 lg:hidden dark:text-blue-400">
                        {hiddenUnread > 99 ? "99+" : hiddenUnread}
                      </span>
                    )}
                  </>
                )}
              </button>
              {!MOCK && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-[10px]",
                    sseLive ? "text-emerald-500" : "text-amber-500",
                  )}
                  title={sseLive ? "实时连接正常" : "实时连接中断，正在自动重连（历史仍可见）"}
                >
                  {sseLive ? (
                    <>
                      <span className="size-1 animate-pulse rounded-full bg-emerald-500" />
                      实时
                    </>
                  ) : (
                    <>
                      <WifiOffIcon className="size-3" />
                      重连中
                    </>
                  )}
                </span>
              )}
            </div>
            {taskTokens && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span>任务总计</span>
                    <span>·</span>
                    <TokenMetrics
                      input={taskTokens.input_tokens}
                      cache={taskTokens.cache_read_tokens}
                      output={taskTokens.output_tokens}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {taskTokens.usage_complete===false?"已记录输入":"输入总量"} {taskTokens.input_tokens.toLocaleString()} · 输出 {taskTokens.output_tokens.toLocaleString()} ·
                  缓存读取 {taskTokens.cache_read_tokens.toLocaleString()} · 缓存写入{" "}
                  {taskTokens.cache_write_tokens.toLocaleString()}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <ScrollArea
            id="session-list-panel"
            type="auto"
            className={cn(
              "min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!",
              !listOpen && "max-lg:hidden",
            )}
          >
            <div className="flex w-full flex-col gap-3 p-2">
              {(["mainagent", "planner", "system", "worker"] as const).map((role) => {
                const items = grouped[role];
                if (!items.length) return null;
                const Meta = roleMeta[role];
                return (
                  <div key={role} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                      <Meta.icon className="size-3.5" />
                      {Meta.label}
                      {role === "mainagent" && (
                        <button
                          type="button"
                          onClick={() => setConfirmNewMain(true)}
                          disabled={creatingMain}
                          title="新建主 Agent 会话（清空上下文，任务状态保留）"
                          aria-label="新建主 Agent 会话"
                          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
                        >
                          {creatingMain ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : (
                            <PlusIcon className="size-3.5" />
                          )}
                          新建
                        </button>
                      )}
                      {role === "worker" && (
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          <WorkerQueue key={taskId} taskId={taskId} disabled={controllingIntent !== null} />
                          {selectableWorkers.length > 0 && !workerSelectionMode && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              title="多选 Worker"
                              aria-label="多选 Worker"
                              disabled={controllingIntent !== null}
                              onClick={() => setWorkerSelectionMode(true)}
                            >
                              <ListChecksIcon />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                    {role === "worker" && workerSelectionMode && (
                      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-2">
                        <label htmlFor="worker-select-all" className="flex items-center gap-1 text-xs">
                          <Checkbox
                            id="worker-select-all"
                            aria-label="全选当前已加载的可操作 Worker"
                            checked={
                              allWorkersSelected ? true : selectedVisibleWorkers.length ? "indeterminate" : false
                            }
                            disabled={controllingIntent !== null}
                            onCheckedChange={(checked) =>
                              setSelectedWorkers(
                                checked === true
                                  ? new Set(selectableWorkers.map((worker) => worker.intent_id!))
                                  : new Set(),
                              )
                            }
                          />
                          全选已加载
                        </label>
                        <span className="text-xs text-muted-foreground">已选 {selectedVisibleWorkers.length}</span>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={controllingIntent !== null || !batchDeletable.length}
                          onClick={() =>
                            setDeleteWorkers(
                              batchDeletable.map((worker) => ({
                                ...worker,
                                title: sessionMeta.get(worker.id)?.title ?? worker.title,
                              })),
                            )
                          }
                        >
                          <Trash2Icon data-icon="inline-start" />
                          删除 ({batchDeletable.length})
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={controllingIntent !== null}
                          onClick={() => {
                            setWorkerSelectionMode(false);
                            setSelectedWorkers(new Set());
                          }}
                        >
                          完成
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={controllingIntent !== null || !batchCancellable.length}
                          onClick={() => {
                            setCancelReason("");
                            setBatchCancelIds(batchCancellable.map((worker) => worker.intent_id!));
                          }}
                        >
                          <CircleSlashIcon data-icon="inline-start" />
                          取消执行 ({batchCancellable.length})
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          title={`批量开启执行（${batchResumable.length} 个 Worker）`}
                          aria-label={`批量开启执行（${batchResumable.length} 个 Worker）`}
                          disabled={controllingIntent !== null || !batchResumable.length}
                          onClick={() =>
                            void controlWorkerBatch(
                              batchResumable.map((worker) => worker.intent_id!),
                              "resume",
                            )
                          }
                        >
                          <PlayIcon />
                        </Button>
                      </div>
                    )}
                    {items.map((s) => {
                      const meta = s.role === "worker" ? sessionMeta.get(s.id) : undefined;
                      return (
                        <SessionItem
                          key={s.id}
                          s={s}
                          active={s.id === active.id}
                          displayTitle={meta?.title ?? s.title}
                          unread={store[keyForSession(s)]?.unread}
                          onClick={() => {
                            if (focused || invalidFocus) clearFocus();
                            setActiveId(s.id);
                            onProcessOpenChange(true);
                          }}
                          controlling={controllingIntent !== null}
                          selected={selectedWorkers.has(s.intent_id ?? "")}
                          onSelect={
                            workerSelectionMode &&
                            s.role === "worker" &&
                            !s.inherited &&
                            s.intent_id &&
                            (["pending", "running", "paused"].includes(s.status) || meta?.executionCancelled)
                              ? (checked) => toggleWorkerSelection(s.intent_id!, checked)
                              : undefined
                          }
                          executionCancelled={meta?.executionCancelled}
                          onDelete={
                            !s.inherited && s.intent_id && (s.status === "pending" || meta?.executionCancelled)
                              ? () => setDeleteWorkers([{ ...s, title: meta?.title ?? s.title }])
                              : undefined
                          }
                          onResume={() => void controlWorker(s, "resume")}
                          onCancel={() => {
                            setCancelIntent(s);
                          }}
                        />
                      );
                    })}
                    {role === "worker" && intentsHasMore && (
                      <button
                        type="button"
                        onClick={loadOlderIntents}
                        disabled={loadingOlderIntents}
                        className="mt-0.5 flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50"
                      >
                        {loadingOlderIntents ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCwIcon className="size-3.5" />
                        )}
                        加载更早的 Worker
                      </button>
                    )}
                  </div>
                );
              })}
              <RelatedSessions taskId={taskId} onSelect={row=>{setRelatedSession(row);onProcessOpenChange(true);}}/>
              {mainLoaded && !workerSessions.length && (
                <div className="px-2 py-1 text-xs text-muted-foreground">暂无运行中的 Worker 会话。</div>
              )}
            </div>
          </ScrollArea>
        </div>


  );
  const processDetail=(

          <div className="flex h-full min-h-0 flex-1 min-w-0 flex-col overflow-hidden bg-card">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 sm:px-4 sm:py-2.5">
              {(() => {
                const isWorker = active.role === "worker";
                const meta = isWorker ? sessionMeta.get(active.id) : undefined;
                // Worker: the intent moved into the transcript as a message, so the
                // header shows a stable generic label (intent JSON stays on hover).
                const title = isWorker ? "Worker 执行会话" : active.title;
                const titleEl = <span className="min-w-0 truncate text-sm font-medium">{title}</span>;
                return meta?.json ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{titleEl}</TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-h-80 max-w-sm overflow-auto p-0">
                      <pre className="p-2 text-[10px] leading-relaxed">{JSON.stringify(meta.json, null, 2)}</pre>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  titleEl
                );
              })()}
              {activeResolution && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="max-w-28 shrink-0 font-normal"
                      aria-label={
                        activeResolution.available ? `当前配置：${resolutionLabel(activeResolution)}` : "模型不可用"
                      }
                    >
                      <span className="truncate">
                        {activeResolution.available ? resolutionLabel(activeResolution) : "模型不可用"}
                      </span>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs [overflow-wrap:anywhere]">
                    {activeResolution.available
                      ? [resolutionLabel(activeResolution), activeResolution.model].filter(Boolean).join(" / ")
                      : activeResolution.reason || "没有可用的 LLM 配置"}
                  </TooltipContent>
                </Tooltip>
              )}
              {activeAssets && activeAssets.length > 0 && <WorkerAssetBadge assets={activeAssets} />}
              {active.inherited && active.source_task_id && (
                <Badge variant="outline">来源任务 #{active.source_task_id} · 只读历史</Badge>
              )}
              {active.live && (
                <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                  <span className="size-1 animate-pulse rounded-full bg-blue-500" />
                  实时
                </span>
              )}
              {activeState?.hasMore && (
                <span className="text-[10px] text-muted-foreground" title="向上滚动加载更早历史">
                  ↑ 更早历史
                </span>
              )}
              <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground max-sm:w-full max-sm:flex-wrap">
                {tokenTotal.any && (
                  <Tooltip>
                    {/* 手机端用短标签（入/缓/出）：长标签会把这一行撑成两行，进一步压缩记录区。 */}
                    <TooltipTrigger asChild>
                      <span className="inline-flex min-w-0 items-center">
                        <TokenMetrics
                          input={tokenTotal.i}
                          cache={tokenTotal.cr}
                          output={tokenTotal.o}
                          labels="short"
                          className="sm:hidden"
                        />
                        <TokenMetrics
                          input={tokenTotal.i}
                          cache={tokenTotal.cr}
                          output={tokenTotal.o}
                          labels="long"
                          className="max-sm:hidden"
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {activeTokens.usage_complete===false?"已记录输入":"输入总量"} {activeTokens.input_tokens.toLocaleString()} · 输出{" "}
                      {activeTokens.output_tokens.toLocaleString()} · 缓存读取{" "}
                      {activeTokens.cache_read_tokens.toLocaleString()} · 缓存写入{" "}
                      {activeTokens.cache_write_tokens.toLocaleString()}
                    </TooltipContent>
                  </Tooltip>
                )}
                {runDuration != null && (
                  <span className="inline-flex items-center gap-1" title="运行时长（首步 → 末步）">
                    <ClockIcon className="size-3" />
                    {fmtDuration(runDuration)}
                  </span>
                )}
                {isMain && <span>可交互</span>}
              </div>
            </div>
            {(() => {
              const dm = active.role === "worker" ? sessionMeta.get(active.id) : undefined;
              if (!dm?.executionCancelled) return null;
              return (
                <div className="flex items-start gap-2 border-b bg-muted/30 px-4 py-2.5 text-xs">
                  <CircleSlashIcon className="mt-0.5 size-3.5 shrink-0 text-violet-400 dark:text-violet-300" />
                  <div className="min-w-0">
                    <span className="font-medium">Worker 已取消执行</span>
                    <span className="text-muted-foreground">
                      （规划者已收到通知，意图与产出保留）
                    </span>
                    {dm.executionCancelReason && (
                      <p className="mt-1 break-words text-foreground">
                        <span className="text-muted-foreground">取消原因：</span>
                        {dm.executionCancelReason}
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
            {/* Force Radix's internal viewport wrapper (display:table, sizes to content)
            to block so wide/unbreakable steps (long commands, code, URLs) can't blow
            out the width and defeat the truncation below — the transcript wraps to
            the panel instead of overflowing horizontally. */}
              {invalidFocus ? (
                <Alert variant="destructive">
                  <AlertDescription>来源定位参数无效，请返回资产页重新打开来源。</AlertDescription>
                  <Button variant="outline" onClick={clearFocus}>
                    返回会话
                  </Button>
                </Alert>
              ) : focused ? (
                <SourceTranscript
                  key={`${taskId}:${focusSession}:${focusSeq}`}
                  taskId={taskId}
                  session={focusSession}
                  anchor={focusSeq}
                  intro={activity.find((step) => step.seq === -1 && step.kind === "intent")}
                  onLatest={() => {
                    setSourceSession(active);
                    setActiveId(active.id);
                    clearFocus();
                    loadSession(activeKey);
                  }}
                />
              ) : (
                <MessageScrollerProvider key={activeKey} autoScroll>
                <MessageScroller><MessageScrollerViewport preserveScrollOnPrepend>
                  <MessageScrollerContent className="gap-2 p-4" ref={contentRef}>
                    {activeState?.loadingMore && (
                      <div className="flex items-center justify-center gap-2 pb-2 text-xs text-muted-foreground">
                        <Loader2Icon className="size-3.5 animate-spin" />
                        加载更早历史…
                      </div>
                    )}
                    {showLoader ? (
                      <div className="flex items-center gap-2 pl-9 text-xs text-muted-foreground">
                        <Loader2Icon className="size-3.5 animate-spin" />
                        加载活动流…
                      </div>
                    ) : activeState?.error ? (
                      <div className="flex items-center gap-2 pl-9 text-xs text-red-500">
                        <CircleXIcon className="size-3.5" />
                        加载失败：{activeState.error}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => loadSession(activeKey)}
                        >
                          重试
                        </Button>
                      </div>
                    ) : activity.length || streaming.some(s=>sessionKeyOf({...s,seq:-1,kind:s.channel,summary:s.text})===activeKey) ? (
                      <Transcript
                        activity={withLiveStreams(activity,streaming.filter(s=>sessionKeyOf({...s,seq:-1,kind:s.channel,summary:s.text})===activeKey))}
                        scrollItems
                        live={active.live}
                        pendingStatus={isMain&&stopping?"stopping":undefined}
                        taskId={taskId}
                        chat={isMain}
                      />
                    ) : (
                      <div className="pl-9 text-xs text-muted-foreground">
                        {isMain ? "还没有对话。在下方给主 Agent 发消息，引导探索方向或介入流程。" : "暂无活动记录。"}
                      </div>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport><MessageScrollerButton /></MessageScroller>
                </MessageScrollerProvider>
              )}
            {active.role === "worker" &&
              !active.inherited &&
              (active.status === "running" || active.status === "paused") ? (
              <div className="flex items-center justify-between gap-3 border-t p-3">
                <span className="text-sm text-muted-foreground" role="status">
                  {workerExiting || pausingIntent === active.intent_id ? "正在暂停 Worker…" : controllingIntent === active.intent_id ? "正在恢复 Worker…" : active.status === "paused" ? "Worker 已暂停" : "Worker 正在执行"}
                </span>
                <Button size="sm" variant="outline"
                  disabled={controllingIntent !== null || workerExiting || (active.status === "paused" && !workerExecutionAllowed)}
                  onClick={() => void controlWorker(active, active.status === "running" ? "pause" : "resume")}
                  aria-label={active.status === "running" ? "暂停当前 Worker" : "恢复当前 Worker"}>
                  {controllingIntent === active.intent_id || workerExiting ? <Spinner data-icon="inline-start" /> : active.status === "running" ? <SquareIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                  {workerExiting || pausingIntent === active.intent_id ? "正在暂停" : active.status === "running" ? "暂停" : "恢复"}
                </Button>
              </div>
            ) : (
              <div className="flex items-center border-t px-4 py-2">
                <TodoPopover
                  seq={latestTodoSeq}
                  fetchDetail={(seq) => api.activityDetail(seq, taskId).then((r) => r.detail ?? "")}
                />
              </div>
            )}
          </div>

  );
  const mainItems=withLiveStreams(mainState?.items??[],streaming.filter(stream=>sessionKeyOf({...stream,seq:-1,kind:stream.channel,summary:stream.text})===mainKey));
  return <TooltipProvider delayDuration={300}>
    <SessionWorkspace open={processOpen} onOpenChange={onProcessOpenChange} showDetail={!isMain||!!relatedSession} onBack={()=>{setRelatedSession(null);clearFocus();setActiveId(mainSessionId(mainSeg));}}
      list={agentList} detail={relatedSession?<RelatedSessionDetail key={relatedSession.id} row={relatedSession}/>:isMain?null:processDetail} main={<MainConversation key={mainKey} taskId={taskId} items={mainItems} live={!!mainBusy} stopping={stopping} loading={mainState?.loading} error={mainState?.error} hasMore={mainState?.hasMore}
        onEarlier={()=>loadEarlier(mainKey,()=>null)} onRetry={()=>loadSession(mainKey)} composer={composer}
        heading={<><span>主 Agent · {mainSeg===currentSeg?'当前会话':`历史会话 ${mainSeg}`}</span><span className="text-xs">{sseLive?'实时连接':'正在重连，已保留内容'}</span></>}
        focused={isMain&&(focused||invalidFocus)?processDetail:undefined}/>} />
        <AlertDialog
          open={deleteWorkers.length > 0}
          onOpenChange={(open) => {
            if (!open && !deletionBusy.current) setDeleteWorkers([]);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除 {deleteWorkers.length} 个 Worker？</AlertDialogTitle>
              <AlertDialogDescription>
                Worker 和执行会话、旁路会话将永久删除，无法恢复。已有漏洞、资产、事实和 Token 计量保留。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="max-h-48 overflow-y-auto text-sm">
              {deleteWorkers.map((worker) => (
                <li key={worker.id} className="break-words">
                  #{worker.intent_id} · {worker.title}
                </li>
              ))}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={controllingIntent !== null}>返回</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={controllingIntent !== null}
                onClick={() => void performWorkerDelete()}
              >
                {controllingIntent ? "删除中…" : "永久删除"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={cancelIntent !== null || batchCancelIds.length > 0}
          onOpenChange={(open) => {
            if (!open) {
              setCancelIntent(null);
              setBatchCancelIds([]);
              setCancelReason("");
            }
          }}
        >
          <AlertDialogContent className="max-w-[min(32rem,calc(100vw-2rem))]">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {batchCancelIds.length
                  ? `取消 ${batchCancelIds.length} 个 Worker 的执行？`
                  : `取消 Worker #${cancelIntent?.intent_id} 的执行？`}
              </AlertDialogTitle>
              <AlertDialogDescription className="break-words whitespace-normal">
                取消后，该 Worker 将停止执行或退出等待队列。Worker、会话和已有产出均保留。 Planner
                会收到通知；你可以随时点击“开启执行”，让该 Worker 重新等待运行。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field className="py-1">
              <FieldLabel htmlFor="cancel-reason">取消原因（可选）</FieldLabel>
              <Textarea
                id="cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="可补充原因，例如：方向判断错误 / 目标已失效 / 与其他意图重复…"
                rows={3}
                autoFocus
              />
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel>返回</AlertDialogCancel>
              <AlertDialogAction
                disabled={(!cancelIntent && !batchCancelIds.length) || controllingIntent !== null}
                onClick={() =>
                  batchCancelIds.length
                    ? void controlWorkerBatch(batchCancelIds, "cancel", cancelReason)
                    : cancelIntent && void controlWorker(cancelIntent, "cancel", cancelReason)
                }
              >
                {controllingIntent ? <Loader2Icon className="animate-spin" /> : <CircleSlashIcon />}
                取消执行
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmNewMain} onOpenChange={(open) => !open && setConfirmNewMain(false)}>
          <AlertDialogContent className="max-w-[min(32rem,calc(100vw-2rem))]">
            <AlertDialogHeader>
              <AlertDialogTitle>开启新会话？</AlertDialogTitle>
              <AlertDialogDescription className="break-words whitespace-normal">
                当前会话会被归档（可随时切回），主 Agent 将以干净的上下文继续。任务的图谱、资产、目标不受影响。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={creatingMain}>取消</AlertDialogCancel>
              <AlertDialogAction disabled={creatingMain} onClick={() => void createMainSession()}>
                {creatingMain ? "开启中…" : "开启新会话"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

  </TooltipProvider>;
}
