"use client";

import * as React from "react";

import { Transcript } from "@/components/transcript";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { highlightActivity } from "@/lib/activity-highlight";
import { api } from "@/lib/api";
import type { Activity } from "@/lib/types";

const merge = (a: Activity[], b: Activity[]) =>
  [...new Map([...a, ...b].map((x) => [x.seq, x])).values()].sort((a, b) => a.seq - b.seq);

// A separate contiguous history window keeps the normal live-tail cache intact.
// This is the same transcript renderer, with bidirectional history navigation.
export function SourceTranscript({
  taskId,
  session,
  anchor,
  onLatest,
  intro,
  searchQuery = "",
  searchMode = false,
}: {
  taskId: string;
  session: string;
  anchor: number;
  onLatest: () => void;
  intro?: Activity;
  searchQuery?: string;
  searchMode?: boolean;
}) {
  const [page, setPage] = React.useState<Awaited<ReturnType<typeof api.activityHistory>> | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);
  const queryRef = React.useRef(searchQuery);
  queryRef.current = searchQuery;
  const generation = React.useRef(0);
  const highlight = React.useRef<ReturnType<typeof highlightActivity> | null>(null);
  const alive = React.useRef(true);
  const target = React.useRef<HTMLElement | null>(null);
  const userMoved = React.useRef(false);
  const inFlight = React.useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally reloads a failed anchor.
  React.useEffect(() => {
    ++generation.current;
    alive.current = true;
    let current = true;
    setPage(null);
    setError("");
    target.current = null;
    userMoved.current = false;
    api
      .activityHistory(taskId, session, 0, 200, { around: anchor })
      .then((p) => {
        if (current) setPage(p);
      })
      .catch((e) => {
        if (current) setError(String(e.message || e));
      });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [taskId, session, anchor, retry]);
  const locate = React.useCallback(
    (el: HTMLElement, explicit = false) => {
      if (explicit) userMoved.current = false;
      highlight.current?.clear();
      highlight.current = highlightActivity(
        el.querySelector<HTMLElement>(`[data-search-activity="${anchor}"]`) ?? el,
        queryRef.current,
      );
      target.current = el;
      if (userMoved.current) return;
      const vp = root.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
      if (!vp) return;
      if (root.current) {
        root.current.style.paddingTop = `${vp.clientHeight / 2}px`;
        root.current.style.paddingBottom = `${vp.clientHeight / 2}px`;
      }
      const range = highlight.current.ranges[0];
      if (range) {
        const pre = range.startContainer.parentElement?.closest("pre");
        if (pre) {
          pre.scrollTop += range.getBoundingClientRect().top - pre.getBoundingClientRect().top - pre.clientHeight / 2;
          pre.scrollLeft += range.getBoundingClientRect().left - pre.getBoundingClientRect().left - pre.clientWidth / 2;
        }
      }
      const rect = range?.getBoundingClientRect() ?? el.getBoundingClientRect();
      vp.scrollTop +=
        rect.top - vp.getBoundingClientRect().top - (vp.clientHeight - Math.min(rect.height, vp.clientHeight)) / 2;
    },
    [anchor],
  );
  React.useEffect(() => {
    // Closing search clears highlights without moving the current viewport.
    highlight.current?.clear();
    if (target.current && searchQuery) {
      // A new keyword may match a different paragraph in the same message.
      userMoved.current = false;
      locate(target.current);
    }
    return () => highlight.current?.clear();
  }, [searchQuery, locate]);
  React.useEffect(() => {
    const el = root.current;
    const vp = el?.closest('[data-slot="scroll-area-viewport"]');
    if (!el || !vp) return;
    const stop = () => {
      userMoved.current = true;
    };
    const observer = new ResizeObserver(() => {
      if (target.current) locate(target.current);
    });
    observer.observe(el);
    vp.addEventListener("wheel", stop, { passive: true });
    vp.addEventListener("touchstart", stop, { passive: true });
    vp.addEventListener("pointerdown", stop);
    vp.addEventListener("keydown", stop);
    return () => {
      observer.disconnect();
      vp.removeEventListener("wheel", stop);
      vp.removeEventListener("touchstart", stop);
      vp.removeEventListener("pointerdown", stop);
      vp.removeEventListener("keydown", stop);
    };
  }, [locate]);
  async function more(direction: "before" | "after") {
    if (!page || inFlight.current) return;
    const request = generation.current;
    userMoved.current = true;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const vp = root.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    const height = vp?.scrollHeight ?? 0,
      top = vp?.scrollTop ?? 0;
    try {
      const p = await api.activityHistory(
        taskId,
        session,
        direction === "before" ? page.earliestCursor : 0,
        200,
        direction === "after" ? { after: page.latestCursor } : undefined,
      );
      if (!alive.current || request !== generation.current) return;
      setPage(
        (old) =>
          old && {
            ...old,
            items: merge(old.items, p.items),
            ...(direction === "before"
              ? { earliestCursor: p.earliestCursor, hasMore: p.hasMore }
              : { latestCursor: p.latestCursor, hasNewer: p.hasNewer }),
          },
      );
      if (direction === "before")
        requestAnimationFrame(() => {
          if (vp && alive.current) vp.scrollTop = top + vp.scrollHeight - height;
        });
    } catch (e) {
      if (alive.current) setError(String((e as Error).message || e));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  React.useEffect(() => {
    if (!page) return;
    let current = true;
    const timer = setInterval(async () => {
      if (inFlight.current) return;
      const use = page.items.find((a) => a.seq === anchor);
      const waiting =
        use?.kind === "tool_use" &&
        !page.items.some(
          (a) =>
            a.kind === "tool_result" && a.worker === use.worker && a.tool_use_id === use.tool_use_id && a.seq > anchor,
        );
      if (page.hasNewer && !waiting) return;
      inFlight.current = true;
      try {
        // While the result is pending an anchored refresh includes every intervening
        // record; otherwise append only the contiguous next page, never the SSE tail.
        const p = await api.activityHistory(
          taskId,
          session,
          0,
          200,
          waiting ? { around: anchor } : { after: page.latestCursor },
        );
        if (current)
          setPage(
            (old) =>
              old && {
                ...old,
                items: merge(old.items, p.items),
                latestCursor: Math.max(old.latestCursor, p.latestCursor),
                hasNewer: p.latestCursor >= old.latestCursor ? p.hasNewer : old.hasNewer,
              },
          );
      } catch {
        /* The explicit paging/retry controls remain available. */
      } finally {
        inFlight.current = false;
      }
    }, 2000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [page, taskId, session, anchor]);
  return (
    <>
      <style>{"::highlight(activity-search) { background-color: #facc15; color: #171717; }"}</style>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2 text-xs">
        <span>{searchMode ? "正在查看匹配消息及原始会话" : "正在查看来源调用及原始会话"}</span>
        <Button variant="outline" size="sm" onClick={onLatest}>
          返回最新
        </Button>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div ref={root} className="min-w-0 max-w-full p-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
              {!page && (
                <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
                  重试定位
                </Button>
              )}
            </Alert>
          )}
          {!page && !error && <p className="text-muted-foreground text-sm">正在定位来源调用…</p>}
          {page?.hasMore && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void more("before")}>
              加载更早消息
            </Button>
          )}
          {page && (
            <Transcript
              activity={intro && !page.hasMore ? [{ ...intro, detail: intro.summary }, ...page.items] : page.items}
              taskId={taskId}
              chat={session.startsWith("main:")}
              focusActivity={anchor}
              focusLabel={searchMode ? "搜索结果" : "来源调用"}
              onLocated={locate}
            />
          )}
          {page?.hasNewer && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void more("after")}>
              加载后续消息
            </Button>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
