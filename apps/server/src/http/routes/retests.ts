import {RETESTER_RETIRED,RETESTER_RETIRED_MESSAGE} from '../../agent/retired-roles.js';
import type {FastifyInstance} from 'fastify';
export function registerRetestRoutes(app:FastifyInstance){
 const db=app.db;
 app.get('/api/exploration/findings/:id/retests',async req=>({retests:(await db.query('SELECT * FROM finding_retests WHERE finding_id=$1 AND finding_readable(finding_id) ORDER BY id DESC',[Number((req.params as {id:string}).id)])).rows}));
 app.get('/api/exploration/findings/retests/active',async()=>({retests:(await db.query("SELECT id,finding_id,conversation_id,status FROM finding_retests WHERE status IN ('pending','running') AND finding_readable(finding_id) ORDER BY id")).rows}));
 app.post('/api/exploration/findings/:id/retests',async (_req,reply)=>reply.code(410).send({error:RETESTER_RETIRED_MESSAGE,code:RETESTER_RETIRED}));
}
