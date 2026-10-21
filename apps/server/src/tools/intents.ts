// 意图工具：add_intent（唯一意图生成入口，含去重与 mainagent 直投下发）、
// dispatch_intents、kill_work / steer_work（引擎回调）、todo_write（planner 跨轮共享）。

import { domainTool } from "./define.js";
import type { ToolRunContext, TodoItem } from "./context.js";
import { KindIntent, RelDerivedFrom, nodeCancelledByUser } from "../db/exploration.js";
import { normalizeContract, type IntentContract } from '../agent/intent-contract.js';
import {workerCapabilities, validateWorkerToolNames} from '../agent/worker-capabilities.js';

interface IntentItem { summary: string; parent_id?: number|string; parent_ids?: (number|string)[]; asset_ids?: (number|string)[]; priority?: number; contract?:IntentContract; retry_of?:number;retry_kind?:string;retry_reason?:string }
interface AddIntentArgs extends Partial<IntentItem> { intents?: IntentItem[]; }
function intentIDs(values:unknown,field:string):number[]{
  if(!Array.isArray(values))throw new Error(`${field} 必须为 ID 数组`);
  return [...new Set(values.map(v=>{
    const id=typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):v;
    if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0)throw new Error(`${field} 需要有效正整数 ID`);
    return id;
  }))];
}


const intentFields = {
                summary: { type: "string", description: "用一两句话给出有价值的探索方向；具体接口、步骤和方法由 Worker 在范围内自主决定，不列逐项测试清单" },
                parent_ids: {type:"array",maxItems:20,items:{anyOf:[{type:"integer",minimum:1},{type:"string",pattern:"^[0-9]+$"}]},description:"依据的事实或漏洞节点，宿主记录实际版本"},
                parent_id: { anyOf:[{type:"integer",minimum:1},{type:"string",pattern:"^[0-9]+$"}], description: "依据的 fact/finding 节点 id（顶层可省略，自动连任务根）" },
                asset_ids: { type: "array", items: { anyOf:[{type:"integer",minimum:1},{type:"string",pattern:"^[0-9]+$"}] }, description: "业务范围或入口资产 ID，不要求预先枚举所有待发现接口；写回时再精确关联实际资产" },
                priority: { type: "integer", minimum: 0, maximum: 10, description: "省略或 0 按 5 处理" },
                contract: {type:'object',description:'可选边界补充，不要求填写细化验收表。objective/acceptance 省略时沿用 summary；work 仅在已有稳定方向标识时使用。',properties:{
                  objective:{type:'string'},acceptance:{type:'array',minItems:1,maxItems:10,items:{type:'string'}},out_of_scope:{type:'array',maxItems:20,items:{type:'string'}},
                  basis:{type:'array',description:'仅引用已读取的 fact/finding 及其实际版本，可引用任务根 fact；goal、intent 不是事实依据。',maxItems:20,items:{type:'object',properties:{node_id:{type:'integer'},version:{type:'integer',minimum:0}},required:['node_id','version']}},
                  work:{type:'object',properties:{resource:{type:'string'},question_key:{type:'string'},method_class:{type:'string'},identity:{type:'string'}},required:['resource','question_key','method_class','identity']},
                  allowed_tools:{type:'array',items:{type:'string'},maxItems:50,description:'精确工具名，见 graph_overview.worker_capabilities；HTTP GET 使用 http_request，不能编造 http_get 等别名。内部事实/进度/结果写回不受此执行工具清单限制。'},
                }},
                retry_of:{type:'integer',minimum:1},retry_kind:{type:'string',enum:['new_evidence','transient_failure']},retry_reason:{type:'string',maxLength:2000},
              };

export function addIntentTool(ctx: ToolRunContext) {
  return domainTool<AddIntentArgs>(
    {
      name: "add_intent",
      description:
        "提交 1~4 条探索意图进 frontier，worker 将按优先级领取执行。提交前逐一与 open/running 意图及" +
        "近期已完成意图比对。每条意图是一个可独立交付结论的方向，给出大致资产范围与探索价值即可，让 Worker 自主选择步骤，不按接口/参数拆单。contract.work 可选，legacy_text 仅做文本去重；dedup.related_intent_ids 表示局部交叉，需读取已有工作协调职责，不强制拆成更小单元。parent 必须是产出了证据的 fact/finding 节点" +
        "（发现驱动规划）。串行依赖链用 todo_write 记录，只派前置已满足的那一步。单条直接提供 summary/asset_ids/parent_ids/priority；批量使用 intents，每项完整填写，禁止混合两种格式。",
      promptSnippet: "派发探索意图（先查重）",
      parameters: {
        type: "object", additionalProperties:false,
        properties: {...intentFields,intents:{type:"array",maxItems:4,description:"批量 1~4 项，每项独立填写 summary、asset_ids、parent_ids、priority；不要同时提供顶层单条字段。空数组时使用顶层单条。",items:{type:"object",properties:intentFields,required:["summary"],additionalProperties:false}}},
        anyOf:[{required:["summary"]},{required:["intents"]}],
      },
      // Main's direct-intent grant must run after the intent transaction commits;
      // otherwise the host admission transaction cannot see the uncommitted node.
      transactional: false,
      async run(args, c) {
        if(args.intents!==undefined&&!Array.isArray(args.intents))throw new Error('intents 必须为数组');
        const batch=!!args.intents?.length;
        if(batch&&Object.keys(args).some(k=>k!=='intents'&&args[k as keyof AddIntentArgs]!==undefined))
          throw new Error('不能混合单条与批量参数；请把 summary/asset_ids/parent_ids/priority 等全部放入对应 intents 项，避免丢失事实依据');
        const items=batch?args.intents!:[args as IntentItem];
        if(items.length>4)throw new Error('一轮最多新增 4 条意图');
        const results = await c.db.transaction(async db => {
          await c.hooks.assertOwnership?.(db);
          const capabilities = await workerCapabilities({...c, db});
          const s = db.exploration(c.expID), originFact = await s.originFactID();
          const submitted: { summary: string; intent_id: number; created: boolean; duplicate_of?: number;dedup?:{version:3;strength:string;match?:string;related_intent_ids?:number[]} }[] = [];
          for (const item of items) {
            const explicitParents=item.parent_ids??(item.parent_id!==undefined?[item.parent_id]:[]);
            const parentIDs=intentIDs(explicitParents,'parent_ids');
            if(!parentIDs.length&&originFact>0)parentIDs.push(originFact);
            const assetIDs=intentIDs(item.asset_ids??[],'asset_ids');
            const contract=normalizeContract(item.contract,item.summary);
            validateWorkerToolNames(contract.allowed_tools, capabilities);
            for(const parentID of parentIDs){
              const parent=await s.getNode(parentID);
              if(!parent||!['fact','finding'].includes(parent.kind)||!['confirmed','origin'].includes(parent.state))throw new Error(`parent #${parentID} 必须是已提交的事实或漏洞`);
              const ref=contract.basis.find(ref=>ref.node_id===parentID);
              if(!ref)contract.basis.push({node_id:parentID,version:parent.content_version??0});
            }
            const payload: Record<string, unknown> = { summary: item.summary,contract,
              ...(item.retry_of?{retry_of:item.retry_of,retry_kind:item.retry_kind,retry_reason:item.retry_reason}:{}) };
            payload.parent_ids=parentIDs;
            if(parentIDs.length)payload.parent_id=parentIDs[0];
            if(c.role==='planner')payload.dispatch_requested=true;
            if(c.role==='mainagent'&&c.mainSegment!==undefined&&c.hooks.assertOwnership)payload.dispatch_source='mainagent';
            const res = c.role === "planner"
              ? await s.addPlannerIntentDeduplicated(payload, item.priority || 5, assetIDs, "planner")
              : await s.addIntentDeduplicated(payload, item.priority || 5, assetIDs, c.role === "worker" ? "worker" : "user");
            if(res.created)for(const ref of contract.basis)if(await s.getNode(ref.node_id))await s.link(ref.node_id,RelDerivedFrom,res.id);
            // Historical inactive proposals must pass the same fresh basis check before requeue.
            if(!res.created && c.role==='planner'){
              const previous=await s.getNode(res.id);
              const oldWork=(previous?.payload.contract as IntentContract|undefined)?.work;
              if(oldWork&&!contract.work)contract.work=oldWork;
              await db.query("UPDATE exploration_nodes SET payload=payload||$2::jsonb WHERE id=$1 AND state='open' AND payload->>'needs_replanning'='true'",[res.id,JSON.stringify({...payload,needs_replanning:false})]);
            }
            submitted.push({summary:item.summary,intent_id:res.id,created:res.created,dedup:res.dedup,...(!res.created?{duplicate_of:res.id}:{})});
          }
          return submitted;
        });
        for (const result of results) if (result.created) {
          c.hooks.notifyIntent?.(c.expID,result.intent_id);
          // The host signs a one-intent grant after the node is committed.
          if (c.role === "mainagent") await c.hooks.dispatchIntent?.(c.expID,result.intent_id);
        }
        return { submitted: results.filter((r) => r.created).length, intents: results, ids:results.map(r=>r.intent_id), errors:{}, duplicates:Object.fromEntries(results.flatMap((r,i)=>r.duplicate_of?[[i,r.duplicate_of]]:[])) };
      },
    },
    ctx,
  );
}

interface DispatchIntentsArgs { intent_ids?: number[]; }

export function dispatchIntentsTool(ctx: ToolRunContext) {
  return domainTool<DispatchIntentsArgs>(
    {
      name: "dispatch_intents",
      description:
        "把本任务待执行意图下发给 Worker；也可选择正在执行的意图订阅结果，不重复执行。仅任务主 Agent 可用；" +
        "手工执行模式下意图只有经此下发才会被执行。",
      promptSnippet: "下发待执行意图",
      parameters: {
        type: "object",
        properties: {
          intent_ids: {
            type: "array",
            items: { type: "integer" },
            maxItems: 10,
            description: "要下发或订阅的意图 id；省略则下发全部 open 意图",
          },
        },
      },
      transactional:false,
      async run(args, c) {
        if (c.role !== "mainagent") throw new Error("仅任务主 Agent 可以下发意图");
        const s = c.db.exploration(c.expID);
        let ids = args.intent_ids ?? [];
        if (ids.length === 0) {
          const open = await s.frontier(50);
          ids = open.map((n) => n.id);
        }
        let dispatched = 0;
        for (const id of ids) {
          const n = await s.getNode(id);
          if (!n || n.kind !== KindIntent || !["open", "running"].includes(n.state) || nodeCancelledByUser(n)) continue;
          if (!c.hooks.dispatchIntent) throw new Error("当前运行环境不支持下发意图");
          await c.hooks.dispatchIntent(c.expID, id);
          dispatched++;
        }
        return { dispatched };
      },
    },
    ctx,
  );
}

interface KillWorkArgs { intent_id: number; reason: string; }

export function killWorkTool(ctx: ToolRunContext) {
  return domainTool<KillWorkArgs>(
    {
      name: "kill_work",
      description:
        "终止一条在跑（或卡住的）意图。用于明显无效/重复/越界的方向——先看 get_worker_trace 确认实际进度再杀。",
      promptSnippet: "终止在跑意图",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer" },
          reason: { type: "string", description: "终止原因（审计留痕）" },
        },
        required: ["intent_id", "reason"],
      },
      transactional:false,
      async run(args, c) {
        if (!c.hooks.killWork) throw new Error("当前运行环境不支持 kill_work");
        await c.hooks.killWork(c.expID, args.intent_id, args.reason,c.role);
        return { killed: args.intent_id };
      },
    },
    ctx,
  );
}

interface SteerWorkArgs { intent_id: number; message: string; }

export function steerWorkTool(ctx: ToolRunContext) {
  return domainTool<SteerWorkArgs>(
    {
      name: "steer_work",
      description:
        "通过 pi steering 向运行意图追加纠偏，在当前工具回合完成后的模型边界交付，不阻断检查点或结果提交。" +
        "用于运行中调整打法、补充约束、纠正方向。",
      promptSnippet: "运行中纠偏（不打断）",
      parameters: {
        type: "object",
        properties: {
          intent_id: { type: "integer" },
          message: { type: "string", description: "给该 worker 的指令" },
        },
        required: ["intent_id", "message"],
      },
      transactional:false,
      async run(args, c) {
        if (!c.hooks.steerWork) throw new Error("当前运行环境不支持 steer_work");
        await c.hooks.steerWork(c.expID, args.intent_id, args.message,c.role);
        return { steered: args.intent_id };
      },
    },
    ctx,
  );
}

interface TodoWriteArgs { todos: TodoItem[]; }

export function todoWriteTool(ctx: ToolRunContext) {
  return domainTool<TodoWriteArgs>(
    {
      name: "todo_write",
      description:
        "维护本任务的攻击链待办清单（跨规划轮保留）。规则：串行利用链逐条记录；每轮只对【前置已完成、" +
        "依赖的 fact 已存在】的下一步派意图；已由 fact 满足的步骤标记 completed；不要重复派 pending/" +
        "in_progress 的步骤。",
      promptSnippet: "更新攻击链待办（跨轮共享）",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: 50,
            description: "完整待办列表（整体替换）",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      async run(args, c) {
        if (!c.todos) throw new Error("todo_write 仅 planner 可用");
        await c.todos.set(c.expID, args.todos as TodoItem[]);
        return { saved: args.todos.length };
      },
    },
    ctx,
  );
}
