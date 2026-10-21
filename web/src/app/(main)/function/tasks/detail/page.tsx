"use client";

import * as React from "react";
import { TaskSettings } from "./task-settings";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  PanelRightIcon,
  FolderIcon,
  Settings2Icon,
  ArchiveIcon,
  ArrowLeftIcon,
  CheckIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { LLMProfile, Stats, Task } from "@/lib/types";

import { taskNavigation, taskViewURL } from "@/lib/task-navigation";
import { SessionsTab } from "./_tabs/sessions-tab";

// Secondary tabs (graphs and tables) are not on the session
// startup path. Load their code only when the corresponding tab mounts.
const BroadcastTab = dynamic(() => import("./_tabs/broadcast-tab").then((m) => m.BroadcastTab), {
  loading: TaskDetailLoading,
});
const AssetsTab = dynamic(() => import("./_tabs/assets-tab").then((m) => m.AssetsTab), { loading: TaskDetailLoading });
const CoverageGraphTab = dynamic(() => import("./_tabs/coverage-graph-tab").then((m) => m.CoverageGraphTab), {
  loading: TaskDetailLoading,
});
const FindingsTab = dynamic(() => import("./_tabs/findings-tab").then((m) => m.FindingsTab), {
  loading: TaskDetailLoading,
});
const GraphTab = dynamic(() => import("./_tabs/graph-tab").then((m) => m.GraphTab), { loading: TaskDetailLoading });
const OverviewTab = dynamic(() => import("./_tabs/overview-tab").then((m) => m.OverviewTab), {
  loading: TaskDetailLoading,
});

const FilesTab = dynamic(() => import("./_tabs/files-tab").then((m) => m.FilesTab), { loading: TaskDetailLoading });
const TrafficTab = dynamic(() => import("./_tabs/traffic-tab").then((m) => m.TrafficTab), {
  loading: TaskDetailLoading,
});
const TABS = [
  { value: "sessions", label: "任务" },
  { value: "findings", label: "发现" },
  { value: "graph", label: "探索" },
  { value: "files", label: "文件" },
  { value: "traffic", label: "流量" },
];

function mergeTaskStats(task: Task, stats: Stats | null): Task {
  const active = stats?.active_task;
  if (!active || String(active.id) !== String(task.id)) return task;
  return {
    ...task,
    in_flight: active.in_flight ?? task.in_flight,
    goals_total: active.goals_total ?? task.goals_total,
    goals_met: active.goals_met ?? task.goals_met,
    engine_mode: stats?.engine_mode ?? active.engine_mode,
    paused: active.paused ?? task.paused,
  };
}

function TaskDetailLoading() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <Spinner className="size-6 text-muted-foreground" aria-label="正在加载任务" />
      <p className="text-muted-foreground text-sm">正在加载任务…</p>
    </div>
  );
}

function TaskDetailInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const [task, setTask] = React.useState<Task | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const { view: tab, explore, panel, section } = taskNavigation(searchParams);
  const navigate = (patch: Record<string, string | null>) => {
    const next = taskViewURL(window.location.search, patch);
    // Radix can select on pointer down and focus before React commits the new URL.
    if (window.location.pathname + window.location.search !== next) window.history.pushState(null, "", next);
  };
  const setTab = (value: string) => navigate({ tab: value, panel: null });
  const [visited, setVisited] = React.useState<string[]>(["sessions", tab]);
  React.useEffect(() => setVisited((v) => (v.includes(tab) ? v : [...v, tab])), [tab]);
  const [visitedSections, setVisitedSections] = React.useState<string[]>([section]);
  React.useEffect(() => setVisitedSections((v) => v.includes(section) ? v : [...v, section]), [section]);
  const [processOpen, setProcessOpen] = React.useState(false);
  React.useEffect(() => {
    setProcessOpen(window.matchMedia("(min-width:1280px)").matches);
  }, []);
  const [findingCount, setFindingCount] = React.useState<number | null>(null);
  const [controlling, setControlling] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .taskFindingsPage(id, 1, 1, "desc")
        .then((r) => {
          if (alive) setFindingCount(r.total);
        })
        .catch(() => {
          if (alive) setFindingCount(null);
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [archiving, setArchiving] = React.useState(false);

  React.useEffect(() => {
    api
      .llmProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);


  const taskLoadInFlight = React.useRef<symbol | null>(null);
  const statsLoadInFlight = React.useRef<symbol | null>(null);
  const latestStats = React.useRef<Stats | null>(null);
  const loadTask = React.useCallback(() => {
    if (taskLoadInFlight.current) return;
    const request = Symbol(id);
    taskLoadInFlight.current = request;
    api
      .task(id)
      .then((value) => {
        if (taskLoadInFlight.current !== request) return;
        const merged = mergeTaskStats(value, latestStats.current);
        setTask(merged);
        setPaused(merged.paused ?? false);
        setLoaded(true);
      })
      .catch(() => {
        // Keep the last rendered task state during a transient poll failure.
      })
      .finally(() => {
        if (taskLoadInFlight.current === request) {
          taskLoadInFlight.current = null;
          setLoaded(true);
        }
      });
  }, [id]);
  const loadStats = React.useCallback(() => {
    if (statsLoadInFlight.current) return;
    const request = Symbol(id);
    statsLoadInFlight.current = request;
    api
      .stats(id)
      .then((value) => {
        if (statsLoadInFlight.current !== request) return;
        latestStats.current = value;
        setTask((current) => (current ? mergeTaskStats(current, value) : current));
        if (String(value.active_task?.id) === id && value.active_task?.paused !== undefined)
          setPaused(value.active_task.paused);
      })
      .catch(() => {
        // Keep the last live state during a transient statistics failure.
      })
      .finally(() => {
        if (statsLoadInFlight.current === request) statsLoadInFlight.current = null;
      });
  }, [id]);
  const load = React.useCallback(() => {
    loadTask();
    loadStats();
  }, [loadStats, loadTask]);
  React.useEffect(() => {
    setTask(null);
    setLoaded(false);
    latestStats.current = null;
    load();
    const timer = setInterval(load, 5000);
    return () => {
      clearInterval(timer);
      taskLoadInFlight.current = null;
      statsLoadInFlight.current = null;
    };
  }, [load]);

  async function togglePause() {
    if (task && ["done", "failed", "timeout"].includes(task.status)) return;
    if (controlling) return;
    setControlling(true);
    const next = !paused;
    try {
      await api.controlTask(id, next ? "pause" : "resume");
      load();
      toast.info(next ? "暂停请求已提交，等待执行器确认" : "恢复请求已提交");
    } catch (e) {
      toast.error(`操作失败：${(e as Error).message}`);
    } finally {
      setControlling(false);
    }
  }

  async function archiveTask() {
    if (!task || archiving) return;
    setArchiving(true);
    try {
      await api.archiveTask(task.id);
      toast.success("任务已加入归档队列");
      router.push("/function/tasks");
    } catch (error) {
      toast.error(`归档失败：${(error as Error).message}`);
      setArchiving(false);
    }
  }

  if (!task) {
    if (!loaded) return <TaskDetailLoading />;

    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="text-muted-foreground">任务 {id} 已被删除、归档或不存在</p>
        <Button asChild variant="outline">
          <Link href="/function/tasks">
            <ArrowLeftIcon /> 返回任务列表
          </Link>
        </Button>
      </div>
    );
  }

  const completed = task.status === "done";
  const terminal = ["done", "failed", "timeout"].includes(task.status);
  const archiveLifecycleEligible = terminal || paused || task.status === "paused";
  const canArchive = archiveLifecycleEligible && !task.archive_blocked_by_task_id;
  let archiveDisabledReason = task.queued ? "排队中的任务必须先暂停" : "运行中的任务必须先暂停";
  if (archiveLifecycleEligible && task.archive_blocked_by_task_id) {
    archiveDisabledReason = `任务被未归档任务 #${task.archive_blocked_by_task_id} 直接继承，请先归档依赖任务`;
  }
  const engineMode = paused ? "paused" : (task.engine_mode ?? "idle");
  let controlVariant: "default" | "secondary" | "outline" = "outline";
  let controlIcon = <PauseIcon data-icon="inline-start" />;
  let controlLabel = "暂停";
  if (terminal) {
    controlVariant = "secondary";
    controlIcon = <CheckIcon data-icon="inline-start" />;
    controlLabel = completed ? "已完成" : "已结束";
  } else if (paused) {
    controlVariant = "default";
    controlIcon = <PlayIcon data-icon="inline-start" />;
    controlLabel = "恢复";
  }
  if (task.pause_pending) {
    controlLabel = "等待停止确认";
    controlIcon = <Spinner />;
  }
  const archiveTrigger = (
    <Button
      size="icon-sm"
      variant="ghost"
      disabled={!canArchive || archiving}
      aria-label={canArchive ? "归档任务" : archiveDisabledReason}
    >
      {archiving ? <Spinner /> : <ArchiveIcon />}
    </Button>
  );

  return (
    <div className="task-workspace flex min-w-0 flex-1 flex-col">
      <header className="task-header shrink-0 border-b bg-card px-3 lg:px-5">
        <div className="task-header-title flex min-w-0 items-center gap-2">
          <SidebarTrigger />
          <Link href="/function/tasks" aria-label="返回任务列表" className="shrink-0 text-muted-foreground">
            <FolderIcon className="size-4" />
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={task.name || task.description}>
            {task.name || task.description || `任务 #${id}`}
          </h1>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="task-header-tabs min-w-0 overflow-x-auto">
          <TabsList aria-label="任务导航" className="min-w-max">
            {TABS.map((t) => (
              <TabsTrigger value={t.value} key={t.value}>
                {t.label}
                {t.value === "findings" && findingCount !== null && (
                  <span className="ml-1 rounded-md bg-muted px-1.5 text-xs tabular-nums">{findingCount}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="task-header-actions flex shrink-0 items-center justify-end gap-1">
          <span className="hidden sm:inline-flex">
            <StatusBadge domain={terminal ? "task" : "engine"} value={terminal ? task.status : engineMode} dot />
          </span>
          <Button
            size="sm"
            variant={controlVariant}
            aria-label={controlling ? "等待确认" : controlLabel}
            onClick={togglePause}
            disabled={terminal || controlling || task.pause_pending}
          >
            {controlling ? <Spinner /> : controlIcon}
            <span className="hidden sm:inline">{controlling ? "等待确认" : controlLabel}</span>
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="任务设置" onClick={() => navigate({ panel: "settings" })}>
            <Settings2Icon />
          </Button>
          <Button
            variant={processOpen && tab === "sessions" && section === "chat" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="执行过程"
            aria-expanded={processOpen && tab === "sessions" && section === "chat"}
            onClick={() => {
              navigate({ tab: "sessions", section: "chat", panel: null });
              setProcessOpen(!(processOpen && tab === "sessions" && section === "chat"));
            }}
          >
            <PanelRightIcon />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <section hidden={tab !== "sessions"} className="flex h-full min-h-0 flex-col">
          <Tabs value={section} onValueChange={(value) => navigate({ tab: "sessions", section: value, panel: null })} className="shrink-0 border-b bg-card px-3 lg:px-5">
            <TabsList variant="line" aria-label="任务内容">
              <TabsTrigger value="chat">对话</TabsTrigger>
              <TabsTrigger value="overview">任务详情</TabsTrigger>
              <TabsTrigger value="broadcast">播报</TabsTrigger>
            </TabsList>
          </Tabs>
          <div hidden={section !== "chat"} className="min-h-0 flex-1">
          <SessionsTab
            taskId={id}
            onOpenSettings={()=>navigate({panel:"settings"})}
            workerExecutionAllowed={!task.paused && !task.queued && !task.pause_pending && task.status === "running"}
            processOpen={processOpen && tab === "sessions" && section === "chat"}
            onProcessOpenChange={setProcessOpen}
          />
          </div>
          {visitedSections.includes("overview") && <div hidden={section !== "overview"} className="task-scroll-panel min-h-0 flex-1"><OverviewTab taskId={id} /></div>}
          {visitedSections.includes("broadcast") && <div hidden={section !== "broadcast"} className="task-scroll-panel min-h-0 flex-1"><BroadcastTab taskId={id} /></div>}
        </section>
        {visited.includes("findings") && (
          <section hidden={tab !== "findings"} className="task-scroll-panel task-findings-panel">
            <FindingsTab taskId={id} />
          </section>
        )}
        {visited.includes("graph") && (
          <section hidden={tab !== "graph"} className="task-scroll-panel">
            <Tabs value={explore} onValueChange={(value) => navigate({ tab: "graph", explore: value })}>
              <TabsList variant="line">
                <TabsTrigger value="graph">探索图</TabsTrigger>
                <TabsTrigger value="coverage">资产覆盖图</TabsTrigger>
                <TabsTrigger value="assets">测试资产</TabsTrigger>
              </TabsList>
              <TabsContent value="graph" forceMount hidden={explore !== "graph"}>
                <GraphTab taskId={id} />
              </TabsContent>
              <TabsContent value="coverage" forceMount hidden={explore !== "coverage"}>
                <CoverageGraphTab taskId={id} coverageEnabled={task.coverage_enabled !== false} />
              </TabsContent>
              <TabsContent value="assets" forceMount hidden={explore !== "assets"}>
                <AssetsTab taskId={id} />
              </TabsContent>
            </Tabs>
          </section>
        )}
        {visited.includes("files") && (
          <section hidden={tab !== "files"} className="task-scroll-panel">
            <FilesTab taskId={id} />
          </section>
        )}
        {visited.includes("traffic") && (
          <section hidden={tab !== "traffic"} className="task-network-panel h-full min-h-0">
            <TrafficTab taskId={id} />
          </section>
        )}
      </div>
      {panel === "settings" && <TaskSettings task={task} profiles={profiles} onClose={()=>navigate({tab,panel:null})} onUpdated={load} archive={<>
{canArchive ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>{archiveTrigger}</AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>归档任务 #{task.id}？</AlertDialogTitle>
                          <AlertDialogDescription>
                            任务图谱、关联记录、独占资产与流量、工作文件和 LLM
                            历史将压缩到冷存储。归档完成后可在任务列表的“已归档”页还原。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void archiveTask()}>确认归档</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">{archiveTrigger}</span>
                      </TooltipTrigger>
                      <TooltipContent>{archiveDisabledReason}</TooltipContent>
                    </Tooltip>
                  )}
</>}/>}
    </div>
  );
}

// useSearchParams must sit under a Suspense boundary for static export.
export default function TaskDetailPage() {
  return (
    <React.Suspense fallback={<TaskDetailLoading />}>
      <TaskDetailRoute />
    </React.Suspense>
  );
}

function TaskDetailRoute() {
  const params = useSearchParams();
  return <TaskDetailInner key={params.get("id") ?? ""} />;
}
