import { domainTool } from './define.js';
import type { ToolRunContext } from './context.js';
import { authorizedNodes, graphSources, resolveGraphNode } from '../db/graph_view.js';

export function graphIndexTool(ctx: ToolRunContext, name = 'expand_index', kind = 'digest') {
  return domainTool<{after_id?:number;task_id?:number;kind?:string}>({ name,
    description: '分页发现本任务或直接来源任务的探索节点。返回 next_cursor，使用 node_detail 或 expand_digest 展开原文；来源任务只读。',
    readOnly: true, parameters:{type:'object',properties:{after_id:{type:'integer',minimum:0},task_id:{type:'integer'},kind:{type:'string',enum:['digest','fact','finding','goal','hint','intent']}}},
    async run(args,c) {
      const source = args.task_id && args.task_id !== c.taskID ? (await graphSources(c.db,c.taskID)).find(t => t.taskID === args.task_id) : {taskID:c.taskID,expID:c.expID};
      if (!source) throw new Error('不是直接来源任务');
      const selectedKind = name === 'list_facts' ? 'fact' : args.kind ?? kind;
      const raw = await c.db.query(`SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind=$2 AND id>$3
        AND (kind<>'digest' OR state='active') ORDER BY id LIMIT 21`,[source.expID,selectedKind,args.after_id ?? 0]);
      const page = raw.rows.slice(0,20);
      const nodes = await c.db.exploration(source.expID).nodesByIDs(page.map(r=>Number(r.id)));
      const allowed = await authorizedNodes(c.db,source.taskID,source.expID,nodes);
      return { source_task_id:source.taskID,inherited:source.taskID!==c.taskID,
        nodes:allowed.map(n=>({id:n.id,kind:n.kind,state:n.state,summary:String(n.payload.summary ?? n.payload.text ?? '').slice(0,300)})),
        next_cursor:raw.rows.length>20 ? Number(page.at(-1)!.id) : null };
    }
  },ctx);
}
export function expandDigestTool(ctx:ToolRunContext) {
  return domainTool<{digest_id:number;offset?:number}>({name:'expand_digest',description:'分页展开冷图摘要的原始成员与证据，不修改原图。',readOnly:true,
    parameters:{type:'object',properties:{digest_id:{type:'integer'},offset:{type:'integer',minimum:0}},required:['digest_id']},
    async run(args,c) {
      const source=await resolveGraphNode(c.db,c.taskID,c.expID,args.digest_id);
      if(source.node.kind!=='digest')throw new Error('不是 digest');
      const ids=(source.node.payload.member_ids as number[] ?? []);
      const offset=Math.max(0,args.offset??0), take=10;
      const nodes=await c.db.exploration(source.expID).nodesByIDs(ids.slice(offset,offset+take));
      const allowed=await authorizedNodes(c.db,source.taskID,source.expID,nodes);
      return { source_task_id:source.taskID,inherited:source.inherited,state:source.node.state,
        members:allowed.map(n=>({id:n.id,kind:n.kind,state:n.state,summary:String(n.payload.summary??n.payload.text??'').slice(0,600),detail_tool:'node_detail'})),
        total:ids.length,next_offset:offset+take<ids.length?offset+take:null };
    }
  },ctx);
}
