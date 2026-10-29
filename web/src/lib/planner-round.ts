import type {Activity} from './types';
import type {TurnSummary} from './turn-summary';

export function isPlannerBoundary(a:Activity){
  return a.worker==='planner'&&(a.kind==='round'||['planner_round_start','planner_round_title'].includes(a.metadata?.event_type??''));
}

/** Pagination never determines the number. Unknown historical boundaries stay unknown. */
export function plannerRoundView(steps:Activity[],summary?:TurnSummary,live=false,ended=false){
  const role=summary?.role??steps.find(a=>a.metadata?.event_type==='turn_start')?.metadata?.role;
  if(role&&role!=='planner'||!steps.some(a=>a.worker==='planner')||steps.every(a=>a.metadata?.event_type==='steering'))return null;
  // Old Goals events were occasionally stored in the planner lane.
  if(!role&&steps.some(a=>a.kind==='round'&&/目标拆解/.test(a.summary)))return null;
  const events=steps.filter(isPlannerBoundary);
  const last=events.at(-1);
  const display=last?.metadata?.planner_round&&(!summary||last.seq>summary.revision)?last.metadata.planner_round:
    summary?.planner_round??last?.metadata?.planner_round;
  const legacy=events.find(a=>a.kind==='round'&&/^第\s*[1-9][0-9]*\s*轮规划(?:\s|$|[·：:—-])/.test(a.summary));
  const n=display?.number??(legacy?Number(/^第\s*([0-9]+)/.exec(legacy.summary)?.[1]):undefined);
  const number=n!=null&&Number.isSafeInteger(n)&&n>0?n:null;
  const hasTitleEvent=events.some(a=>a.metadata?.event_type==='planner_round_title');
  const analysing=!ended&&!hasTitleEvent&&(live||events.some(a=>a.metadata?.event_type==='planner_round_start'));
  return {number,title:display?.title?.trim()||(analysing?'正在分析':'方向未记录'),
    label:number?`第 ${number} 轮规划`:'历史规划',boundaryIDs:events.map(a=>a.seq)};
}
