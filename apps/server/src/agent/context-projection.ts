/** Prompt projections never replace the graph record; callers retain node refs. */
const short=(v:unknown,n:number)=>{
  if(typeof v!=='string')return undefined;
  let count=0,end=0;for(const char of v){if(count++>=n)break;end+=char.length;}return v.slice(0,end);
};
export function progressSummary(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const p=value as Record<string,unknown>;
  return {phase:short(p.phase,40),summary:short(p.summary,200),blocker:short(p.blocker,160),next_step:short(p.next_step,160),updated_at:short(p.updated_at,64),
    attempted_count:Array.isArray(p.attempted)?p.attempted.length:0};
}
export function resultSummary(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const r=value as Record<string,unknown>;
  const criteria=Array.isArray(r.criteria)?r.criteria as {fact_ids?:number[]}[]:[];
  return {outcome:short(r.outcome,40),summary:short(r.summary,240),remaining:short(r.remaining,160),fact_ids:[...new Set(criteria.flatMap(c=>Array.isArray(c.fact_ids)?c.fact_ids:[]).filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,10)};
}
export function stopSummary(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const s=value as Record<string,unknown>;
  // Full references remain on context_get; current authorization is checked there.
  return {reason:short(s.reason,64),summary:short(s.summary,240),recovery:short(s.recovery,240),
    accepted_result:s.accepted_result===true,recorded_at:short(s.recorded_at,64)};
}

/** Trusted SQL expressions only: trim before transfer, not after loading a whole
 * tool response/result into the server heap. Full fields remain on context_get. */
export const progressProjectionSQL=(p:string)=>`CASE WHEN jsonb_typeof(${p}->'progress')='object' THEN jsonb_build_object(
 'phase',left(${p}->'progress'->>'phase',40),'summary',left(${p}->'progress'->>'summary',200),
 'blocker',left(${p}->'progress'->>'blocker',160),'next_step',left(${p}->'progress'->>'next_step',160),
 'updated_at',left(${p}->'progress'->>'updated_at',64)) END`;
export const stopProjectionSQL=(p:string)=>`CASE WHEN jsonb_typeof(${p}->'execution_stop')='object' THEN jsonb_build_object(
 'reason',left(${p}->'execution_stop'->>'reason',64),'summary',left(${p}->'execution_stop'->>'summary',240),
 'recovery',left(${p}->'execution_stop'->>'recovery',240),'accepted_result',${p}->'execution_stop'->'accepted_result',
 'recorded_at',left(${p}->'execution_stop'->>'recorded_at',64)) END`;
export const resultProjectionSQL=(p:string)=>`CASE WHEN jsonb_typeof(${p}->'execution_result')='object' THEN jsonb_build_object(
 'outcome',left(${p}->'execution_result'->>'outcome',40),'summary',left(${p}->'execution_result'->>'summary',240),
 'remaining',left(${p}->'execution_result'->>'remaining',160),
 'criteria',(SELECT jsonb_agg(jsonb_build_object('fact_ids',(SELECT jsonb_agg(v) FROM (
  SELECT value v FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c->'fact_ids')='array' THEN c->'fact_ids' ELSE '[]'::jsonb END) LIMIT 20) f)))
  FROM (SELECT value c FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${p}->'execution_result'->'criteria')='array' THEN ${p}->'execution_result'->'criteria' ELSE '[]'::jsonb END) LIMIT 10) cs)) END`;
