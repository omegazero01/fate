import type { ToolRunContext } from './context.js';
import type { IntentResult } from '../agent/intent-contract.js';

/** Read-only validation for results committed by older versions. */
export async function validateResultEvidence(c: Pick<ToolRunContext,'db'|'expID'>, intentID:number, result:IntentResult) {
  const versions:{node_id:number;version:number}[]=[];
  for(const id of new Set(result.criteria.flatMap(v=>v.fact_ids))){
    const row=(await c.db.query(`SELECT n.payload,n.kind,n.content_version FROM exploration_nodes n
      JOIN exploration_edges e ON e.dst_id=n.id AND e.src_id=$3 AND e.rel='yields' AND e.exploration_id=n.exploration_id
      WHERE n.exploration_id=$1 AND n.id=$2 AND n.kind IN ('fact','finding') AND n.state='confirmed' AND exploration_node_readable($1,n.id)`,[c.expID,id,intentID])).rows[0];
    if(!row)throw new Error(`证据 #${id} 不属于本意图或不再可读`);
    const payload=row.payload as Record<string,unknown>;
    const evidence=row.kind==='finding'?(await c.db.query('SELECT evidence FROM findings WHERE node_id=$1',[id])).rows[0]?.evidence:payload.evidence;
    if(typeof evidence!=='string'||!evidence.trim())throw new Error(`证据 #${id} 缺少实际观察内容`);
    versions.push({node_id:id,version:Number(row.content_version)});
  }
  return versions;
}
