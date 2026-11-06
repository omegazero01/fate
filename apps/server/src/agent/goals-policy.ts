import type {GoalsPhase} from '../db/goals-bootstrap.js';
export const GOALS_STAGE_TOOLS={constraints:['set_constraints','register_user_target'],objectives:['set_goals'],combined:['set_constraints','register_user_target','set_goals']} as const;
export const GOALS_STAGE_PROTOCOL:Record<GoalsPhase,string>={
 combined:'一个 Goals 会话依次完成：先从目标与描述提取明确操作约束，再登记明确目标资产，最后用 set_goals 保存目标栏要求的最终结果。目标与描述同时可见，但描述仅用于背景、约束和资产，不产生额外验收目标。没有约束或资产无需调用对应工具；保存失败必须纠正，不能跳过。每条目标的 source_quote 引用目标栏原文。目标保存成功立即结束。',
 constraints:'当前只执行阶段一：从目标与描述原文摘录明确操作约束、登记明确测试资产。描述中的架构分析、接口梳理、漏洞挖掘等背景不得转为目标。没有约束或资产时无需调用对应工具。不得拆解或保存目标；所有必要保存成功后简短结束。',
 objectives:'当前只执行阶段二：唯一目标来源为本轮【目标栏原文】。只用 set_goals 保存其中明确要求的最终结果；source_quote 必须逐字引用目标栏。一个最终结果只保留一个目标，仅多个相互独立的结果才拆分。不增加漏洞数量、严重性、报告交付物或操作步骤，不猜测未提供的背景。任务资产由宿主关联，无需补写地址。成功保存后立即结束。',
};

export function goalsStageVariables(goal:string,description:string,phase:GoalsPhase){
 const background=phase!=='objectives'?description:'';
 return {Goal:goal,Description:background,EngagementDescription:background};
}
