"use client";

import * as React from "react";
import { ArrowUp, Bot, Loader2, Paperclip, Pin, PinOff, Plus, Square, Trash2, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Transcript } from "@/components/transcript";
import { useConversationActivity } from "@/hooks/use-conversation-activity";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerButton } from "@/components/ui/message-scroller";
import { api } from "@/lib/api";
import type { Activity, Agent, ChatAttachment, Conversation } from "@/lib/types";

const CHAT_ROLES = new Set(["auto", "pentest", "reporter"]);

export default function ChatPage() {
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [listOpen,setListOpen]=React.useState(false);
  const [selected, setSelected] = React.useState<number | null>(null);
  const selectedRef=React.useRef(selected);selectedRef.current=selected;
  const conversation=useConversationActivity(selected);
  const messages=conversation.items;
  const running=conversation.running;
  const [agentKey, setAgentKey] = React.useState("auto");
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState("");


  const refreshConversations = React.useCallback(async () => {
    const rows = await api.conversations();
    setConversations(rows);
    setSelected(current => current && rows.some(row => row.id === current) ? current : rows[0]?.id ?? null);
  }, []);

  React.useEffect(() => {
    let alive = true;
    Promise.all([api.agents(), api.conversations()]).then(([agentRows, rows]) => {
      if (!alive) return;
      const available = agentRows.filter(agent => agent.enabled && (CHAT_ROLES.has(agent.key) || (!agent.builtin && agent.role === "assistant")));
      setAgents(available);
      if (available.length) setAgentKey(available[0]!.key);
      setConversations(rows);
      setSelected(rows[0]?.id ?? null);
    }).catch(err => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => { alive = false; };
  }, []);

  async function createConversation() {
    setError("");
    try {
      const row = await api.createConversation(agentKey, "新对话");
      await refreshConversations();
      setSelected(row.id);
      setAttachments([]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function pickFiles(files: FileList | null) {
    if (conversations.find(c=>c.id===selected)?.read_only || !selected || !files?.length) return;
    setError(""); setSending(true);
    const uploadConversation=selected;
    try {
      const result = await api.chatUpload("session", String(uploadConversation), Array.from(files));
      if(selectedRef.current===uploadConversation)setAttachments(current => [...current, ...result.attachments]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  }

  async function send() {
    if (conversations.find(c=>c.id===selected)?.read_only || !selected || (!text.trim() && !attachments.length) || sending || running) return;
    setSending(true); setError("");
    const sentText=text,sentAttachments=attachments,requestID=crypto.randomUUID(),conversationID=selected;
    conversation.add({seq:-Date.now(),worker:"user",kind:"user",summary:sentText,detail:sentText,ts:new Date().toISOString(),turn_id:requestID,metadata:{turn_id:requestID,attachments:sentAttachments}});
    setText("");setAttachments([]);
    conversation.setStatus("queued");
    try {
      await api.sendConversationMessage(conversationID, sentText, sentAttachments,requestID);
      await refreshConversations();
    } catch (err) {
      try {const history=await api.conversationHistory(conversationID);conversation.reconcile(history.items);
        if(selectedRef.current!==conversationID)return;
        if(!history.items.some(a=>(a.turn_id??a.metadata?.turn_id)===requestID)){conversation.removePending(requestID);conversation.setStatus("idle");setText(sentText);setAttachments(sentAttachments);setError((err as Error).message);}
      } catch {setError("发送状态待确认，恢复连接后核对记录，请勿重复发送");}
    } finally {setSending(false);}
  }

  async function stop() {
    if (!selected) return;
    conversation.setStatus("stopping");
    try {const result=await api.stopRetestConversation(selected);conversation.setStatus(result.status);await refreshConversations();}
    catch(err){setError((err as Error).message);}
  }

  async function togglePin(row: Conversation) {
    try { await api.pinConversation(row.id, !(row.pinned ?? Boolean(row.pinned_at))); await refreshConversations(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function remove(row: Conversation) {
    try { await api.deleteConversation(row.id); await refreshConversations(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const current = conversations.find(row => row.id === selected);
  const currentAgent = agents.find(agent => agent.key === (current?.agent_key ?? agentKey));

  return (
    <main className="relative flex h-[calc(100dvh-9rem)] min-h-96 overflow-hidden rounded-xl border bg-card">
      <aside className={`${listOpen?"flex":"hidden"} absolute inset-y-0 left-0 z-10 w-72 shrink-0 flex-col border-r bg-card md:static md:flex`}>
        <div className="flex items-center gap-2 border-b p-3"><Button variant="ghost" size="sm" className="md:hidden" onClick={()=>setListOpen(false)}>返回</Button>
          <select className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={agentKey} onChange={e => setAgentKey(e.target.value)} aria-label="选择 Agent">
            {agents.map(agent => <option key={agent.key} value={agent.key}>{agent.name}</option>)}
          </select>
          <Button size="icon" variant="outline" onClick={() => void createConversation()} title="新建对话" aria-label="新建对话"><Plus className="size-4" /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.map(row => {
            const name = agents.find(agent => agent.key === row.agent_key)?.name ?? row.agent_name ?? row.agent_key;
            return <div key={row.id} className={`group mb-1 flex items-center rounded-lg ${selected === row.id ? "bg-accent" : "hover:bg-muted"}`}>
              <button type="button" onClick={() => {setSelected(row.id);setListOpen(false);}} className="min-w-0 flex-1 px-3 py-2 text-left">
                <span className="block truncate text-sm font-medium">{row.title || "新对话"}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{name}{(selected===row.id?running:row.running) ? " · 运行中" : ""}{row.task_id ? ` · 任务 #${row.task_id}` : ""}</span>
              </button>
              <>{!row.read_only && <><Button size="icon" variant="ghost" className="size-8 opacity-70" onClick={() => void togglePin(row)} title={row.pinned ? "取消置顶" : "置顶"}>{row.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</Button>
              <Button size="icon" variant="ghost" className="size-8 opacity-70" onClick={() => void remove(row)} title="删除对话"><Trash2 className="size-3.5" /></Button></>}</>
            </div>;
          })}
          {!conversations.length && <p className="px-3 py-8 text-center text-sm text-muted-foreground">新建一个 Agent 对话开始使用。</p>}
        </div>
      </aside>

      <section className="task-main-conversation flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-5"><Button className="md:hidden" variant="ghost" size="icon-sm" aria-label="切换会话列表" onClick={()=>setListOpen(v=>!v)}><Menu/></Button>
          <div className="flex min-w-0 items-center gap-2"><Bot className="size-4 text-primary" /><span className="truncate font-medium">{current?.title || "新对话"}</span><span className="text-xs text-muted-foreground">{currentAgent?.name ?? current?.agent_key ?? "选择 Agent"}</span></div>
          {running && <span className="flex items-center gap-2 text-xs text-blue-600"><span className="size-2 animate-pulse rounded-full bg-blue-500" />正在运行</span>}
        </header>

        <MessageScrollerProvider key={selected} autoScroll><MessageScroller><MessageScrollerViewport preserveScrollOnPrepend>
          <MessageScrollerContent className="gap-3 p-5">
            {conversation.hasMore&&<Button variant="ghost" disabled={conversation.loading} onClick={event=>void conversation.loadEarlier(event.currentTarget.closest<HTMLElement>('[data-slot="message-scroller-viewport"]'))}>加载更早消息</Button>}
            <Transcript conversationId={selected??undefined} activity={messages} live={running} pendingStatus={conversation.status==="stopping"?"stopping":undefined} chat scrollItems fetchDetail={seq=>api.conversationMsgDetail(selected!,seq)}/>
            {!messages.length&&<p className="text-sm text-muted-foreground">{conversation.loading?"正在加载对话…":"选择或新建一个对话。"}</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider>
        {selected&&!conversation.connected&&!conversation.loading&&<div role="status" className="px-4 py-1 text-xs text-muted-foreground">实时连接恢复中，已有内容已保留</div>}
        {(error||conversation.error)&&<div role="alert" className="border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">{error||conversation.error}</div>}
        {current?.read_only ? <p role="status" className="border-t p-4 text-sm text-muted-foreground">此为历史复测会话，Retester 已移除，仅供读取。</p> : <div className="task-composer">
          {!!attachments.length && <div className="mb-2 flex flex-wrap gap-2">{attachments.map(file => <span key={file.path} className="flex items-center gap-2 rounded-md border bg-muted px-2 py-1 text-xs">{file.name} · {Math.ceil(file.size / 1024)} KB<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments(rows => rows.filter(a => a.path !== file.path))}>×</button></span>)}</div>}
          <div className="flex items-end gap-2 rounded-[var(--composer-radius)] border bg-card p-3">
            <label className="inline-flex size-10 cursor-pointer items-center justify-center rounded-md border hover:bg-muted" title="上传附件">
              <Paperclip className="size-4" />
              <input className="hidden" type="file" multiple disabled={!selected || sending} onChange={e => { void pickFiles(e.target.files); e.currentTarget.value = ""; }} />
            </label>
            <Textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} disabled={!selected || sending} placeholder={selected ? "输入消息，Enter 发送，Shift+Enter 换行" : "先新建或选择对话"} className="max-h-40 min-h-10 resize-y" />
            {running ? <Button size="icon" variant="destructive" onClick={() => void stop()} title="停止生成"><Square className="size-4" /></Button> : <Button size="icon" onClick={() => void send()} disabled={!selected || sending || (!text.trim() && !attachments.length)} title="发送">{sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button>}
          </div>
        </div>}
      </section>
    </main>
  );
}
