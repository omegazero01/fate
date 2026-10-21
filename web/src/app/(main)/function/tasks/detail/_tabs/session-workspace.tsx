"use client";
import * as React from "react";
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Transcript } from "@/components/transcript";
import { WorkspaceEmpty, WorkspaceError } from "@/components/workspace";
import type { Activity } from "@/lib/types";

export function MainConversation({
  taskId,
  items,
  live,
  stopping,
  error,
  loading,
  hasMore,
  onEarlier,
  onRetry,
  composer,
  heading,
  focused,
}: {
  taskId: string;
  items: Activity[];
  live: boolean;
  stopping: boolean;
  error?: string;
  loading?: boolean;
  hasMore?: boolean;
  onEarlier: () => void;
  onRetry: () => void;
  composer: React.ReactNode;
  heading: React.ReactNode;
  focused?: React.ReactNode;
}) {
  return (
    <section aria-label="主 Agent 对话" className="task-main-conversation flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 px-6 py-2 text-sm text-muted-foreground">
        {heading}
      </div>
      {focused || (
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport preserveScrollOnPrepend>
              <MessageScrollerContent>
                {hasMore && (
                  <Button variant="ghost" size="sm" disabled={loading} onClick={onEarlier}>
                    加载更早对话
                  </Button>
                )}
                {error ? (
                  <WorkspaceError error={error} onRetry={onRetry} />
                ) : !items.length ? (
                  <WorkspaceEmpty
                    title={loading ? "正在同步对话…" : "开始任务对话"}
                    description="向主 Agent 提问或调整任务；执行过程可在右侧查看。"
                  />
                ) : (
                  <Transcript
                    activity={items}
                    scrollItems
                    live={live}
                    taskId={taskId}
                    chat
                    pendingStatus={stopping ? "stopping" : undefined}
                  />
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
      {composer}
    </section>
  );
}
export function SessionWorkspace({
  main,
  list,
  detail,
  open,
  onOpenChange,
  onBack,
  showDetail,
}: {
  main: React.ReactNode;
  list: React.ReactNode;
  detail: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
  showDetail: boolean;
}) {
  const [wide, setWide] = React.useState(false),
    [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia("(min-width:1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const panel = (
    <div className="task-process">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        {showDetail && (
          <Button variant="ghost" size="icon-sm" aria-label="返回 Agent 列表" onClick={onBack}>
            <ArrowLeft />
          </Button>
        )}
        <span className="flex-1 text-sm font-medium">执行过程</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={expanded ? "缩小执行过程" : "放大执行过程"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="关闭执行过程" onClick={() => onOpenChange(false)}>
          <X />
        </Button>
      </div>
      <div hidden={showDetail} className="min-h-0 flex-1 overflow-hidden">
        {list}
      </div>
      <div hidden={!showDetail} className="min-h-0 flex-1 overflow-hidden">
        {detail}
      </div>
    </div>
  );
  return (
    <div className="h-full min-h-0 min-w-0">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="main" minSize="320px">
          {main}
        </ResizablePanel>
        {wide && open && !expanded && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="process" defaultSize="360px" minSize="300px" maxSize="65%">
              {panel}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <Sheet open={open && (!wide || expanded)} onOpenChange={onOpenChange}>
        <SheetContent
          className={expanded ? "w-full p-0 sm:max-w-5xl" : "w-full p-0 sm:max-w-xl"}
          showCloseButton={false}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>执行过程</SheetTitle>
            <SheetDescription>查看 Agent 列表和完整执行记录</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
