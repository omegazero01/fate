// 目标与约束工具：set_goals（目标分解/mainagent 追加）、set_constraints（操作边界）、
// register_user_target（显式授权登记）。

import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { RelSpawns } from "../db/exploration.js";
import {CONSTRAINT_TOOL_DESCRIPTION,groundConstraint,type ConstraintInput} from '../agent/constraint-policy.js';

interface SetGoalsArgs { goals: { text: string; vulnclass?: string }[]; }

export function setGoalsTool(ctx: ToolRunContext) {
  return domainTool<SetGoalsArgs>(
    {
      name: "set_goals",
      description:
        "登记任务的可验证最终目标（主 Agent 追加；初始分解阶段替换）。目标 = 可独立核验的交付物（拿到什么权限/证明什么漏洞/" +
        "覆盖什么范围）；信息收集、漏洞验证过程、攻击步骤都不是目标。每个目标给漏洞类别便于归类。",
      promptSnippet: "设定/替换任务目标",
      parameters: {
        type: "object",
        properties: {
          goals: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "目标描述（自包含、可验证）" },
                vulnclass: { type: "string", description: "关联漏洞类别（可选）" },
              },
              required: ["text"],
            },
          },
        },
        required: ["goals"],
      },
      // Notify the running scheduler only after the replacement/append is committed.
      transactional: false,
      async run(args, c) {
        const ids = await c.db.transaction(async db=>{
          await c.hooks.assertOwnership?.(db);
          const s=db.exploration(c.expID),originFact=await s.originFactID();
          if(c.role==='goals')for(const g of await s.listByKind('goal',100))await s.deleteGoal(g.id);
          const created:number[]=[];
          for(const g of args.goals){
            const id=await s.addGoal({text:g.text,...(g.vulnclass?{vulnclass:g.vulnclass}:{})},c.role==='goals'?'goals':'user');
            if(originFact>0)await s.link(originFact,RelSpawns,id);created.push(id);
          }
          return created;
        });
        if (c.role === "mainagent") await c.hooks.goalsChanged?.(c.expID);
        return { goals: ids };
      },
    },
    ctx,
  );
}

interface SetConstraintsArgs { replace?: boolean; constraints: ConstraintInput[]; }

export function setConstraintsTool(ctx: ToolRunContext) {
  return domainTool<SetConstraintsArgs>(
    {
      name: "set_constraints",
      description: CONSTRAINT_TOOL_DESCRIPTION,
      promptSnippet: "登记操作约束（allow/deny）",
      parameters: {
        type: "object",
        properties: {
          replace: { type: "boolean", description: "默认追加。仅当用户明确要求整体替换现有约束时设为 true。" },
          constraints: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["allow", "deny"] },
                text: { type: "string", description: "完整原文段落，不改写；保留列表及例外" },
                source_quote: { type: "string", description: "与 text 相同的用户原文段落；旧调用可省略，但 text 仍须通过原文核对" },
              },
              required: ["kind", "text"],
            },
          },
        },
        required: ["constraints"],
      },
      transactional: false,
      async run(args, c) {
        if(c.role!=='goals'&&c.role!=='mainagent')throw new Error('只有 Goals 或处理用户请求的 Main 可以提取操作约束');
        if(args.replace&&c.role!=='mainagent')throw new Error('Goals 只能追加用户原文要求，不能替换已有约束');
        const ids=await c.db.transaction(async tx=>{
          await c.hooks.assertOwnership?.(tx);
          await tx.query("SELECT pg_advisory_xact_lock($1)", [c.expID]);
          const task=await tx.tasks().getTask(c.taskID);
          if(!task||task.exploration_id!==c.expID)throw new Error('约束所属任务不匹配');
          const sources=c.role==='goals'?{goal:task.goal,description:task.description}:{user_message:c.userMessage};
          // Validate the whole batch before replacement; an invalid call leaves existing rules intact.
          const grounded=args.constraints.map(k=>groundConstraint(k,sources));
          if(args.replace&&!grounded.length)throw new Error('不能通过空模型提取删除全部约束；请使用用户约束管理入口');
          if (args.replace) await tx.query(`DELETE FROM task_constraints WHERE exploration_id=$1`, [c.expID]);
          const saved:number[]=[];
          for (const k of grounded) {
            const row=await tx.query(`INSERT INTO task_constraints(exploration_id,kind,text,origin,source)
              SELECT $1,$2,$3,$4,$5::jsonb WHERE NOT EXISTS (SELECT 1 FROM task_constraints WHERE exploration_id=$1 AND kind=$2 AND text=$3) RETURNING id`,
              [c.expID,k.kind,k.text,c.role,JSON.stringify(k.source)]);
            if(row.rows[0])saved.push(Number(row.rows[0].id));
          }
          return saved;
        });
        if(ids.length)c.hooks.constraintsChanged?.(c.expID);
        return { saved: ids.length, ids, source_verified:true };
      },
    },
    ctx,
  );
}

export async function loadConstraints(db: ToolRunContext["db"], expID: number): Promise<{ kind: string; text: string }[]> {
  const res = await db.query<{ kind: string; text: string }>(
    `SELECT kind, text FROM task_constraints WHERE exploration_id=$1 ORDER BY id`,
    [expID],
  );
  return res.rows;
}

interface RegisterTargetArgs { kind: "root_domain" | "subdomain" | "ip" | "cidr"; value: string; evidence: string; }

export function registerUserTargetTool(ctx: ToolRunContext) {
  return domainTool<RegisterTargetArgs>(
    {
      name: "register_user_target",
      description:
        "登记用户明确授权的测试目标（显式授权边界）。只登记原文明确授权的资产：要求任务描述中有完整授权语句" +
        "作为 evidence；只登记精确主机或原文明示的通配域/CIDR；不把子域缩成根域；示例/参考/禁止目标一律不登记。",
      promptSnippet: "登记用户明确授权的目标",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["root_domain", "subdomain", "ip", "cidr"], description: "目标类型" },
          value: { type: "string", description: "授权的目标值（原文出现的形式）" },
          evidence: { type: "string", description: "任务描述中的完整授权语句原文" },
        },
        required: ["kind", "value", "evidence"],
      },
      async run(args, c) {
        if (!args.evidence.trim()) throw new Error("必须提供任务描述中的授权语句原文");
        await c.db.taskScope().addAgentScope(c.taskID, args.kind, args.value, args.evidence, "manual");
        return { registered: true, kind: args.kind, value: args.value };
      },
    },
    ctx,
  );
}
