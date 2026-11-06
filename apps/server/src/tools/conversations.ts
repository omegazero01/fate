import {archiveReport,prepareReproduction,attachStepTraffic,reportSections,assembleReport,reproductionSchema} from '../evidence/reproduction.js';
import {requireTaskGoal} from "../agent/task-goal.js";
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import type {Engine} from '../engine/engine.js';
import {findingEvidence} from '../evidence/store.js';
export function conversationDomainTools(ctx:ToolRunContext,engine:Pick<Engine,'admitTask'|'pause'|'notify'>,options:{profileID?:number;pendingReports?:Set<number>;onSaved?:()=>void}={}){
 const tools:ToolDefinition[]=[],role=ctx.role,taskID=ctx.taskID,id=ctx.conversationID??0,profileID=options.profileID??0;
 const reads=new Map<number,{evidence:number;revision:number;ranges:Array<[number,number]>;total:number;complete:boolean}>();
 const pendingReports=options.pendingReports??new Set<number>(),onSaved=options.onSaved??(()=>{});
   if(role==='auto'){
    const make=(name:string,description:string,properties:Record<string,unknown>,run:(a:Record<string,unknown>)=>Promise<Record<string,unknown>>,required:string[]=[])=>domainTool({name,description,transactional:false,parameters:{type:'object',properties,required},run},ctx);
    tools.push(make('list_tasks','分页列出平台任务',{after_id:{type:'integer'}},async a=>({tasks:(await ctx.db.query('SELECT id,name,goal,status,paused,queued FROM tasks WHERE deleted_at IS NULL AND id>$1 ORDER BY id LIMIT 10',[Number(a.after_id)||0])).rows})),
     make('get_task','查询任务状态',{task_id:{type:'integer'}},async a=>({task:await ctx.db.tasks().getTask(Number(a.task_id))}),['task_id']),
     make('list_llm_profiles','列出可选模型，不返回密钥',{},async()=>({profiles:(await ctx.db.platform().listProfiles()).map(p=>({id:p.id,name:p.name,model:p.model}))})),
     make('spawn_task','按用户目标创建并启动任务',{description:{type:'string'},goal:{type:'string'},asset_ids:{type:'array',items:{type:'integer'}},company_ids:{type:'array',items:{type:'integer'}},execution_mode:{type:'string',enum:['managed','manual']},source_task_ids:{type:'array',items:{type:'integer'}},llm_profile_id:{type:'integer'},seed_first_intent:{type:'boolean'}},async a=>{
      const goal=requireTaskGoal(a.goal);
      const profile=Number(a.llm_profile_id)||profileID||0;
      const t=await ctx.db.tasks().createTaskWithOptions(String(a.description),goal,{initializeGoals:true,companyIDs:a.company_ids as number[]|undefined,executionMode:a.execution_mode==='manual'?'manual':'managed',assetIDs:a.asset_ids as number[]|undefined,sourceTaskIDs:a.source_task_ids as number[]|undefined,llmProfileIDs:profile?[profile]:[],seedFirstIntent:a.seed_first_intent===true});
      await ctx.db.query('UPDATE tasks SET parent_ref=$2 WHERE id=$1',[t.id,`conversation:${id}`]);await engine.admitTask(t.id,{decompose:{description:t.description}});return {task:t};
     },['description','goal']),
     make('pause_task','暂停指定任务',{task_id:{type:'integer'}},async a=>{const n=Number(a.task_id);await ctx.db.tasks().applyTaskPause(n);const result=await engine.pause(n);return {task_id:n,status:result.status,command_id:result.command_id};},['task_id']),
     make('resume_task','恢复指定任务并返回实际准入状态',{task_id:{type:'integer'}},async a=>{const n=Number(a.task_id);await engine.admitTask(n);return {task:await ctx.db.tasks().getTask(n)};},['task_id']),
     make('add_task_hint','追加任务提示',{task_id:{type:'integer'},message:{type:'string'}},async a=>{const n=Number(a.task_id),t=await ctx.db.tasks().getTask(n);if(!t)throw new Error('任务不存在');const node=await ctx.db.exploration(t.exploration_id).addNode('hint',{text:String(a.message),source:'user_request',conversation_id:id},0,'open','auto',[]);engine.notify(n);await ctx.db.query("WITH saved AS (INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id) VALUES($1,$2,'control_changed',$3) ON CONFLICT DO NOTHING RETURNING id) UPDATE explorations SET published_revision=published_revision+1 WHERE id=$1 AND EXISTS(SELECT 1 FROM saved)",[t.exploration_id,`hint:${node}`,node]);return {saved:true,node_id:node};},['task_id','message']));
   }
   if(['reporter','auto'].includes(role)){
     tools.push(domainTool<{finding_id:number;offset?:number}>({name:'get_finding',description:'读取漏洞、证据版本及绑定；报告正文使用 offset 续读。',readOnly:true,parameters:{type:'object',properties:{finding_id:{type:'integer'},offset:{type:'integer',minimum:0}},required:['finding_id']},async run(a,c){
     const f=(await c.db.query('SELECT * FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id)',[a.finding_id,taskID])).rows[0];if(!f)throw new Error('漏洞不存在或未获当前任务授权');if(role==='reporter'&&(!f.report||f.report_evidence_version==null||Number(f.report_evidence_version)!==Number(f.evidence_version)))pendingReports.add(Number(f.id));
     const body=Array.from(JSON.stringify(f)),off=Math.max(0,a.offset??0),end=Math.min(body.length,off+1500);
     const prior=reads.get(Number(f.id));
     const read=prior&&prior.evidence===Number(f.evidence_version)&&prior.revision===Number(f.report_revision)?prior:{evidence:Number(f.evidence_version),revision:Number(f.report_revision),ranges:[] as Array<[number,number]>,total:body.length,complete:false};
     read.ranges.push([Math.min(off,body.length),end]);read.ranges.sort((x,y)=>x[0]-y[0]);let covered=0;for(const [start,stop] of read.ranges){if(start>covered)break;covered=Math.max(covered,stop);}read.complete=covered>=body.length;reads.set(Number(f.id),read);
     return {finding_id:Number(f.id),evidence_version:Number(f.evidence_version),report_revision:Number(f.report_revision),read_complete:read.complete,content:body.slice(off,off+1500).join(''),next_offset:off+1500<body.length?off+1500:null,evidence:await findingEvidence(c.db,a.finding_id)};
    }},ctx) as never,domainTool<{finding_id:number;evidence_version:number;report?:string;report_revision?:number;report_sections?:unknown;reproduction?:unknown}>({name:'update_finding_report',transactional:false,description:'先读完漏洞证据，再带版本提交 report_sections 或兼容的非空 report。',parameters:{
      type:'object',
      properties:{
        finding_id:{type:'integer',minimum:1},
        evidence_version:{type:'integer',minimum:0},
        report:{type:'string',pattern:'\\S',description:'仅兼容旧报告；优先提交 report_sections'},
        report_revision:{type:'integer',minimum:0,description:'get_finding 返回的报告版本；旧调用省略时使用本会话读取的版本'},
        report_sections:{
          type:'object',
          properties:{description:{type:'string',pattern:'\\S'},impact:{type:'array',items:{type:'string'}},remediation:{type:'array',items:{type:'string'}}},
          required:['description','impact','remediation'],
          additionalProperties:false,
        },
        reproduction:reproductionSchema,
      },
      required:['finding_id','evidence_version'],
      anyOf:[{required:['report_sections']},{required:['report']}],
    },async run(a,c){
     const sections=a.report_sections?reportSections(a.report_sections):null;
     if(sections ? !sections.description.trim() : !a.report?.trim())
       throw new Error('需要非空 report_sections.description 或兼容的非空 report');
     const saved=await c.db.transaction(async db=>{await c.hooks.assertOwnership?.(db);c={...c,db};
     const seen=reads.get(a.finding_id);
     if(!seen)throw new Error('必须先 get_finding 读取证据及报告版本');
     if(!seen.complete)throw new Error('漏洞内容尚未读完，请按 get_finding 的 next_offset 续读；分段预览不等于全文已读');
     const f=(await c.db.query('SELECT * FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id) FOR UPDATE',[a.finding_id,taskID])).rows[0];
     if(!f||Number(f.evidence_version)!==a.evidence_version||Number(f.report_revision)!==(a.report_revision??seen.revision)||seen.evidence!==a.evidence_version)throw new Error('证据或报告版本已变化，请重新读取');
     await archiveReport(c.db,f);
     const repro=a.reproduction===undefined?(f.reproduction as import('../evidence/reproduction.js').Reproduction|null):await prepareReproduction(c.db,a.reproduction,{taskID:Number(f.task_id),evidence:String(f.evidence),findingNodeID:Number(f.node_id)},true);
     if(a.reproduction!==undefined)await attachStepTraffic(c.db,a.finding_id,Number(f.task_id),repro);
     const version=Number((await c.db.query('SELECT evidence_version FROM findings WHERE id=$1',[a.finding_id])).rows[0]!.evidence_version);
     const report=sections?assembleReport({...f,report_sections:sections,reproduction:repro,report_evidence_version:version,evidence_version:version}):a.report!;
     await c.db.query('UPDATE findings SET report=$2,report_sections=$3,reproduction=$4,report_evidence_version=$5,report_revision=report_revision+1 WHERE id=$1',[a.finding_id,report,sections,repro,version]);
     return {saved:true};
     });pendingReports.delete(a.finding_id);onSaved();return saved;
    }},ctx) as never);
   }

 return tools;
}
