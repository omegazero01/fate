import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';
import {pendingPlannerWakeups,plannerWakeupReady} from './planner-wakeup.js';
const name=`fate_wakeup_batch_${process.pid}`;let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const p=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await p.connect();await p.query(`DROP DATABASE ${name}`);await p.end();});
it('coalesces durable publication bursts without consuming them; controls behind pagination bypass the wait',async()=>{
  const task=await db.tasks().createTaskWithOptions('LOCAL batch','LOCAL goal',{executionMode:'managed'}),exp=task.exploration_id;
  await db.query('DELETE FROM blackboard_wakeups WHERE exploration_id=$1',[exp]);
  await db.query("INSERT INTO blackboard_wakeups(exploration_id,event_key,kind) SELECT $1,'batch:'||n,CASE WHEN n%2=0 THEN 'finding_published' ELSE 'assets_changed' END FROM generate_series(1,60) n",[exp]);
  let rows=await pendingPlannerWakeups(db,exp);expect(rows).toHaveLength(50);
  const now=new Date(rows[0]!.oldest_at).getTime(),options={now,running:2,hasControl:false,heartbeatDue:false};
  expect(plannerWakeupReady(rows,options)).toBe(false);
  expect(plannerWakeupReady(rows,{...options,now:now+29999})).toBe(false);
  expect(plannerWakeupReady(rows,{...options,now:now+30000})).toBe(true);
  expect(plannerWakeupReady(rows,{...options,running:0})).toBe(true);
  expect(plannerWakeupReady(rows,{...options,hasControl:true})).toBe(true);
  expect(plannerWakeupReady(rows,{...options,heartbeatDue:true})).toBe(true);
  expect(Number((await db.query('SELECT count(*) n FROM blackboard_wakeups WHERE exploration_id=$1 AND acknowledged_at IS NULL',[exp])).rows[0]!.n)).toBe(60);
  await db.query("INSERT INTO blackboard_wakeups(exploration_id,event_key,kind) VALUES($1,'urgent','worker_settled')",[exp]);
  rows=await pendingPlannerWakeups(db,exp);expect(rows.every(r=>r.kind!=='worker_settled')).toBe(true);
  expect(plannerWakeupReady(rows,options)).toBe(true);
  await db.query("UPDATE blackboard_wakeups SET acknowledged_at=now() WHERE exploration_id=$1 AND kind='worker_settled'",[exp]);
  rows=await pendingPlannerWakeups(db,exp);expect(plannerWakeupReady(rows,options)).toBe(false);
  expect(plannerWakeupReady(rows,{...options,now:now+31000})).toBe(true); // restart does not reset age
});
