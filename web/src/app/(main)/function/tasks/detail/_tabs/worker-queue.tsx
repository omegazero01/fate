"use client";

import * as React from "react";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ClockIcon, GripVerticalIcon, ListOrderedIcon } from "lucide-react";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import type { TaskNode } from "@/lib/types";
import { cn } from "@/lib/utils";

function isDispatched(node: TaskNode) {
  try {
    return JSON.parse(node.payload ?? "{}").dispatch_requested === true;
  } catch {
    return false;
  }
}
type Queue = Awaited<ReturnType<typeof api.workerQueue>>;
function titleOf(node: TaskNode) {
  try {
    return String(JSON.parse(node.payload ?? "{}").summary ?? `Worker #${node.id}`).replace(
      /\s*[（(]等待运行[）)]\s*$/,
      "",
    );
  } catch {
    return `Worker #${node.id}`;
  }
}
function QueueRow({
  node,
  index,
  disabled,
  pending,
  managed,
  selected,
  onSelect,
  onDispatch,
}: {
  node: TaskNode;
  index: number;
  disabled: boolean;
  pending: boolean;
  managed: boolean;
  selected: boolean;
  onSelect: () => void;
  onDispatch: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn("flex items-center gap-3 rounded-md border bg-card p-3", isDragging && "opacity-50")}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="touch-none shrink-0 cursor-grab"
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={`移动 Worker #${node.id}`}
      >
        <GripVerticalIcon />
      </Button>
      {pending && (
        <Checkbox
          checked={selected}
          disabled={disabled}
          onCheckedChange={onSelect}
          aria-label={`选择意图 #${node.id}`}
        />
      )}
      <span className="text-muted-foreground text-sm tabular-nums">{index + 1}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">#{node.id}</span>
          <span role="img" aria-label="等待运行" title="等待运行" className="inline-flex text-muted-foreground">
            <ClockIcon className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <p className="break-words text-sm">{titleOf(node)}</p>
        <Badge variant="secondary">{pending ? "待下发" : managed && !isDispatched(node) ? "待 Planner 评估" : "已准入·等待领取"}</Badge>
      </div>
      {pending && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={onDispatch}>
          下发
        </Button>
      )}
    </li>
  );
}
export function WorkerQueue({ taskId, disabled }: { taskId: string; disabled: boolean }) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState(false);
  const [queue, setQueue] = React.useState<Queue | null>(null);
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const busy = React.useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  React.useEffect(() => {
    void revision;
    if (!open || saving || dragging) return;
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api.workerQueue(taskId);
        if (active) {
          setQueue(result);
          setSelected((ids) =>
            ids.filter((id) =>
              result.items.some((n) => n.id === id && result.execution_mode === "manual" && !isDispatched(n)),
            ),
          );
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [taskId, open, saving, dragging, revision]);
  async function dispatch(ids: string[]) {
    if (busy.current || !ids.length) return;
    busy.current = true;
    setSaving(true);
    try {
      const result = await api.dispatchIntents(taskId, ids);
      const failed = result.results.filter((item) => item.status === "rejected");
      if (failed.length) toast.error(failed.map((item) => `#${item.id}: ${item.error}`).join("；"));
      else toast.success("意图已下发，按并发限制等待执行");
      setSelected((current) =>
        current.filter((id) => !ids.includes(id) || failed.some((item) => String(item.id) === id)),
      );
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function move(event: DragEndEvent) {
    setDragging(false);
    if (!queue || busy.current || !event.over || event.active.id === event.over.id) return;
    const from = queue.items.findIndex((n) => n.id === event.active.id);
    const to = queue.items.findIndex((n) => n.id === event.over?.id);
    if (from < 0 || to < 0) return;
    const snapshot = queue;
    const items = arrayMove(queue.items, from, to);
    busy.current = true;
    setSaving(true);
    setQueue({ ...queue, items });
    try {
      setQueue(await api.moveWorker(taskId, String(event.active.id), items[to + 1]?.id ?? null, snapshot.version));
      setError("");
    } catch (e) {
      setQueue(snapshot);
      setError((e as Error).message);
      toast.error("队列已变化或保存失败，请刷新后重试");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (busy.current) return;
        setOpen(value);
        if (!value) {
          setQueue(null);
          setError("");
        }
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled}>
          <ListOrderedIcon data-icon="inline-start" />
          等待队列
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full! sm:max-w-xl!">
        <SheetHeader>
          <SheetTitle>等待队列</SheetTitle>
          <SheetDescription>
            拖动手柄调整执行顺序；键盘按空格拾起，上下箭头移动，空格放下。手动排序后，新建及重新开启的 Worker
            追加队尾。自动模式下，待评估意图须经 Planner 根据最新图谱准入；图中历史意图数量不代表并发数。
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {saving && <p className="text-muted-foreground text-sm">保存中…</p>}
          {error && (
            <div role="alert" className="text-destructive text-sm">
              {error}
              <Button size="sm" variant="outline" onClick={refresh}>
                刷新
              </Button>
            </div>
          )}
          {!queue && !error && <Spinner />}
          {queue && (
            <>
              {queue.scheduling && <div className="flex flex-wrap gap-2" aria-label="Worker 调度状态">
                <Badge variant="outline">本任务执行 {queue.scheduling.task_active} / {queue.scheduling.limit}</Badge>
                <Badge variant="secondary">本任务空闲 {queue.scheduling.available}</Badge>
                <Badge variant="secondary">退出中 {queue.scheduling.exiting}</Badge>
                <Badge variant="secondary">待领取 {queue.scheduling.ready}</Badge>
                <Badge variant="secondary">规划名额 {queue.scheduling.planning}</Badge>
              </div>}
              <p className="text-muted-foreground text-xs">
                {queue.manual ? "按用户顺序" : "按 Planner 优先级"} · {queue.items.length} 个等待项
              </p>
              {queue.execution_mode === "manual" && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    {queue.items.filter((n) => !isDispatched(n)).length} 个待下发 · 已选 {selected.length}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving || disabled || !!error}
                    onClick={() =>
                      setSelected(
                        queue.items
                          .filter((n) => !isDispatched(n))
                          .slice(0, 50)
                          .map((n) => n.id),
                      )
                    }
                  >
                    选择前 50 项
                  </Button>
                  <Button
                    size="sm"
                    disabled={saving || disabled || !!error || !selected.length || selected.length > 50}
                    onClick={() => void dispatch(selected)}
                  >
                    下发选中
                  </Button>
                </div>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={() => setDragging(true)}
                onDragCancel={() => setDragging(false)}
                onDragEnd={(event) => void move(event)}
              >
                <SortableContext items={queue.items.map((n) => n.id)} strategy={verticalListSortingStrategy}>
                  <ol className="flex flex-col gap-2">
                    {queue.items.map((node, index) => (
                      <QueueRow
                        key={node.id}
                        node={node}
                        index={index}
                        disabled={saving || disabled || !!error}
                        managed={queue.execution_mode !== "manual"}
                        pending={queue.execution_mode === "manual" && !isDispatched(node)}
                        selected={selected.includes(node.id)}
                        onSelect={() =>
                          setSelected((ids) =>
                            ids.includes(node.id) ? ids.filter((id) => id !== node.id) : [...ids, node.id],
                          )
                        }
                        onDispatch={() => void dispatch([node.id])}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
              {!queue.items.length && <p className="py-8 text-center text-muted-foreground">暂无等待运行的 Worker</p>}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
