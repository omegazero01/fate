import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {domainTool} from './define.js';
import type {ToolRunContext} from './context.js';
import type {Engine} from '../engine/engine.js';
import {findingEvidence} from '../evidence/store.js';
export function conversationDomainTools(ctx:ToolRunContext,engine:Pick<Engine,'admitTask'|'pause'|'notify'>,options:{profileID?:number;pendingReports?:Set<number>;onSaved?:()=>void}={}){
 const tools:ToolDefinition[]=[],role=ctx.role,taskID=ctx.taskID,id=ctx.conversationID??0,profileID=options.profileID??0;
 const pendingReports=options.pendingReports??new Set<number>(),onSaved=options.onSaved??(()=>{});
   if(role==='auto'){
    const make=(name:string,description:string,properties:Record<string,unknown>,run:(a:Record<string,unknown>)=>Promise<Record<string,unknown>>,required:string[]=[])=>domainTool({name,description,transactional:false,parameters:{type:'object',properties,required},run},ctx);
    tools.push(make('list_tasks','分页列出平台任务',{after_id:{type:'integer'}},async a=>({tasks:(await ctx.db.query('SELECT id,name,goal,status,paused,queued FROM tasks WHERE deleted_at IS NULL AND id>$1 ORDER BY id LIMIT 10',[Number(a.after_id)||0])).rows})),
     make('get_task','查询任务状态',{task_id:{type:'integer'}},async a=>({task:await ctx.db.tasks().getTask(Number(a.task_id))}),['task_id']),
     make('list_llm_profiles','列出可选模型，不返回密钥',{},async()=>({profiles:(await ctx.db.platform().listProfiles()).map(p=>({id:p.id,name:p.name,model:p.model}))})),
     make('spawn_task','按用户目标创建并启动任务',{description:{type:'string'},goal:{type:'string'},asset_ids:{type:'array',items:{type:'integer'}},company_ids:{type:'array',items:{type:'integer'}},execution_mode:{type:'string',enum:['managed','manual']},source_task_ids:{type:'array',items:{type:'integer'}},llm_profile_id:{type:'integer'},seed_first_intent:{type:'boolean'}},async a=>{
      const profile=Number(a.llm_profile_id)||profileID||0;
      const t=await ctx.db.tasks().createTaskWithOptions(String(a.description),String(a.goal??a.description),{companyIDs:a.company_ids as number[]|undefined,executionMode:a.execution_mode==='manual'?'manual':'managed',assetIDs:a.asset_ids as number[]|undefined,sourceTaskIDs:a.source_task_ids as number[]|undefined,llmProfileIDs:profile?[profile]:[],seedFirstIntent:a.seed_first_intent===true});
      await ctx.db.query('UPDATE tasks SET parent_ref=$2 WHERE id=$1',[t.id,`conversation:${id}`]);await engine.admitTask(t.id,{decompose:{description:t.description}});return {task:t};
     },['description']),
     make('pause_task','暂停指定任务',{task_id:{type:'integer'}},async a=>{const n=Number(a.task_id);await ctx.db.tasks().applyTaskPause(n);const result=await engine.pause(n);return {task_id:n,status:result.status,command_id:result.command_id};},['task_id']),
     make('resume_task','恢复指定任务并返回实际准入状态',{task_id:{type:'integer'}},async a=>{const n=Number(a.task_id);await engine.admitTask(n);return {task:await ctx.db.tasks().getTask(n)};},['task_id']),
     make('add_task_hint','追加任务提示',{task_id:{type:'integer'},message:{type:'string'}},async a=>{const n=Number(a.task_id),t=await ctx.db.tasks().getTask(n);if(!t)throw new Error('任务不存在');const node=await ctx.db.exploration(t.exploration_id).addNode('hint',{text:String(a.message),source:'user_request',conversation_id:id},0,'open','auto',[]);engine.notify(n);await ctx.db.query("WITH saved AS (INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id) VALUES($1,$2,'control_changed',$3) ON CONFLICT DO NOTHING RETURNING id) UPDATE explorations SET published_revision=published_revision+1 WHERE id=$1 AND EXISTS(SELECT 1 FROM saved)",[t.exploration_id,`hint:${node}`,node]);return {saved:true,node_id:node};},['task_id','message']));
   }
   if(['reporter','auto'].includes(role)){
     tools.push(domainTool<{finding_id:number;offset?:number}>({name:'get_finding',description:'读取漏洞、证据版本及绑定；报告正文使用 offset 续读。',readOnly:true,parameters:{type:'object',properties:{finding_id:{type:'integer'},offset:{type:'integer',minimum:0}},required:['finding_id']},async run(a,c){
     const f=(await c.db.query('SELECT * FROM findings WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND finding_readable(id)',[a.finding_id,taskID])).rows[0];if(!f)throw new Error('漏洞不存在或未获当前任务授权');if(role==='reporter'&&(!f.report||f.report_evidence_version==null||Number(f.report_evidence_version)!==Number(f.evidence_version)))pendingReports.add(Number(f.id));
     const body=JSON.stringify(f),off=Math.max(0,a.offset??0);
     return {finding_id:Number(f.id),evidence_version:Number(f.evidence_version),content:body.slice(off,off+1500),next_offset:off+1500<body.length?off+1500:null,evidence:await findingEvidence(c.db,a.finding_id)};
    }},ctx) as never,domainTool<{finding_id:number;evidence_version:number;report:string}>({name:'update_finding_report',description:'仅在证据版本一致时更新漏洞报告；冲突后重新读取证据。',parameters:{type:'object',properties:{finding_id:{type:'integer'},evidence_version:{type:'integer'},report:{type:'string'}},required:['finding_id','evidence_version','report']},async run(a,c){
     const r=await c.db.query('UPDATE findings SET report=$3,report_evidence_version=$4 WHERE id=$1 AND ($2::bigint=0 OR task_id=$2) AND evidence_version=$4 AND finding_readable(id) RETURNING id',[a.finding_id,taskID,a.report,a.evidence_version]);if(!r.rowCount)throw new Error('证据版本已变化或漏洞不可用，请重新读取');pendingReports.delete(a.finding_id);onSaved();return {saved:true};
    }},ctx) as never);
   }

 return tools;
}
