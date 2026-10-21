import {writeOrigin,writeAnchors,assertDirectWrite,sourceFields,sameSource} from './write-origin.js';
import { resolveGraphNode, authorizedNodes } from "../db/graph_view.js";
// 探索图读写工具：record_fact（写通道纪律核心）、node_detail、
// search_worker_traces / get_worker_trace（worker 间过程级信息交换）。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { KindFact, RelYields } from "../db/exploration.js";
import {normalizeWritebackScope,writebackReceipt,savedWritebackReceipt,writebackScopeSchema,type WritebackScope} from './writeback-scope.js';

// ─── record_fact：worker 写回事实（intent --yields--> fact）─────────────────

interface RecordFactArgs { facts?:RecordFactArgs[]; summary: string; evidence?: string; detail?:string; scope?:WritebackScope; observation_type?:'observed'|'inferred'|'negative'|'unknown';confidence?: "low" | "medium" | "high"; asset_ids?: number[]; }

export function recordFactTool(ctx: ToolRunContext) {
  const singleProperties = {
    summary:{type:"string"},evidence:{type:"string"},detail:{type:"string"},scope:writebackScopeSchema,observation_type:{type:"string",enum:["observed","inferred","negative","unknown"]},confidence:{type:"string",enum:["low","medium","high"]},asset_ids:{type:"array",items:{type:"integer"}}
  };
  return domainTool<RecordFactArgs>(
    {
      name: "record_fact",
      description:
        "把本意图的探索结论写成一条事实节点（fact）。只写增量：合并多个观察为一条、只记录新信息。" +
        "负面结果（不存在/不可利用）同样有价值。必须附证据与置信度。",
      promptSnippet: "写回探索事实（正面/负面结论都要，带证据）",
      parameters: {
        type: "object",
        properties: {
          facts:{type:"array",minItems:1,maxItems:20,items:{type:"object",properties:singleProperties,required:["summary"]},description:"独立结论批量提交，每项事务独立；返回同序 ID 与错误"},
          summary: { type: "string", description: "一句话事实结论（自包含，不引用'上文'）" },
          evidence: { type: "string", description: "支撑该结论的关键证据原文（命令输出/响应片段）" },
          detail:{type:'string',description:'复现所需且 summary/evidence 未覆盖的方法或限制；无额外信息时省略，不重复摘要或证据'},
          scope:writebackScopeSchema,
          observation_type:{type:'string',enum:['observed','inferred','negative','unknown'],description:'区分实测观察、推断、负面结果和未知；confirmed 表示记录已提交，不表示所有推断为真'},
          confidence: { type: "string", enum: ["low", "medium", "high"], description: "置信度，默认 medium" },
          asset_ids: {
            type: "array",
            items: { type: "integer" },
            description: "仅填写本条结论实际涉及的资产 ID，可含多个相关资产；缺省或空数组不继承意图资产，记录保留但不计覆盖",
          },
        },
        anyOf:[{required:["summary"]},{required:["facts"]}],
      },
      transactional:false,
      async run(args, ctx) {
        assertDirectWrite(args);
        const save=(args:RecordFactArgs,ctx:ToolRunContext)=>ctx.db.transaction(async db=>{
        await ctx.hooks.assertOwnership?.(db);
        assertDirectWrite(args);
        if (!args.summary?.trim()) throw new Error('summary 不能为空');
        if (ctx.role === 'worker' && !args.evidence?.trim()) throw new Error('事实缺少实际证据');
        const c={...ctx,db};
        const s = c.db.exploration(c.expID);
        const origin = await writeOrigin(c);
        const anchors = await writeAnchors(c,origin,args.asset_ids);
        if (c.toolCallID) {
          const old=(await db.query("SELECT id,payload FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND tool_call_id=$2",[c.expID,c.toolCallID])).rows[0];
          if (old) {
            const payload=old.payload as Record<string,unknown>;
            if (!sameSource(c,origin,payload)) throw new Error('工具调用编号已用于其他来源');
            const savedAnchors=await s.anchorAssetIDs(Number(old.id));
            await writeAnchors(c,origin,savedAnchors);
            return {fact_id:Number(old.id),anchored_assets:savedAnchors.length,asset_ids:savedAnchors,writeback:savedWritebackReceipt(payload.writeback)};
          }
        }
        const payload: Record<string, unknown> = {
          summary: args.summary,
          ...sourceFields(c,origin),
        };
        if (args.evidence) payload["evidence"] = args.evidence;
        if(args.detail)payload.detail=args.detail;
        payload.observation_type=args.observation_type??'unknown';
        payload["confidence"] = args.confidence ?? "medium";
        const scope=normalizeWritebackScope(args.scope);
        if(scope)payload.scope=scope;
        payload.writeback=writebackReceipt(anchors,scope,args.evidence,String(payload.observation_type));

        const factID = await s.addNode(KindFact, payload, 0, "confirmed", c.workerName ?? c.role, anchors);
        await db.query('UPDATE exploration_nodes SET tool_call_id=$2 WHERE id=$1',[factID,c.toolCallID??null]);
        await s.link(origin.id, RelYields, factID);
        return { fact_id: factID, anchored_assets: anchors.length,asset_ids:anchors,writeback:payload.writeback };
      });
        if(!args.facts)return save(args,ctx);
        if(args.summary||!args.facts.length||args.facts.length>20)throw new Error('使用 summary 单条或 facts 批量输入，不能混用');
        const results=[];
        for(let i=0;i<args.facts.length;i++){
          ctx.signal?.throwIfAborted();
          try{results.push(await save(args.facts[i]!,{...ctx,toolCallID:ctx.toolCallID?`${ctx.toolCallID}:item:${i}`:undefined}));}
          catch(error){results.push({fact_id:0,error:error instanceof Error?error.message:String(error)});}
        }
        return {fact_ids:results.map(r=>r.fact_id),results};
      },
    },
    ctx,
  );
}

// ─── node_detail：任意节点钻取 ───────────────────────────────────────────────

interface NodeDetailArgs { node_id: number; offset?: number; after_edge?: number; anchor_offset?: number; }

export function nodeDetailTool(ctx: ToolRunContext) {
  return domainTool<NodeDetailArgs>(
    {
      name: "node_detail",
      description: "查看探索图中一个节点的完整详情：payload、状态、上下游边（血缘）、锚定资产。",
      promptSnippet: "钻取节点详情与血缘",
      parameters: {
        type: "object",
        properties: { node_id: { type: "integer", description: "节点 id" }, offset:{type:"integer",minimum:0},after_edge:{type:"integer",minimum:0},anchor_offset:{type:"integer",minimum:0} },
        required: ["node_id"],
      },
      readOnly: true,
      async run(args, c) {
        const resolved = await resolveGraphNode(c.db, c.taskID, c.expID, args.node_id);
        const { node } = resolved;
        const s = c.db.exploration(resolved.expID);
        const edges = await c.db.query(
          `SELECT id, src_id, rel, dst_id FROM exploration_edges
           WHERE exploration_id=$1 AND (src_id=$2 OR dst_id=$2) AND id>$3 ORDER BY id LIMIT 11`,
          [resolved.expID, args.node_id,args.after_edge??0],
        );
        const anchors = await s.anchorAssetIDs(args.node_id);
        const anchorAssets =
          anchors.length > 0
            ? (await c.db.assets().getByIDs(anchors.slice(args.anchor_offset??0,(args.anchor_offset??0)+10))).map((a) => ({
                id: a.id,
                type: a.type,
                host: a.domain || a.ip || a.url || a.app_name || a.bundle_id,
              }))
            : [];
        const visibleEdges=[];
        for(const edge of edges.rows.slice(0,10)){
          const otherID=Number(edge.src_id)===node.id?Number(edge.dst_id):Number(edge.src_id);
          const other=await s.getNode(otherID);
          if(other&&(await authorizedNodes(c.db,resolved.taskID,resolved.expID,[other])).length)visibleEdges.push(edge);
        }
        const payload=JSON.stringify(node.payload),offset=Math.max(0,args.offset??0),full=Buffer.byteLength(payload)<8000;
        return {
          source_task_id: resolved.taskID, inherited: resolved.inherited,
          node: { id: node.id, kind: node.kind, state: node.state, payload: full?node.payload:undefined, created_at: node.created_at },
          payload_json: full?undefined:payload.slice(offset,offset+1000),
          next_offset: full||offset+1000>=payload.length?null:offset+1000,
          edges: visibleEdges,
          next_edge:edges.rows.length>10?Number(edges.rows[9]!.id):null,
          next_anchor_offset:(args.anchor_offset??0)+10<anchors.length?(args.anchor_offset??0)+10:null,
          anchors: anchorAssets,
        };
      },
    },
    ctx,
  );
}

// ─── search_worker_traces：跨 work 过程检索 ────────────────────────────────

interface SearchTracesArgs { query: string; limit?: number; before_id?: number; }

export function searchWorkerTracesTool(ctx: ToolRunContext) {
  return domainTool<SearchTracesArgs>(
    {
      name: "search_worker_traces",
      description:
        "在本任务其他 work 的执行过程（activity 轨迹）里按关键字检索——很多有价值的观察（报错、响应片段、隐藏参数）" +
        "不会升格为正式 fact，但留在过程里。命中项带 intent_id/step_id，可用 get_worker_trace 取完整内容。" +
        "自动排除你自己这条意图的步骤。",
      promptSnippet: "检索其他 work 的执行过程观察",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键字（不区分大小写）" },
          before_id:{type:"integer",minimum:0},
          limit: { type: "integer", description: "默认 10，上限 20" },
        },
        required: ["query"],
      },
      readOnly: true,
      async run(args, c) {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
        const q = `%${args.query.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
        const res = await c.db.query(
          `SELECT id, node_id, worker, kind, tool, summary,
                  substring(COALESCE(detail, summary) FROM greatest(1, strpos(lower(COALESCE(detail, summary)), lower($2)) - 60) FOR 240) AS context
           FROM activity
           WHERE exploration_id=$1 AND node_id IS NOT NULL AND node_id IS DISTINCT FROM $3
             AND kind NOT IN ('usage','round')
             AND (summary ILIKE $2 OR detail ILIKE $2) AND ($5::bigint=0 OR id<$5)
           ORDER BY id DESC LIMIT $4`,
          [c.expID, q, c.intentID ?? -1, limit+1,args.before_id??0],
        );
        const visible=[];
        for(const row of res.rows.slice(0,limit)){
          try{await resolveGraphNode(c.db,c.taskID,c.expID,Number(row.node_id));visible.push(row);}catch{ /* filtered */ }
        }
        return {
          next_cursor:res.rows.length>limit?Number(res.rows[limit-1]!.id):null,
          matches: visible.map((r: Record<string, unknown>) => ({
            step_id: Number(r["id"]),
            intent_id: r["node_id"] === null ? null : Number(r["node_id"]),
            worker: r["worker"],
            kind: r["kind"],
            tool: r["tool"],
            summary: String(r["summary"]??"").slice(0,150),
            context: r["context"],
          })),
          hint: "用 get_worker_trace(intent_id, step_ids=[...]) 获取完整步骤内容",
        };
      },
    },
    ctx,
  );
}

// ─── get_worker_trace：某条 work 的过程详情（含最终结论）───────────────────

interface GetTraceArgs { intent_id: number; step_ids?: number[]; include_output?: boolean; offset?: number; after_id?: number; }

export function getWorkerTraceTool(ctx: ToolRunContext) {
  return domainTool<GetTraceArgs>(
    {
      name: "get_worker_trace",
      description:
        "查看某个 work（意图）的执行轨迹：先无 step_ids 列出步骤摘要（看动作与观察，不含模型内心），" +
        "再带 step_ids（≤5 个）取完整内容；include_output=true 额外返回该 work 的最终总结。" +
        "planner 用它判断 exhausted/blocked 意图的实际进度；worker 用它复用他人过程细节。",
      promptSnippet: "读取指定 work 的执行轨迹与结论",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer", description: "意图 id" },
          step_ids: {
            type: "array",
            items: { type: "integer" },
            maxItems: 5,
            description: "要取完整内容的步骤 id 列表（省略则只列摘要）",
          },
          offset: { type: "integer", minimum: 0, description: "步骤正文字符偏移，使用 next_offset 继续读取" },
          after_id: { type: "integer", minimum: 0, description: "步骤列表游标" },
          include_output: { type: "boolean", description: "是否附最终总结，默认 false" },
        },
        required: ["intent_id"],
      },
      readOnly: true,
      async run(args, c) {
        const s = c.db.exploration(c.expID);
        const resolved=await resolveGraphNode(c.db,c.taskID,c.expID,args.intent_id);
        const intent=resolved.node;
        if(intent.kind!=='intent')throw new Error('节点不是意图');

        const listRows = await c.db.query(
          `SELECT id, kind, tool, is_error, summary, created_at FROM activity
           WHERE exploration_id=$1 AND node_id=$2 AND kind NOT IN ('usage','round') AND id>$3
           ORDER BY id LIMIT 11`,
          [resolved.expID, args.intent_id, args.after_id ?? 0],
        );
        const steps = listRows.rows.slice(0,10).map((r: Record<string, unknown>) => ({
          step_id: Number(r["id"]),
          kind: r["kind"],
          tool: r["tool"],
          is_error: r["is_error"] === true,
          summary: String(r["summary"]??"").slice(0,150),
        }));

        const detail: Record<string, unknown>[] = [];
        if (args.step_ids && args.step_ids.length > 0) {
          const rows = await c.db.query(
            `SELECT id, kind, tool, summary, detail FROM activity
             WHERE exploration_id=$1 AND node_id=$2 AND id=ANY($3::bigint[]) ORDER BY id`,
            [resolved.expID, args.intent_id, args.step_ids.slice(0,5)],
          );
          for (const r of rows.rows) {
            const body = (r["detail"] as string | null) ?? (r["summary"] as string | null) ?? "";
            detail.push({
              step_id: Number(r["id"]),
              kind: r["kind"],
              tool: r["tool"],
              body: body.slice(Math.max(0,args.offset ?? 0), Math.max(0,args.offset ?? 0)+350),
              total_chars: body.length,
              next_offset: (args.offset ?? 0)+350<body.length ? (args.offset ?? 0)+350 : null,
            });
          }
        }

        let output: string | undefined;
        if (args.include_output) {
          const row = await c.db.query(
            `SELECT summary FROM activity WHERE exploration_id=$1 AND node_id=$2 AND kind='result' ORDER BY id DESC LIMIT 1`,
            [resolved.expID, args.intent_id],
          );
          output = (row.rows[0]?.["summary"] as string | undefined) ?? undefined;
        }

        return {
          intent: { id: intent.id, state: intent.state, summary: intent.payload["summary"] },
          steps,
          next_cursor: listRows.rows.length>10 ? Number(listRows.rows[9]!.id) : null,
          detail,
          final_output: output?.slice(Math.max(0,args.offset??0),Math.max(0,args.offset??0)+1000),
          output_next_offset:output&&(args.offset??0)+1000<output.length?(args.offset??0)+1000:null,
        };
      },
    },
    ctx,
  );
}
