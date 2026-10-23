import type {GoalsPhase} from '../db/goals-bootstrap.js';
export const GOALS_STAGE_TOOLS={constraints:['set_constraints','register_user_target'],objectives:['set_goals']} as const;
export const GOALS_STAGE_PROTOCOL:Record<GoalsPhase,string>={
 constraints:'当前只执行阶段一：从目标与描述原文摘录明确操作约束、登记明确测试资产。描述中的架构分析、接口梳理、漏洞挖掘等背景不得转为目标。没有约束或资产时无需调用对应工具。不得拆解或保存目标；所有必要保存成功后简短结束。',
 objectives:'当前只执行阶段二：唯一目标来源为本轮【目标栏原文】。只用 set_goals 保存其中明确要求的最终结果；source_quote 必须逐字引用目标栏。一个最终结果只保留一个目标，仅多个相互独立的结果才拆分。不增加漏洞数量、严重性、报告交付物或操作步骤，不猜测未提供的背景。任务资产由宿主关联，无需补写地址。成功保存后立即结束。',
};

export function goalsStageVariables(goal:string,description:string,phase:GoalsPhase){
 const background=phase==='constraints'?description:'';
 return {Goal:goal,Description:background,EngagementDescription:background};
}
