"use client";

import * as React from 'react';
import {CopyIcon, Flag, ChevronDown, ChevronUp} from 'lucide-react';
import {toast} from 'sonner';
import {Alert, AlertTitle, AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Marker, MarkerContent, MarkerIcon} from '@/components/ui/marker';
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from '@/components/ui/collapsible';
import {steeringIntent, steeringSource, steeringStatus} from '@/lib/steering';
import type {Activity} from '@/lib/types';

export function SteeringNotice({step, getDetail, expanded, onExpandedChange, focused, onLocated}: {
  step: Activity;
  getDetail: (seq: number) => Promise<string>;
  expanded: boolean;
  onExpandedChange: (seq: number, open: boolean) => void;
  focused?: boolean;
  onLocated?: (el: HTMLElement) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [detail, setDetail] = React.useState<string>();
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const body = step.detail ?? detail;
  React.useEffect(() => {
    if (!expanded || step.detail !== undefined) return;
    let current = true;
    setFailed(false);
    getDetail(step.seq).then(text => {if (current) setDetail(text || step.summary);})
      .catch(() => {if (current) setFailed(true);});
    return () => {current = false;};
  }, [expanded, step.seq, step.detail, step.summary, getDetail, retry]);
  React.useEffect(() => {
    if (!focused || !expanded || (body === undefined && !failed)) return;
    const frame = requestAnimationFrame(() => {if (root.current) onLocated?.(root.current);});
    return () => cancelAnimationFrame(frame);
  }, [focused, expanded, body, failed, onLocated]);
  async function copy() {
    try {await navigator.clipboard.writeText(body ?? ((await getDetail(step.seq)) || step.summary)); toast.success('已复制纠偏全文');}
    catch {toast.error('复制失败，请重试');}
  }
  const intent = steeringIntent(step), date = new Date(step.ts);
  return <div ref={root} data-activity-id={step.seq} data-steering-id={step.metadata?.steering?.id ?? `legacy:${step.seq}`} data-search-activity={step.seq} className="my-2 min-w-0">
    <Alert variant="notice" role="note" aria-label={`${steeringSource(step)} 纠偏提醒`}>
      <AlertTitle>
        <Marker className="flex-wrap">
          <MarkerIcon><Flag/></MarkerIcon>
          <MarkerContent className="flex-1 basis-40"><strong>{steeringSource(step)} 纠偏</strong> · <code>steer_work</code> → Worker{intent ? ` · 意图 #${intent}` : ''}</MarkerContent>
          <Badge variant="outline">{steeringStatus(step)}</Badge>
          {step.inherited && <Badge variant="secondary">来源任务 · 只读</Badge>}
        </Marker>
      </AlertTitle>
      <AlertDescription className="min-w-0">
        <Collapsible open={expanded} onOpenChange={open => onExpandedChange(step.seq, open)}>
          {!expanded && <p data-steering-preview className="line-clamp-3 whitespace-pre-wrap break-words">{body ?? step.summary}</p>}
          <CollapsibleContent>
            <div data-search-body className="whitespace-pre-wrap break-words">{body ?? step.summary}</div>
            {body === undefined && (failed ? <Button size="sm" variant="outline" onClick={() => setRetry(n => n + 1)}>全文加载失败，重试</Button> : <span>正在加载全文…</span>)}
          </CollapsibleContent>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CollapsibleTrigger asChild><Button size="sm" variant="ghost">{expanded ? <ChevronUp/> : <ChevronDown/>}{expanded ? '收起' : '展开全文'}</Button></CollapsibleTrigger>
            <Button size="icon-sm" variant="ghost" aria-label="复制纠偏全文" onClick={() => void copy()}><CopyIcon/></Button>
            {!Number.isNaN(date.getTime()) && <time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')} suppressHydrationWarning>{date.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false})}</time>}
          </div>
        </Collapsible>
      </AlertDescription>
    </Alert>
  </div>;
}
