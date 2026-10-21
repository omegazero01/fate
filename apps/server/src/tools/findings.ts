import {findingPublished} from '../db/worker-drafts.js';
import {writeOrigin,writeAnchors,assertDirectWrite,sourceFields,sameSource} from './write-origin.js';
import {bindEvidence} from "../evidence/store.js";
import { graphSources, resolveGraphNode } from "../db/graph_view.js";
// 漏洞工具：report_finding（worker 三通道写回之一）、list_findings、prove_goal（收官）。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { KindFinding, RelYields, RelProves } from "../db/exploration.js";
import { jsonbClean } from "../db/exploration.js";
import {normalizeWritebackScope,writebackReceipt,savedWritebackReceipt,writebackScopeSchema,type WritebackScope} from './writeback-scope.js';

const SEVERITIES = ["critical", "high", "medium", "low"];

interface ReportFindingArgs { scope?:WritebackScope; traffic_refs?:Array<{traffic_id:string;role?:string;note?:string}>; vulnclass: string; name?: string; severity: "critical" | "high" | "medium" | "low"; summary: string; evidence: string; asset_ids?: number[]; }

export function reportFindingTool(ctx: ToolRunContext) {
  return domainTool<ReportFindingArgs>(
    {
      name: "report_finding",
      description:
        "报告一个确认存在的漏洞。前置条件：真实触发过（不是'疑似'）、有可复现证据；" +
        "疑似问题用 record_fact 记录而不是报洞。报洞前先用 list_findings 查重；提交成功后立即写入图谱。",
      promptSnippet: "报告确认的漏洞（须可复现）",
      parameters: {
        type: "object",
        properties: {
          traffic_refs:{type:"array",items:{type:"object",properties:{traffic_id:{type:"string"},role:{type:"string",enum:["baseline","proof","verification","supporting"]},note:{type:"string"}},required:["traffic_id"]}},
          vulnclass: { type: "string", description: "漏洞类别，如 SQL注入/XSS/SSRF/未授权访问" },
          name: { type: "string", description: "漏洞标题（可读）" },
          severity: { type: "string", enum: SEVERITIES },
          summary: { type: "string", description: "影响与成因概述" },
          evidence: { type: "string", description: "复现证据（请求/响应/命令输出原文）" },
          asset_ids: { type: "array", items: { type: "integer" }, description: "本漏洞实际受影响的资产 ID；上下游背景资产写入说明，不混作受影响资产。缺省不继承意图资产" },
          scope:writebackScopeSchema,
        },
        required: ["vulnclass", "severity", "summary", "evidence"],
      },
      // This operation owns its DB transaction and publishes only after commit.
      transactional: false,
      async run(args, c) {
        assertDirectWrite(args);
        if (!args.evidence?.trim()) throw new Error('漏洞缺少实际证据');
        if (!args.summary?.trim()) throw new Error('summary 不能为空');
        let created=false;
        const saved = await c.db.transaction(async db => {
        await c.hooks.assertOwnership?.(db);
        await db.query('SELECT pg_advisory_xact_lock($1)', [-c.expID]);
        const s = db.exploration(c.expID);
        const origin = await writeOrigin({...c,db});
        const anchors = await writeAnchors({...c,db},origin,args.asset_ids);
        if(c.toolCallID){
          const existing=(await db.query(`SELECT f.id,f.node_id,n.payload FROM findings f JOIN exploration_nodes n ON n.id=f.node_id
            WHERE f.task_id=$1 AND f.tool_call_id=$2`,[c.taskID,c.toolCallID])).rows[0];
          if(existing){
            const payload=existing.payload as Record<string,unknown>;
            if(!sameSource(c,origin,payload))throw new Error('工具调用编号已用于其他来源');
            const savedAnchors=await writeAnchors({...c,db},origin,await s.anchorAssetIDs(Number(existing.node_id)));
            return {finding_node_id:Number(existing.node_id),finding_id:Number(existing.id),asset_ids:savedAnchors,writeback:savedWritebackReceipt(payload.writeback)};
          }
        }

        const payload: Record<string, unknown> = {
          vulnclass: args.vulnclass,
          name: args.name ?? "",
          severity: args.severity,
          summary: args.summary,
          ...sourceFields(c,origin),
        };
        const scope=normalizeWritebackScope(args.scope);
        if(scope)payload.scope=scope;
        payload.writeback=writebackReceipt(anchors,scope,args.evidence,'finding');
        const nodeID = await s.addNode(KindFinding, payload, 0, "confirmed", c.workerName ?? c.role, anchors);
        await s.link(origin.id, RelYields, nodeID);

        const ins = await db.query<{ id: string }>(
          `INSERT INTO findings(task_id, node_id, vulnclass, name, severity, summary, evidence, worker, asset_ids, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending') RETURNING id`,
          [
            c.taskID,
            nodeID,
            args.vulnclass,
            args.name ?? "",
            args.severity,
            args.summary,
            args.evidence,
            c.workerName ?? c.role,
            jsonbClean(JSON.stringify(anchors)),
          ],
        );
        const findingID=Number(ins.rows[0]!.id);
        await db.query("UPDATE findings SET tool_call_id=$2 WHERE id=$1",[findingID,c.toolCallID??null]);
        if(args.traffic_refs?.length)await bindEvidence(db,findingID,args.traffic_refs,c.taskID);
        await findingPublished(db,c.expID,nodeID);
        created=true;
        return { finding_node_id: nodeID, finding_id: findingID,asset_ids:anchors,writeback:payload.writeback };
        });
        // Nested callers leave delivery to the durable wakeup after their outer commit.
        if(created&&!c.db.transactionClient)c.hooks.notifyFinding?.(c.expID, saved.finding_node_id);
        return saved;
      },
    },
    ctx,
  );
}

interface ListFindingsArgs { limit?: number; offset?: number; include_inherited?: boolean; }

export function listFindingsTool(ctx: ToolRunContext) {
  return domainTool<ListFindingsArgs>(
    {
      name: "list_findings",
      description: "列出本任务（可选含继承来源任务）已报告的漏洞——报洞前查重、了解已有战果。",
      promptSnippet: "查询已报漏洞",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "默认 20，上限 50" },
          offset: { type: "integer" },
          include_inherited: { type: "boolean", description: "是否含只读继承的来源任务漏洞，默认 false" },
        },
      },
      readOnly: true,
      async run(args, c) {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
        let where = `f.task_id=$1`;
        const params: unknown[] = [c.taskID];
        if (args.include_inherited) {
          where = `f.task_id = ANY($1::bigint[])`;
          const src = await c.db.query<{ source_task_id: string }>(
            `SELECT source_task_id FROM task_relations WHERE task_id=$1`,
            [c.taskID],
          );
          params[0] = [c.taskID, ...src.rows.map((r) => Number(r.source_task_id))];
        }
        const res = await c.db.query(
          `SELECT f.id, f.task_id, f.node_id, f.vulnclass, f.name, f.severity, f.summary, f.status, f.asset_ids, f.created_at
           FROM findings f WHERE ${where} ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${args.offset ?? 0}`,
          params,
        );
        const sources=await graphSources(c.db,c.taskID),sourceByTask=new Map(sources.map(source=>[source.taskID,source]));
        const visible=[] as typeof res.rows;
        for(const row of res.rows){
          const ownerTask=Number(row.task_id),owner=ownerTask===c.taskID?{taskID:c.taskID,expID:c.expID}:sourceByTask.get(ownerTask);
          if(!owner)continue;
          try{
            if(row.node_id!==null){await resolveGraphNode(c.db,c.taskID,c.expID,Number(row.node_id));}
            else{
            }
            visible.push(row);
          }catch{/* Unauthorized evidence is omitted from the role's projection. */}
        }
        return {
          findings: visible.map((r: Record<string, unknown>) => ({
            id: Number(r["id"]),
            node_id: r["node_id"] === null ? null : Number(r["node_id"]),
            vulnclass: r["vulnclass"],
            name: r["name"],
            severity: r["severity"],
            summary: r["summary"],
            status: r["status"],
            asset_ids: r["asset_ids"],
          })),
        };
      },
    },
    ctx,
  );
}

interface ProveGoalArgs { goal_id: number; evidence_node_id: number; note?: string; }

export function proveGoalTool(ctx: ToolRunContext) {
  return domainTool<ProveGoalArgs>(
    {
      name: "prove_goal",
      description:
        "证明一个目标已达成：把证据节点（fact/finding）连到目标并置 met。当最后一个开放目标被证明时任务自动完成。" +
        "调用前必须核对覆盖度与漏洞总数（量化验收），不允许在明显未测完时提前收官。",
      promptSnippet: "证明目标达成并收官",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "integer", description: "目标节点 id" },
          evidence_node_id: { type: "integer", description: "支撑证据的节点 id（fact 或 finding）" },
          note: { type: "string", description: "一句话判定依据" },
        },
        required: ["goal_id", "evidence_node_id"],
      },
      transactional: false,
      async run(args, c) {
        await c.db.transaction(async db => {
          await c.hooks.assertOwnership?.(db);
          await db.query('SELECT pg_advisory_xact_lock($1)', [-c.expID]);
          const s = db.exploration(c.expID);
          const goal = await s.getNode(args.goal_id);
          if (!goal || goal.kind !== 'goal') throw new Error('目标不存在');
          const { node: evidence } = await resolveGraphNode(db, c.taskID, c.expID, args.evidence_node_id);
          if (!['fact','finding'].includes(evidence.kind) || evidence.state !== 'confirmed' || evidence.payload.acceptance_status==='unverified')
            throw new Error('证据必须为仍获授权的 confirmed 事实或漏洞；任务原文、线索及撤回记录不能证明目标');
          const finding = evidence.kind === 'finding'
            ? (await db.query('SELECT evidence,status FROM findings WHERE node_id=$1',[evidence.id])).rows[0] : undefined;
          const observation = finding?.evidence ?? evidence.payload.evidence;
          if (typeof observation !== 'string' || !observation.trim()) throw new Error('目标证据缺少实际观察内容，请读取或补充证据后再证明');
          if(evidence.payload.observation_type==='negative')throw new Error('负面报告缺少宿主核验的目标测试范围，不能泛化为目标达成或未测方向已否定');
          if (['inferred','unknown'].includes(String(evidence.payload.observation_type)) || finding?.status === 'false_positive')
            throw new Error('推测、未知观察或已判定误报不能作为目标达成证据');
          await s.link(evidence.id, RelProves, goal.id);
          await s.setNodeState(goal.id, 'met');
        });
        const s = c.db.exploration(c.expID);
        const counts = await s.executionCounts();
        const allMet = counts.goals > 0 && counts.met >= counts.goals;
        if (allMet) c.hooks.notifyGoalMet?.(c.expID, args.goal_id);
        return { goal_id: args.goal_id, met: true, all_goals_met: allMet, goals: counts.goals, met_count: counts.met };
      },
    },
    ctx,
  );
}
