"use client";
import * as React from "react";
import { Bot } from "lucide-react";
import { api } from "@/lib/api";
import { useConversationActivity } from "@/hooks/use-conversation-activity";
import type { Conversation } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Transcript } from "@/components/transcript";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
export function RelatedSessions({ taskId, onSelect }: { taskId: string; onSelect: (row: Conversation) => void }) {
  const [rows, setRows] = React.useState<Conversation[]>([]);
  React.useEffect(() => {
    let live = true;
    const load = () =>
      api
        .conversations(taskId)
        .then((values) => {
          if (live) setRows(values.filter((v) => String(v.task_id) === taskId));
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [taskId]);
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1 border-t p-2">
      <p className="px-2 py-1 text-xs text-muted-foreground">关联会话 · 报告与历史复测</p>
      {rows.map((row) => (
        <Button key={row.id} variant="ghost" className="h-auto justify-start py-3" onClick={() => onSelect(row)}>
          <Bot />
          <span className="min-w-0 flex-1 truncate text-left">{row.title || row.agent_name || row.agent_key}</span>
          <span className="text-xs text-muted-foreground">{row.read_only ? "历史只读" : row.running ? "运行中" : row.agent_key}</span>
        </Button>
      ))}
    </div>
  );
}
export function RelatedSessionDetail({ row }: { row: Conversation }) {
  const state = useConversationActivity(row.id);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="border-b p-3 text-sm">
        {row.title || row.agent_name} · {row.read_only ? "历史只读" : state.running ? "运行中" : "执行记录"}
      </p>
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport preserveScrollOnPrepend>
            <MessageScrollerContent className="p-4">
              {state.hasMore && (
                <Button variant="ghost" disabled={state.loading} onClick={() => void state.loadEarlier()}>
                  加载更早记录
                </Button>
              )}
              {state.error && (
                <p role="alert" className="text-sm text-destructive">
                  {state.error}
                </p>
              )}
              <Transcript conversationId={row.id}
                activity={state.items}
                live={state.running}
                scrollItems
                fetchDetail={(seq) => api.conversationMsgDetail(row.id, seq)}
              />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
