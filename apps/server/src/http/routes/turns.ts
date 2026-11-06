import type {FastifyInstance} from 'fastify';
import {conversationReadable} from '../activity-stream.js';
import {readTurnSummaries,readTurnModelName} from '../../engine/turn-summary.js';

export function registerTurnRoutes(app:FastifyInstance){
 for(const scope of ['tasks','conversations'] as const)app.get(`/api/${scope}/:id/turns`,async(req,reply)=>{
  const id=Number((req.params as {id:string}).id);
  const q=req.query as Record<string,string|undefined>;
  const ids=[...new Set(String(q.ids??'').split(',').filter(Boolean))];
  if(!Number.isSafeInteger(id)||id<1||!ids.length||ids.length>100||ids.some(s=>s.length>240||!/^[\w:-]+$/.test(s)))return reply.code(400).send({error:'需要有效范围及最多 100 个 turn_id'});
  const task=scope==='tasks'?await app.db.tasks().getTask(id):null;
  if(scope==='tasks'?!task:!await conversationReadable(app.db,id))return reply.code(404).send({error:'会话或任务不存在'});
  const integer=(key:string)=>q[key]===undefined?0:/^\d+$/.test(q[key]!)&&Number.isSafeInteger(Number(q[key]))&&Number(q[key])<=2147483646?Number(q[key]):NaN;
  const offset=integer('models_offset'),nameIndex=integer('name_index'),nameOffset=integer('name_offset');
  if(![offset,nameIndex,nameOffset].every(Number.isFinite)||q.models_offset!==undefined&&ids.length!==1||q.name_index!==undefined&&ids.length!==1||q.data_revision!==undefined&&!/^\d{1,40}$/.test(q.data_revision))return reply.code(400).send({error:'续读需要单个轮次和有效位置、版本'});
  const domain=scope==='tasks'?'task':'conversation',activityID=task?.exploration_id??id;
  if(q.name_index!==undefined){
   if(!q.data_revision)return reply.code(400).send({error:'名称续读需要 data_revision'});
   return {name:await readTurnModelName(app.db,domain,activityID,ids[0]!,nameIndex,nameOffset,q.data_revision)};
  }
  const items=await readTurnSummaries(app.db,domain,activityID,ids,offset);
  if(q.data_revision&&items.some(s=>s.data_revision!==q.data_revision))return reply.code(409).send({error:'本轮记录已变化，请重新打开详情'});
  return {items};
 });
}
