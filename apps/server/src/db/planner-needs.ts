import {sessionHostStore,type HostSnapshot} from './session-host-store.js';
import type {Database} from './index.js';
import type {PlannerHistorySnapshot} from './planner-history.js';
import type {ContextNeed} from '../agent/context-needs.js';
import {assertPlannerHostState,plannerNeedKey} from './planner-host-state.js';
import {TASK_GRAPH_CTE} from './graph_view.js';
import {createHash} from 'node:crypto';
import {boundedContextPage} from '../tools/context-pages.js';
type Position={priority:number;ref:string;key:string};
const position=(n:ContextNeed):Position=>({priority:n.priority,ref:n.ref,key:plannerNeedKey(n)});
const compare=(a:Position,b:Position)=>b.priority-a.priority||(a.ref<b.ref?-1:a.ref>b.ref?1:a.key<b.key?-1:a.key>b.key?1:0);

/** Every historical gap remains reachable, but only one page enters the host.
 * Fingerprints cover the current eligible metadata, so reads/edits/revocations
 * invalidate continuation while the pagination query itself does not. */
export async function pagePlannerNeeds(db:Database,s:HostSnapshot,current:ContextNeed[],limit:number,cursor?:string,intentID?:number){
 await assertPlannerHostState(db,s);
 const {table,column,key,entries}=sessionHostStore(s);
 let after:Position|undefined,previous:string|undefined;
 if(cursor){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString());
  if(c.version!==2||typeof c.fingerprint!=='string'||!Number.isSafeInteger(c.after?.priority)||typeof c.after.ref!=='string'||typeof c.after.key!=='string')throw new Error();
  after=c.after;previous=c.fingerprint;
 }catch{throw new Error('无效上下文清单游标，请重新获取清单');}}
 const local=[...new Map(current.map(n=>[plannerNeedKey(n),n])).values()];
 const result=await db.transaction(async tx=>{
  await tx.query('SET LOCAL jit=off');
  return (await tx.query(`WITH ${TASK_GRAPH_CTE}, eligible AS MATERIALIZED (
   SELECT DISTINCT ON(h.need_key) h.need_key,h.need_hash,h.need_priority,h.subject_ref,h.namespace,h.key
    FROM ${table} h WHERE h.${column}=$2 AND h.need_data IS NOT NULL AND NOT(h.need_key=ANY($8::text[])) AND (
     (h.subject_ref LIKE 'node:%' AND EXISTS(SELECT 1 FROM visible n WHERE n.id=CASE WHEN h.subject_ref ~ '^node:[1-9][0-9]*$' THEN substring(h.subject_ref FROM 6)::bigint END AND n.content_version=h.content_version)) OR
     (h.subject_ref LIKE 'session:%' AND EXISTS(SELECT 1 FROM ${entries} e WHERE e.${column}=$2 AND e.entry_id=substring(h.subject_ref FROM 9) AND e.ordinal<$3)) OR
     (h.subject_ref NOT LIKE 'node:%' AND h.subject_ref NOT LIKE 'session:%')
    ) ORDER BY h.need_key,h.ordinal DESC
  ), page AS (SELECT * FROM eligible WHERE $4::int IS NULL OR need_priority<$4 OR
     (need_priority=$4 AND (subject_ref COLLATE "C">$5 COLLATE "C" OR (subject_ref=$5 AND need_key>$6)))
    ORDER BY need_priority DESC,subject_ref COLLATE "C",need_key LIMIT $7)
  SELECT (SELECT count(*) FROM eligible) total,
   (SELECT md5(COALESCE(string_agg(need_hash,'' ORDER BY need_key),'')) FROM eligible) fingerprint,
   COALESCE((SELECT jsonb_agg(h.need_data ORDER BY p.need_priority DESC,p.subject_ref COLLATE "C",p.need_key)
    FROM page p JOIN ${table} h ON h.${column}=$2 AND h.namespace=p.namespace AND h.key=p.key),'[]'::jsonb) records`,
   [s.taskID,key,s.count,after?.priority??null,after?.ref??null,after?.key??null,limit+1,local.map(plannerNeedKey)])).rows[0]!;
 });
 const fingerprint=createHash('sha256').update(JSON.stringify([s.taskID,key,s.generation,intentID,result.fingerprint,local])).digest('hex');
 if(previous&&previous!==fingerprint)throw new Error('上下文状态已变化，请重新获取清单，不沿用旧版本续页');
 const remote=(result.records as string[]).map(v=>JSON.parse(v) as ContextNeed);
 const candidates=[...local.filter(n=>!after||compare(position(n),after)>0),...remote].sort((a,b)=>compare(position(a),position(b)));
 const items=boundedContextPage(candidates.slice(0,limit)),more=candidates.length>items.length;
 return {items,total:local.length+Number(result.total),next_cursor:more&&items.length?Buffer.from(JSON.stringify({version:2,fingerprint,after:position(items.at(-1)!)})).toString('base64url'):null};
}
