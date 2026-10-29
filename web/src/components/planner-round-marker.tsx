"use client";
import * as React from 'react';
import {Marker,MarkerContent} from '@/components/ui/marker';
import type {plannerRoundView} from '@/lib/planner-round';

export function PlannerRoundMarker({round,focusActivity,onLocated}:{
  round:NonNullable<ReturnType<typeof plannerRoundView>>;
  focusActivity?:number;onLocated?:(el:HTMLElement)=>void;
}){
  const root=React.useRef<HTMLDivElement>(null);
  const focused=focusActivity!=null&&round.boundaryIDs.includes(focusActivity);
  React.useEffect(()=>{
    if(!focused)return;
    const frame=requestAnimationFrame(()=>{if(root.current)onLocated?.(root.current);});
    return ()=>cancelAnimationFrame(frame);
  },[focused,focusActivity,onLocated]);
  return <div ref={root} className="my-4 w-full min-w-0" data-planner-round={round.number??'historical'} data-search-activity={focused?focusActivity:round.boundaryIDs[0]}>
    <Marker variant="separator" role="separator" aria-label={`${round.label} · ${round.title}`}>
      <MarkerContent className="max-w-[85%]"><span className="whitespace-nowrap font-medium">{round.label}</span><span aria-hidden="true"> · </span><span>{round.title}</span></MarkerContent>
    </Marker>
  </div>;
}
