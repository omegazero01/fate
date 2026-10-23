import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {buildApp} from './app.js';
import {signJWT} from './auth.js';
import {conversationDomainTools} from '../tools/conversations.js';
import {runContext} from '../tools/context.js';
import {requireTaskGoal} from '../agent/task-goal.js';
const name=`fate_goal_required_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-goal-required-'));
let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,calls=0;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();engine=new Engine(db,defaultEngineConfig(),async()=>{calls++;throw new Error('No model expected');},dir);app=buildApp({db,engine,jwtKey:'local-goal-test-key',dataDir:dir,skillsRoot:dir,version:'test',startedAt:Date.now()});});
afterAll(async()=>{await engine.shutdown();await app.close();await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});
it.each([undefined,null,'','  ',7,{},[]])('rejects missing/invalid goal %j before creating anything',async goal=>{
 const before=(await db.query('SELECT count(*) n FROM tasks')).rows[0].n;
 const res=await app.inject({method:'POST',url:'/api/tasks',headers:{'X-Series-Token':signJWT('local-goal-test-key')},payload:{description:'Background is not an objective',goal}});
 expect(res.statusCode).toBe(400);expect(res.json().code).toBe('TASK_GOAL_REQUIRED');
 const tool=conversationDomainTools(runContext(db,0,0,'auto'),engine).find(t=>t.name==='spawn_task')!;
 const result=await tool.execute('invalid-goal',{description:'Background is not an objective',goal} as never,undefined,undefined,{} as never);
 expect(result.isError).toBe(true);expect((result.content[0] as {text:string}).text).toContain('任务描述不能代替目标');
 expect((await db.query('SELECT count(*) n FROM tasks')).rows[0].n).toBe(before);expect(calls).toBe(0);
});
it('preserves explicit goal and requires it in Auto schema',()=>{expect(requireTaskGoal('  资产测试覆盖度100%  ')).toBe('资产测试覆盖度100%');const t=conversationDomainTools(runContext(db,0,0,'auto'),engine).find(t=>t.name==='spawn_task')!;expect((t.parameters as any).required).toContain('goal');});

it('HTTP and Auto always enroll a new task in isolated Goals before admission',async()=>{
 const admission=vi.spyOn(engine,'admitTask').mockResolvedValue(false);
 try{
  const payload={description:'Background only',goal:'One explicit result'};
  const response=await app.inject({method:'POST',url:'/api/tasks',headers:{'X-Series-Token':signJWT('local-goal-test-key')},payload});expect(response.statusCode).toBe(201);
  const tool=conversationDomainTools(runContext(db,0,0,'auto'),engine).find(t=>t.name==='spawn_task')!;
  expect((await tool.execute('valid-goal',payload as never,undefined,undefined,{} as never)).isError).not.toBe(true);
  const rows=(await db.query('SELECT phase,goal FROM goals_bootstrap')).rows;expect(rows).toHaveLength(2);expect(rows.every(r=>r.phase==='constraints'&&r.goal===payload.goal)).toBe(true);expect(calls).toBe(0);
 }finally{admission.mockRestore();}
});
