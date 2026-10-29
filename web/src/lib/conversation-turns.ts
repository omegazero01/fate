import {isSteering,steeringTurnID} from './steering';
import type { Activity } from './types';

export type ConversationTurn = { key:string; user:boolean; steps:Activity[] };
export const turnID = (a:Activity) => isSteering(a) ? steeringTurnID(a) : a.turn_id ?? a.metadata?.turn_id;
export const streamKey = (a:Activity) => {
  const id=a.stream_id??a.metadata?.stream_id;
  return id ? `${id}:${a.channel??a.metadata?.channel??(a.kind==='thinking'?'thinking':'text')}` : undefined;
};
export const isLifecycle = (a:Activity) => a.metadata?.event_type==='lifecycle' ||
  (a.kind==='result' && /^(回复完成|回复已停止)$/.test(a.summary) && !a.metadata?.worker_feedback);

/** A host run can contain many pi messages and parallel tools. Never group across lanes. */
export function conversationTurns(items:Activity[]):ConversationTurn[] {
  const turns:ConversationTurn[]=[];
  const explicit=new Map<string,ConversationTurn>();
  const legacy=new Map<string,ConversationTurn>();
  for(const a of items){
    if(a.kind==='usage')continue;
    const lane=`${a.worker==='main'?'mainagent':a.worker}:${a.intent_id??''}:${a.main_seg??0}:${a.source_task_id??''}`;
    if(isSteering(a)&&!turnID(a)){
      turns.push({key:`steering:${a.source_task_id??''}:${a.seq}`,user:false,steps:[a]});continue;
    }
    if(!isSteering(a)&&(a.kind==='user'||a.kind==='intent')){
      turns.push({key:`user:${turnID(a)??a.seq}`,user:true,steps:[a]});legacy.delete(lane);continue;
    }
    if(a.metadata?.worker_feedback || a.worker==='system'){
      turns.push({key:`notice:${a.seq}`,user:false,steps:[a]});continue;
    }
    const id=turnID(a);
    const key=id?`${lane}:${id}`:undefined;
    let turn=key?explicit.get(key):legacy.get(lane);
    if(!turn || (!id && a.kind==='round')){
      turn={key:key??`legacy:${lane}:${a.seq}`,user:false,steps:[]};turns.push(turn);
      if(key)explicit.set(key,turn);
      legacy.set(lane,turn);
    }
    turn.steps.push(a);
    if(a.kind==='result')legacy.delete(lane);
  }
  return turns;
}

export type StreamSnapshot={worker:string;intent_id?:string;main_seg?:number;turn_id:string;stream_id:string;channel:'text'|'thinking';text:string;offset:number;ts:string;active:boolean};
export function withLiveStreams(items:Activity[], streams:StreamSnapshot[]):Activity[]{
  const finalized=new Set(items.map(streamKey).filter(Boolean));
  const live=streams.filter(s=>!finalized.has(`${s.stream_id}:${s.channel}`)).map((s,i):Activity=>({
    seq:-100000-i,worker:s.worker,intent_id:s.intent_id,main_seg:s.main_seg,ts:s.ts,
    turn_id:s.turn_id,stream_id:s.stream_id,channel:s.channel,kind:s.channel,
    summary:s.text,detail:s.text,streaming:s.active,interrupted:!s.active,
  }));
  // Existing durable order is authoritative. A snapshot follows the records that
  // existed when its first fragment was emitted, not the newest final activity.
  const out=[...items];
  for(const item of live){const at=out.findIndex(a=>Date.parse(a.ts)>Date.parse(item.ts));if(at<0)out.push(item);else out.splice(at,0,item);}
  return out;
}

export function mergeConversationActivities(current:Activity[],incoming:Activity[]):Activity[]{
  const confirmed=new Set([...current,...incoming].filter(a=>a.kind==='user'&&!isSteering(a)&&a.seq>0).map(turnID).filter(Boolean));
  const map=new Map<number,Activity>();
  for(const a of current)if(!(a.seq<0&&confirmed.has(turnID(a))))map.set(a.seq,a);
  for(const a of incoming)if(!(a.seq<0&&confirmed.has(turnID(a))))map.set(a.seq,a);
  return [...map.values()].sort((a,b)=>a.seq<0||b.seq<0?Date.parse(a.ts)-Date.parse(b.ts):a.seq-b.seq);
}
