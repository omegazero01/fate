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
import {ActivityBody} from '@/components/activity-body';

export function SteeringNotice({step, getDetail, expanded, onExpandedChange, focused, onLocated}: {
  step: Activity;
  getDetail: (seq: number) => Promise<string>;
  expanded: boolean;
  onExpandedChange: (seq: number, open: boolean) => void;
  focused?: boolean;
  onLocated?: (el: HTMLElement) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const body = step.detail;
  const located=React.useCallback(()=>{if(focused&&expanded)requestAnimationFrame(()=>{if(root.current)onLocated?.(root.current);});},[focused,expanded,onLocated]);
  async function copy() {
    try {await navigator.clipboard.writeText(step.detail_truncated||body===undefined?((await getDetail(step.seq))||step.summary):body); toast.success('已复制纠偏全文');}
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
            {expanded&&<div data-search-body><ActivityBody step={step} onReady={located}/></div>}
          </CollapsibleContent>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CollapsibleTrigger asChild><Button size="sm" variant="ghost">{expanded ? <ChevronUp/> : <ChevronDown/>}{expanded ? '收起' : '展开内容'}</Button></CollapsibleTrigger>
            <Button size="icon-sm" variant="ghost" aria-label="复制纠偏全文" onClick={() => void copy()}><CopyIcon/></Button>
            {!Number.isNaN(date.getTime()) && <time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')} suppressHydrationWarning>{date.toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false})}</time>}
          </div>
        </Collapsible>
      </AlertDescription>
    </Alert>
  </div>;
}
