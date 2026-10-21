import type {FastifyInstance} from 'fastify';
import {readOperations,resolveOperation} from '../../db/operation-journal.js';
import {runContext} from '../../tools/context.js';

/** Uses the app's existing authenticated task API. No read or resolution starts execution. */
export function registerOperationRoutes(app:FastifyInstance){
  app.get('/api/tasks/:id/operations',async(req,reply)=>{
    const task=await app.db.tasks().getTask(Number((req.params as {id:string}).id));
    if(!task)return reply.code(404).send({error:'task not found'});
    const q=req.query as Record<string,string>;
    return readOperations(runContext(app.db,task.id,task.exploration_id,'mainagent'),{
      intent_id:q.intent_id?Number(q.intent_id):undefined,id:q.operation_id?Number(q.operation_id):undefined,
      after:q.cursor?Number(q.cursor):undefined,limit:q.limit?Number(q.limit):undefined});
  });
  app.post('/api/tasks/:id/operations/:operationID/resolve',async(req,reply)=>{
    const p=req.params as {id:string;operationID:string},b=req.body as Record<string,unknown>;
    if(!b||!['confirmed','retry_allowed'].includes(String(b.outcome))||typeof b.reason!=='string')
      return reply.code(400).send({error:'需要 outcome=confirmed/retry_allowed 和 reason'});
    try{return await resolveOperation(app.db,Number(p.id),Number(p.operationID),b.outcome as 'confirmed'|'retry_allowed',b.reason,'authenticated_operator');}
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:String(error)});}
  });
}
