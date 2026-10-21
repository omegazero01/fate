import {createHash} from 'node:crypto';
import type {ToolRunContext} from './context.js';

export const CONTEXT_PAGE_BYTES = 12 * 1024;

/** Stop at an item boundary. The caller must advance only past delivered rows. */
export function boundedContextPage<T>(rows:T[]):T[] {
  const page:T[]=[];
  let bytes=2;
  for(const row of rows){
    const size=Buffer.byteLength(JSON.stringify(row))+1;
    if(bytes+size>CONTEXT_PAGE_BYTES)break;
    page.push(row);bytes+=size;
  }
  return page;
}

/** Read identity and authorization without materializing a node's evidence. */
export async function contextNode(c:ToolRunContext,id:number){
  const row=(await c.db.query(`SELECT n.id,n.kind,n.state,n.content_version,n.exploration_id,t.id task_id,
    left(COALESCE(n.payload->>'summary',n.payload->>'text',''),300) summary
    FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
    WHERE n.id=$1 AND t.deleted_at IS NULL AND
      (t.id=$2 OR t.id IN (SELECT source_task_id FROM task_relations WHERE task_id=$2))
      AND exploration_node_readable(n.exploration_id,n.id)`,[id,c.taskID])).rows[0];
  if(!row)throw new Error('节点不存在或不属于当前授权范围');
  return {id:Number(row.id),kind:String(row.kind),state:String(row.state),version:Number(row.content_version),
    expID:Number(row.exploration_id),taskID:Number(row.task_id),summary:String(row.summary)};
}

export async function contextRelations(c:ToolRunContext,node:Awaited<ReturnType<typeof contextNode>>,view:'parents'|'members',cursor?:string){
  if(view==='members'&&node.kind!=='digest')throw new Error('members 仅支持摘要');
  const signature=createHash('sha256').update(JSON.stringify([c.taskID,c.role,node.taskID,node.id,node.version,view])).digest('hex');
  let pageHash:string|undefined;
  let after=0,upper=Number((await c.db.query('SELECT COALESCE(max(id),0) n FROM exploration_nodes WHERE exploration_id=$1',[node.expID])).rows[0]!.n);
  if(cursor){
    let p:{signature:string;after:number;upper:number;pageHash?:string};
    try{p=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new Error('无效关系游标');}
    if(p.signature!==signature||![p.after,p.upper].every(v=>Number.isSafeInteger(v)&&v>=0)||p.after>p.upper)throw new Error('关系或节点版本已变化，请重新读取');
    after=p.after;upper=p.upper;pageHash=p.pageHash;
  }
  const relation=view==='parents'
    ? `EXISTS(SELECT 1 FROM exploration_edges e WHERE e.exploration_id=$1 AND e.dst_id=$2 AND e.src_id=n.id AND e.rel='derived_from')`
    : `n.id IN (SELECT value::bigint FROM exploration_nodes d CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(d.payload->'member_ids','[]'::jsonb)) WHERE d.id=$2 AND d.exploration_id=$1)`;
  const rows=(await c.db.query(`SELECT n.id,n.kind,n.state,n.content_version,
    left(COALESCE(n.payload->>'summary',n.payload->>'text',''),300) summary
    FROM exploration_nodes n WHERE n.exploration_id=$1 AND n.id>$3 AND n.id<=$4 AND ${relation}
      AND exploration_node_readable($1,n.id) ORDER BY n.id LIMIT 21`,[node.expID,node.id,after,upper])).rows;
  const current=await contextNode(c,node.id);
  if(current.version!==node.version)throw new Error('关系或节点版本已变化，请重新读取');
  const items=boundedContextPage(rows.slice(0,20).map(n=>({ref:`node:${n.id}`,kind:n.kind,version:Number(n.content_version),state:n.state,summary:n.summary})));
  const hash=createHash('sha256').update(JSON.stringify(items)).digest('hex');
  if(pageHash!==undefined&&pageHash!==hash)throw new Error('本页成员或授权已变化，请重新读取本页');
  const last=items.at(-1);
  return {items,page_cursor:Buffer.from(JSON.stringify({signature,upper,after,pageHash:hash})).toString('base64url'),
    next_cursor:rows.length>items.length&&last?Buffer.from(JSON.stringify({signature,upper,after:Number(last.ref.slice(5))})).toString('base64url'):null};
}
