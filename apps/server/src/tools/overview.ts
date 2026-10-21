import {assetCounts,assetCoverage} from '../db/asset-query.js';
import {executionSnapshot} from '../engine/coordinator.js';
import { authorizedNodes, graphSources } from "../db/graph_view.js";
import {progressSummary,resultSummary,stopSummary} from '../agent/context-projection.js';
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

async function authorizedNodeCount(c:ToolRunContext,kind:string,states:string[],worker:boolean){
  const row=(await c.db.query(`SELECT count(*) total FROM exploration_nodes n WHERE n.exploration_id=$1
    AND n.kind=$2 AND n.state=ANY($3::text[]) AND exploration_node_readable($1,n.id)`,[c.expID,kind,states])).rows[0]!;
  return Number(row.total);
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
  const s = c.db.exploration(c.expID);
  const [openCount,doneCount,factsCount,findingsCount]=await Promise.all([
    authorizedNodeCount(c,'intent',['open'],opts.forWorker===true),
    authorizedNodeCount(c,'intent',['done','exhausted','blocked','stopped'],opts.forWorker===true),
    authorizedNodeCount(c,'fact',['confirmed'],opts.forWorker===true),
    authorizedFindingCount(c,opts.forWorker===true),
  ]);
  const assetView=opts.forWorker||c.taskID<=0?{}:{asset_counts:await assetCounts(c.db,c.taskID),coverage:await assetCoverage(c.db,c.taskID)};
  if(opts.summaryOnly){
    const goals=(await c.db.query(`SELECT id,content_version,state,left(COALESCE(payload->>'text',payload->>'summary',''),180) text
      FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal' AND exploration_node_readable($1,id)
      ORDER BY id LIMIT 11`,[c.expID])).rows;
    return {...assetView,scheduling:await executionSnapshot(c.db,c.taskID),goals:goals.slice(0,10).map(g=>({id:Number(g.id),ref:`node:${g.id}`,version:Number(g.content_version),state:g.state,text:g.text})),more_goals:goals.length>10,
      frontier_open:openCount,done_intents_total:doneCount,facts_total:factsCount,findings_total:findingsCount,
      related_tasks:opts.localOnly?[]:(await graphSources(c.db,c.taskID)).map(t=>({source_task_id:t.taskID,read_only:true})),
      read:{search:'context_search',detail:'context_get',recent:{tool:'graph_overview',view:'recent'},note:'先按类型、状态、资产或意图检索摘要，再按 ref/version 读取所需字段；未展示的节点不表示不存在。'}};
  }


  let [goals, hints, digests] = await Promise.all([
    s.listByKind("goal", 30),
    s.listByKind("hint", 10),
    c.db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='digest' AND state='active' ORDER BY id DESC LIMIT 20",[c.expID]).then(r=>s.nodesByIDs(r.rows.map(n=>Number(n.id)))),
  ]);
  [goals,hints,digests] = await Promise.all([authorizedNodes(c.db,c.taskID,c.expID,goals),authorizedNodes(c.db,c.taskID,c.expID,hints),authorizedNodes(c.db,c.taskID,c.expID,digests)]);
  const frontier = await authorizedNodes(c.db,c.taskID,c.expID,await s.frontier(30));


  const running = await c.db.query(
    `SELECT id,content_version, payload->>'summary' AS summary, payload->'progress' AS progress,owner FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state='running' ORDER BY id LIMIT 10`,
    [c.expID],
  );
  const recentFacts = await c.db.query(
    `SELECT id,content_version, payload->>'summary' AS summary, payload->>'confidence' AS confidence,
            payload->>'from_intent' AS from_intent,payload->>'observation_type' observation_type,payload->'writeback' writeback, created_at
     FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='confirmed'
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 20`,
    [c.expID],
  );
  const recentDone = await c.db.query(
    `SELECT id,content_version, payload->>'summary' AS summary, payload->'execution_result' AS result,payload->'execution_stop' AS execution_stop,state FROM exploration_nodes
     WHERE exploration_id=$1 AND kind='intent' AND state IN ('done','exhausted','blocked','stopped')
       AND NOT EXISTS (SELECT 1 FROM exploration_edges e JOIN exploration_nodes d ON d.id=e.src_id
        WHERE e.dst_id=exploration_nodes.id AND e.rel='covers' AND d.kind='digest' AND d.state='active')
     ORDER BY id DESC LIMIT 12`,
    [c.expID],
  );
  for (const result of [running,recentFacts,recentDone]) {
    const nodes=await s.nodesByIDs(result.rows.map(r=>Number(r.id)));
    const allowed=new Set((await authorizedNodes(c.db,c.taskID,c.expID,nodes)).map(n=>n.id));
    result.rows=result.rows.filter(r=>allowed.has(Number(r.id)));
  }
  const links=await intentLinks(c,[...frontier.map(n=>n.id),...running.rows.map(r=>Number(r.id)),...recentDone.rows.map(r=>Number(r.id))]);
  const overview: Record<string, unknown> = {...assetView,
    scheduling:await executionSnapshot(c.db,c.taskID),
    ...(c.role === 'planner' && !opts.localOnly ? {worker_capabilities:await workerCapabilities(c)} : {}),
    goals: goals.map((g) => ({ id: g.id,ref:`node:${g.id}`,version:g.content_version,text: String(g.payload["text"]??"").slice(0,180), state: g.state })),
    frontier_open: openCount,
    open_intents: frontier.slice(0, 30).map((n) => ({
      id: n.id,
      ref:`node:${n.id}`,version:n.content_version,
      state:n.state,...links.get(n.id),
      summary: String(n.payload["summary"]??"").slice(0,180),
      priority: n.priority,execution_stop:stopSummary(n.payload.execution_stop),
    })),
    running_intents: running.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      ref:`node:${r.id}`,version:Number(r.content_version),
      state:'running',...links.get(Number(r['id'])),
      summary: String(r["summary"]??"").slice(0,180),
      owner: r["owner"],
      progress:progressSummary(r['progress']),
    })),
    done_intents_total: doneCount,
    recent_done_intents: recentDone.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      ref:`node:${r.id}`,version:Number(r.content_version),
      ...links.get(Number(r['id'])),
      summary: String(r["summary"]??"").slice(0,180),
      state: r["state"],
      result:resultSummary(r['result']),execution_stop:stopSummary(r['execution_stop']),
    })),
    recent_facts: recentFacts.rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      ref:`node:${r.id}`,version:Number(r.content_version),
      summary: String(r["summary"]??"").slice(0,180),
      confidence: r["confidence"] ?? "medium",
      observation_type:r.observation_type??'unknown',writeback:r.writeback??{scope_status:'legacy_unspecified'},
      from_intent: r["from_intent"] === null ? null : Number(r["from_intent"]),
    })),
    facts_total: factsCount,
    facts_total_hint: "使用 context_search 按 fact 类型检索摘要，context_get 按引用读取所需字段",
    findings_total: findingsCount,
    active_hints: hints.filter((h) => h.state === "active").map((h) => ({ id: h.id, text: String(h.payload["text"]??"").slice(0,180) })),
    cold_digests: digests
      .filter((d) => d.state === "active")
      .map((d) => {
        const summary=Array.from(String(d.payload['summary']??d.payload['body']??''));
        return {id:d.id,ref:`node:${d.id}`,version:d.content_version,summary:summary.slice(0,1200).join(''),
          summary_truncated:summary.length>1200,member_count:(d.payload['member_ids'] as unknown[]??[]).length,
          read:{ref:`node:${d.id}`,view:'members'}};
      }),
    cold_digests_index: { tool: 'context_search', types:['digest'],task_id:c.taskID },
    todos: c.todos ? c.todos.get(c.expID).slice(0,20).map(t=>({...t,content:t.content.slice(0,180)})) : undefined,
    node_index:{tool:"context_search",task_id:c.taskID},
  };

  if (!opts.forWorker) {
    const cov = await c.db.taskScope().taskCoverage(c.taskID, c.expID);
    overview["coverage"] = cov;
    const decisions=await c.db.query(`SELECT id,decision,created_at FROM planner_decisions d WHERE exploration_id=$1
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(d.decision->'basis_ids','[]')) b WHERE NOT EXISTS(
        SELECT 1 FROM exploration_nodes n WHERE n.id=b.value::bigint AND exploration_node_readable(n.exploration_id,n.id)
        AND (n.exploration_id=$1 OR n.exploration_id IN (SELECT src.exploration_id FROM task_relations r JOIN tasks src ON src.id=r.source_task_id WHERE r.task_id=$2 AND src.deleted_at IS NULL)))) ORDER BY id DESC LIMIT 5`,[c.expID,c.taskID]);
    overview.planning_decisions=decisions.rows;
  }
  if (!opts.localOnly) {
    const sources=await graphSources(c.db,c.taskID);
    overview.related_tasks=await Promise.all(sources.map(async source=>{
      const v=await buildGraphOverview({...c,taskID:source.taskID,expID:source.expID,todos:undefined},{...opts,localOnly:true});
      return {source_task_id:source.taskID,inherited:true,read_only:true,
        goals:(v.goals as unknown[]).slice(0,5),recent_facts:(v.recent_facts as unknown[]).slice(0,5),
        cold_digests:(v.cold_digests as unknown[]).slice(0,3),facts_total:v.facts_total,findings_total:v.findings_total,
        index:{tool:'context_search',task_id:source.taskID}};
    }));
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
