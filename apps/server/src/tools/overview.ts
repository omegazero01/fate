import {assetCounts} from '../db/asset-query.js';
import {executionSnapshot} from '../engine/coordinator.js';
import { graphSources } from "../db/graph_view.js";
import {progressSummary,resultSummary,stopSummary,progressProjectionSQL,resultProjectionSQL,stopProjectionSQL} from '../agent/context-projection.js';
import {graphProjection,nodeProjectionCounts} from '../db/graph-projection.js';
// graph_overview：planner/worker/mainagent 的态势输入。
// 有界 JSON 投影（替代 Go 的 lightformat 渲染协议）：
// goals / frontier / running / open_intents / recent_facts / recent_done / coverage / hints / digests。

import { domainTool, clampOutput } from "./define.js";
import type { ToolRunContext } from "./context.js";
import {workerCapabilities} from '../agent/worker-capabilities.js';

interface OverviewOptions {
  /** worker 视角删除 coverage（Go 语义：worker 只看方向不看度量）。 */
  forWorker?: boolean;
  localOnly?: boolean;
  summaryOnly?: boolean;
  /** Request-boundary state excludes historical projections delivered separately. */
  currentOnly?: boolean;
}

// Keep the same compact lineage as SERIES. Read real anchors/edges, not model
// payload aliases, and check the other end against the current task's view.
async function intentLinks(c:ToolRunContext,ids:number[]){
  const result=await c.db.query(`SELECT n.id,
    ARRAY(SELECT a.asset_id FROM exploration_anchors a WHERE a.node_id=n.id ORDER BY a.asset_id LIMIT 51) asset_ids,
    ARRAY(SELECT e.src_id FROM exploration_edges e JOIN exploration_nodes p ON p.id=e.src_id
      JOIN tasks t ON t.exploration_id=p.exploration_id
      WHERE e.exploration_id=$1 AND e.dst_id=n.id AND e.rel IN ('derived_from','spawns')
      AND t.deleted_at IS NULL AND (t.id=$3 OR t.id IN (SELECT source_task_id FROM task_relations WHERE task_id=$3))
      AND exploration_node_readable(p.exploration_id,p.id) ORDER BY e.src_id LIMIT 21) parents,
    ARRAY(SELECT e.dst_id FROM exploration_edges e JOIN exploration_nodes f ON f.id=e.dst_id
      WHERE e.exploration_id=$1 AND e.src_id=n.id AND e.rel='yields'
      AND f.exploration_id=$1 AND exploration_node_readable($1,f.id) ORDER BY e.dst_id LIMIT 21) yields
    FROM exploration_nodes n WHERE n.exploration_id=$1 AND n.id=ANY($2::bigint[])
      AND exploration_node_readable($1,n.id)`,[c.expID,ids,c.taskID]);
  return new Map(result.rows.map(r=>[Number(r.id),{
    asset_ids:(r.asset_ids as string[]).slice(0,50).map(Number),
    parents:(r.parents as string[]).slice(0,20).map(Number),yields:(r.yields as string[]).slice(0,20).map(Number),
    ...((r.asset_ids as unknown[]).length>50||(r.parents as unknown[]).length>20||(r.yields as unknown[]).length>20
      ?{relations_truncated:true,read:{ref:`node:${r.id}`,view:'detail'}}:{}),
  }]));
}

async function authorizedFindingCount(c:ToolRunContext,worker:boolean){
  const row=(await c.db.query(`SELECT count(*) total FROM findings f WHERE f.task_id=$1 AND
    CASE WHEN f.node_id IS NOT NULL THEN exploration_node_readable($2,f.node_id)
    ELSE true END`,[c.taskID,c.expID])).rows[0]!;
  return Number(row.total);
}

export async function buildGraphOverview(
  c: ToolRunContext,
  opts: OverviewOptions = {},
): Promise<Record<string, unknown>> {
  const overview=await graphProjection(c.db,c.taskID,c.expID,JSON.stringify([opts.forWorker===true,opts.localOnly===true,opts.summaryOnly===true,opts.currentOnly===true]),
    db=>buildGraphProjection({...c,db},opts));
  overview.scheduling=await executionSnapshot(c.db,c.taskID);
  if(!opts.summaryOnly){
    overview.todos=c.todos?c.todos.get(c.expID).slice(0,20).map(t=>({...t,content:t.content.slice(0,180)})):undefined;
    if(c.role==='planner'&&!opts.localOnly&&!opts.currentOnly)overview.worker_capabilities=await workerCapabilities(c);
  }
  return overview;
}

async function buildGraphProjection(c:ToolRunContext,opts:OverviewOptions):Promise<Record<string,unknown>> {
  // A cache miss has one snapshot connection. Do not enqueue concurrent pg
  // queries on that same client (deprecated by the driver's public contract).
  const counts=await nodeProjectionCounts(c.db,c.taskID,c.expID);
  const findingsCount=await authorizedFindingCount(c,opts.forWorker===true);
  const {open:openCount,done:doneCount,facts:factsCount}=counts;
  const assetView=opts.forWorker||c.taskID<=0?{}:{asset_counts:await assetCounts(c.db,c.taskID),coverage:await c.db.taskScope().taskCoverage(c.taskID,c.expID)};
  if(opts.summaryOnly){
    const goals=(await c.db.query(`SELECT id,content_version,state,left(COALESCE(payload->>'text',payload->>'summary',''),180) text
      FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal' AND exploration_node_readable($1,id)
      ORDER BY id LIMIT 11`,[c.expID])).rows;
    return {...assetView,goals:goals.slice(0,10).map(g=>({id:Number(g.id),ref:`node:${g.id}`,version:Number(g.content_version),state:g.state,text:g.text})),more_goals:goals.length>10,
      frontier_open:openCount,done_intents_total:doneCount,facts_total:factsCount,findings_total:findingsCount,
      related_tasks:opts.localOnly?[]:(await graphSources(c.db,c.taskID)).map(t=>({source_task_id:t.taskID,read_only:true})),
      read:{search:'context_search',detail:'context_get',recent:{tool:'graph_overview',view:'recent'},note:'先按类型、状态、资产或意图检索摘要，再按 ref/version 读取所需字段；未展示的节点不表示不存在。'}};
  }


  const smallNodes=async(kind:string,limit:number)=> (await c.db.query(`SELECT id,content_version,state,
   jsonb_build_object('text',left(payload->>'text',180),'summary',left(COALESCE(payload->>'summary',payload->>'body',''),1201),
    'member_count',CASE WHEN jsonb_typeof(payload->'member_ids')='array' THEN jsonb_array_length(payload->'member_ids') ELSE 0 END) payload
   FROM exploration_nodes WHERE exploration_id=$1 AND kind=$2 AND ($2<>'digest' OR state='active')
    AND exploration_node_readable($1,id) ORDER BY id DESC LIMIT $3`,[c.expID,kind,limit])).rows.map(r=>({id:Number(r.id),content_version:Number(r.content_version),state:String(r.state),payload:r.payload as Record<string,unknown>}));
  const goals=await smallNodes('goal',30),hints=await smallNodes('hint',10),digests=opts.currentOnly?[]:await smallNodes('digest',20);
  digests.sort((a,b)=>a.id-b.id);
  const frontier=(await c.db.query(`SELECT id,content_version,state,priority,
   jsonb_build_object('summary',left(payload->>'summary',180),'execution_stop',${stopProjectionSQL('payload')}) payload
   FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state='open'
    AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true' AND exploration_node_readable($1,id)
   ORDER BY CASE WHEN (SELECT worker_queue_manual FROM explorations WHERE id=$1) THEN queue_position ELSE 0 END,
    CASE WHEN (SELECT worker_queue_manual FROM explorations WHERE id=$1) THEN 0 ELSE priority END DESC,id LIMIT 30`,[c.expID])).rows
   .map(r=>({id:Number(r.id),content_version:Number(r.content_version),state:String(r.state),priority:Number(r.priority),payload:r.payload as Record<string,unknown>}));


  const running = await c.db.query(
    `SELECT id,content_version, left(payload->>'summary',180) AS summary, ${opts.currentOnly?'NULL::jsonb':progressProjectionSQL('payload')} AS progress,owner,
      ${opts.currentOnly?'0':"CASE WHEN jsonb_typeof(payload->'progress'->'attempted')='array' THEN jsonb_array_length(payload->'progress'->'attempted') ELSE 0 END"} attempted_count FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state='running' ORDER BY id LIMIT 10`,
    [c.expID],
  );
  // Select the page before extracting fields; jsonb_to_record detoasts a large
  // original once rather than once per summary/confidence/writeback expression.
  const recentFacts = opts.currentOnly?{rows:[]}:await c.db.query(
    `SELECT n.id,n.content_version, left(p.summary,180) AS summary, left(p.confidence,40) AS confidence,
            p.from_intent AS from_intent,left(p.observation_type,40) observation_type,
            CASE WHEN jsonb_typeof(p.writeback)='object' THEN jsonb_build_object(
             'version',p.writeback->'version','asset_binding',left(p.writeback->>'asset_binding',40),
             'scope_status',left(p.writeback->>'scope_status',40),'coverage_eligible',p.writeback->'coverage_eligible',
             'gaps',(SELECT jsonb_agg(left(v #>> '{}',80)) FROM (SELECT value v FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(p.writeback->'gaps')='array' THEN p.writeback->'gaps' ELSE '[]'::jsonb END) LIMIT 8) g)) END writeback, n.created_at
     FROM (SELECT id,content_version,payload,created_at FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='confirmed'
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 20) n
     CROSS JOIN LATERAL jsonb_to_record(CASE WHEN jsonb_typeof(n.payload)='object' THEN n.payload ELSE '{}'::jsonb END)
       p(summary text,confidence text,from_intent text,observation_type text,writeback jsonb)
     ORDER BY n.id DESC`,
    [c.expID],
  );
  const recentDone = opts.currentOnly?{rows:[]}:await c.db.query(
    `SELECT id,content_version, left(payload->>'summary',180) AS summary, ${resultProjectionSQL('payload')} AS result,${stopProjectionSQL('payload')} AS execution_stop,state FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state IN ('done','exhausted','blocked','stopped')
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 12`,
    [c.expID],
  );
  for (const result of [running,recentFacts,recentDone]) {
    if(!result.rows.length)continue;
    // Only authorization IDs are needed here. Loading complete evidence again
    // defeats the bounded summary projection above for long HTTP reports.
    const readable=await c.db.query(`SELECT n.id FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
      WHERE t.id=$1 AND n.exploration_id=$2 AND n.id=ANY($3::bigint[]) AND exploration_node_readable($2,n.id)`,[c.taskID,c.expID,result.rows.map(r=>Number(r.id))]);
    const allowed=new Set(readable.rows.map(n=>Number(n.id)));
    result.rows=result.rows.filter(r=>allowed.has(Number(r.id)));
  }
  const links=await intentLinks(c,[...frontier.map(n=>n.id),...running.rows.map(r=>Number(r.id)),...recentDone.rows.map(r=>Number(r.id))]);
  const overview: Record<string, unknown> = {...assetView,
    goals: goals.map((g) => ({ id: g.id,ref:`node:${g.id}`,version:g.content_version,text: String(g.payload["text"]??""), state: g.state })),
    frontier_open: openCount,
    open_intents: frontier.slice(0, 30).map((n) => ({
      id: n.id,
      ref:`node:${n.id}`,version:n.content_version,
      state:n.state,...links.get(n.id),
      summary: String(n.payload["summary"]??""),
      priority: n.priority,execution_stop:stopSummary(n.payload.execution_stop),
    })),
    running_intents: running.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      ref:`node:${r.id}`,version:Number(r.content_version),
      state:'running',...links.get(Number(r['id'])),
      summary: String(r["summary"]??""),
      owner: r["owner"],
      progress:r.progress?{...progressSummary(r['progress']),attempted_count:Number(r.attempted_count)}:undefined,
    })),
    done_intents_total: doneCount,
    recent_done_intents: recentDone.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      ref:`node:${r.id}`,version:Number(r.content_version),
      ...links.get(Number(r['id'])),
      summary: String(r["summary"]??""),
      state: r["state"],
      result:resultSummary(r['result']),execution_stop:stopSummary(r['execution_stop']),
    })),
    recent_facts: recentFacts.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      ref:`node:${r.id}`,version:Number(r.content_version),
      summary: String(r["summary"]??""),
      confidence: r["confidence"] ?? "medium",
      observation_type:r.observation_type??'unknown',writeback:r.writeback??{scope_status:'legacy_unspecified'},
      from_intent: r["from_intent"] === null ? null : Number(r["from_intent"]),
    })),
    facts_total: factsCount,
    facts_total_hint: "使用 context_search 按 fact 类型检索摘要，context_get 按引用读取所需字段",
    findings_total: findingsCount,
    active_hints: hints.filter((h) => h.state === "active").map((h) => ({ id: h.id, text: String(h.payload["text"]??"") })),
    cold_digests: digests
      .filter((d) => d.state === "active")
      .map((d) => {
        const summary=Array.from(String(d.payload['summary']??d.payload['body']??''));
        return {id:d.id,ref:`node:${d.id}`,version:d.content_version,summary:summary.slice(0,1200).join(''),
          summary_truncated:summary.length>1200,member_count:Number(d.payload.member_count??0),
          read:{ref:`node:${d.id}`,view:'members'}};
      }),
    cold_digests_index: { tool: 'context_search', types:['digest'],task_id:c.taskID },
    node_index:{tool:"context_search",task_id:c.taskID},
    projection:{summary_only:true,detail:'context_get',note:'有界摘要不代表全文已读；未展示的节点、关系和字段仍保留在图谱中。'},
  };

  if (!opts.forWorker&&!opts.currentOnly) {
    const decisions=await c.db.query(`SELECT id,decision,created_at FROM planner_decisions d WHERE exploration_id=$1
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(d.decision->'basis_ids','[]')) b WHERE NOT EXISTS(
        SELECT 1 FROM exploration_nodes n WHERE n.id=b.value::bigint AND exploration_node_readable(n.exploration_id,n.id)
        AND (n.exploration_id=$1 OR n.exploration_id IN (SELECT src.exploration_id FROM task_relations r JOIN tasks src ON src.id=r.source_task_id WHERE r.task_id=$2 AND src.deleted_at IS NULL)))) ORDER BY id DESC LIMIT 5`,[c.expID,c.taskID]);
    overview.planning_decisions=decisions.rows;
  }
  if (!opts.localOnly) {
    const sources=await graphSources(c.db,c.taskID);
    if(opts.currentOnly)overview.related_tasks=sources.map(source=>({source_task_id:source.taskID,inherited:true,read_only:true}));
    else{
      const related=[];
      for(const source of sources){
        const v=await buildGraphProjection({...c,taskID:source.taskID,expID:source.expID,todos:undefined},{...opts,localOnly:true});
        related.push({source_task_id:source.taskID,inherited:true,read_only:true,
          goals:(v.goals as unknown[]).slice(0,5),recent_facts:(v.recent_facts as unknown[]).slice(0,5),
          cold_digests:(v.cold_digests as unknown[]).slice(0,3),facts_total:v.facts_total,findings_total:v.findings_total,
          index:{tool:'context_search',task_id:source.taskID}});
      }
      overview.related_tasks=related;
    }
  }
  return overview;
}

interface GraphOverviewArgs {view?:'summary'|'recent';}

export function graphOverviewTool(ctx: ToolRunContext, opts: OverviewOptions = {}) {
  return domainTool<GraphOverviewArgs>(
    {
      name: "graph_overview",
      description:
        "读取当前探索态势：目标状态、frontier、在跑/近期意图、近期事实、漏洞数、覆盖度（planner 决策的输入）。" +
        "只读、可随时刷新。",
      promptSnippet: "读取探索态势总览",
      parameters: { type: 'object', properties: {view:{type:'string',enum:['summary','recent'],description:'默认 summary：计数和目标索引；recent：近期节点、覆盖与待办摘要。详情使用 context_search/context_get。'}} },
      readOnly: true,
      async run(args, c) {
        return buildGraphOverview(c, {...opts,summaryOnly:args.view!=='recent'});
      },
    },
    ctx,
  );
}

export function renderOverviewText(overview: Record<string, unknown>): string {
  return clampOutput(JSON.stringify(overview, null, 1));
}
