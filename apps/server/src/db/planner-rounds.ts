import type {Database} from './index.js';
export type PlannerRoundDisplay = {number:number;title:string|null};

// Only the old host's explicit boundary is reliable; prose and page order are not.
export function legacyPlannerNumber(row:{worker?:unknown;kind?:unknown;summary?:unknown}):number|null {
  if(row.worker!=='planner'||row.kind!=='round')return null;
  const match=/^第\s*([1-9][0-9]*)\s*轮规划(?:\s|$|[·：:—-])/.exec(String(row.summary??''));
  const n=match?Number(match[1]):NaN;
  return Number.isSafeInteger(n)&&n>0?n:null;
}

export async function beginPlannerDisplayRound(db:Database,expID:number,turnID:string):Promise<PlannerRoundDisplay>{
  return db.transaction(async tx=>{
    // Same lock/order as appendActivity, serializing allocation and its marker.
    await tx.query('SELECT pg_advisory_xact_lock($1)',[-expID]);
    const existing=(await tx.query('SELECT number,title FROM planner_display_rounds WHERE exploration_id=$1 AND turn_id=$2',[expID,turnID])).rows[0];
    if(existing)return {number:Number(existing.number),title:existing.title as string|null};
    let last=Number((await tx.query('SELECT max(number) AS number FROM planner_display_rounds WHERE exploration_id=$1',[expID])).rows[0]?.number??0);
    if(!last){
      const old=(await tx.query("SELECT worker,kind,left(summary,120) AS summary FROM activity WHERE exploration_id=$1 AND worker='planner' AND kind='round'",[expID])).rows;
      for(const row of old)last=Math.max(last,legacyPlannerNumber(row)??0);
    }
    const display={number:last+1,title:null};
    await tx.query('INSERT INTO planner_display_rounds(exploration_id,turn_id,number) VALUES($1,$2,$3)',[expID,turnID,display.number]);
    await tx.exploration(expID).appendActivity({worker:'planner',kind:'round',summary:`第 ${display.number} 轮规划`,metadata:{turn_id:turnID,event_type:'planner_round_start',planner_round:display}});
    return display;
  });
}

export async function finishPlannerDisplayRound(db:Database,expID:number,turnID:string,title:string|null):Promise<void>{
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock($1)',[-expID]);
    const row=(await tx.query('UPDATE planner_display_rounds SET title=$3,finished_at=now() WHERE exploration_id=$1 AND turn_id=$2 AND finished_at IS NULL RETURNING number,title',[expID,turnID,title])).rows[0];
    if(!row)return; // Recovery/replayed completion never adds another header update.
    await tx.exploration(expID).appendActivity({worker:'planner',kind:'status',summary:'',metadata:{turn_id:turnID,event_type:'planner_round_title',planner_round:{number:Number(row.number),title:row.title}}});
  });
}

export function projectPlannerDisplay(rows:Array<Record<string,any>>):PlannerRoundDisplay|undefined{
  const start=rows.find(r=>r.metadata?.event_type==='turn_start');
  if(start?.metadata.role&&start.metadata.role!=='planner')return;
  if(!rows.some(r=>r.worker==='planner'))return;
  const metadata=rows.findLast(r=>['planner_round_start','planner_round_title'].includes(r.metadata?.event_type))?.metadata.planner_round;
  if(metadata&&Number.isSafeInteger(metadata.number)&&metadata.number>0)return {number:metadata.number,title:metadata.title??null};
  const old=rows.map(legacyPlannerNumber).find(n=>n!==null);
  if(old)return {number:old,title:null};
}
