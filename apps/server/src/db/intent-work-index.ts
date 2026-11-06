import {createHash} from 'node:crypto';
import {normalizeContract} from '../agent/intent-contract.js';
import {workIdentity,storedWorkIdentity,directionIdentity,type WorkAsset,type WorkKey} from '../agent/work-identity.js';
import type {Database} from './index.js';
import type {QueueTx} from './exploration.js';

type Queryable=Pick<QueueTx,'query'>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function workIndexKeys(identity:WorkKey,summary:string){
  return {identity_key:identity.key,family:identity.family,resource_hash:hash(identity.resource),
    target_hashes:identity.targets.map(hash),prose_key:hash([directionIdentity(summary),identity.targets])};
}
export async function workAssets(tx:Queryable,ids:Iterable<number>,lock=false):Promise<Map<number,WorkAsset>>{
  const unique=[...new Set(ids)];if(!unique.length)return new Map();
  // During publication, fence even the *first* index build: its dependency rows
  // do not exist yet, so an asset trigger alone cannot invalidate that snapshot.
  const rows=(await tx.query(`SELECT id,type,url,method,domain,ip,port FROM assets WHERE id=ANY($1::bigint[]) ORDER BY id${lock?' FOR SHARE':''}`,[unique])).rows;
  return new Map(rows.map(a=>[Number(a.id),{...a,id:Number(a.id),type:String(a.type)} as WorkAsset]));
}
export function workResourceAsset(contract:unknown):number[]{
  const match=/^asset:([1-9][0-9]*)$/.exec(String((contract as {work?:{resource?:string}}|undefined)?.work?.resource??''));
  return match?[Number(match[1])]:[];
}

/** Called under the same exploration queue lock as dispatch. Project only
 * identity inputs in pages; evidence/progress/result bodies are never loaded.
 * Invalid legacy contracts are recorded, not guessed or rewritten at startup. */
export async function indexIntentWorkBatch(tx:Queryable,expID:number,limit=128):Promise<number>{
  const rows=(await tx.query(`SELECT n.id,d.revision,
    jsonb_build_object('summary',n.payload->'summary','contract_present',n.payload ? 'contract','contract',n.payload->'contract','work_identity',n.payload->'work_identity',
      'dispatch_asset_ids',n.payload->'dispatch_asset_ids','asset_ids',n.payload->'asset_ids') payload,
    ARRAY(SELECT asset_id FROM exploration_anchors WHERE node_id=n.id ORDER BY asset_id) anchors
    FROM intent_work_dirty d JOIN exploration_nodes n ON n.id=d.intent_id
    WHERE d.exploration_id=$1 AND n.kind='intent' ORDER BY n.id LIMIT $2 FOR NO KEY UPDATE OF n`,[expID,limit])).rows;
  if(!rows.length)return 0;
  const inputs=rows.map(row=>{
    const p=row.payload as Record<string,unknown>,stored=storedWorkIdentity(p.work_identity);
    const anchors=p.dispatch_asset_ids??p.asset_ids??(row.anchors as string[]).map(Number);
    const ids=Array.isArray(anchors)?anchors.map(Number):[];
    return {row,p,stored,anchors,ids,resources:workResourceAsset(p.contract)};
  });
  const assets=await workAssets(tx,inputs.filter(i=>!i.stored).flatMap(i=>[...i.ids,...i.resources]),true);
  const data=inputs.map(({row,p,stored,anchors,ids,resources})=>{
    const summary=String(p.summary??'');
    const base={intent_id:Number(row.id),exploration_id:expID,revision:String(row.revision),
      has_work:!!(p.contract as {work?:unknown}|undefined)?.work,dynamic_assets:!stored,
      uses_graph_anchors:!stored&&p.dispatch_asset_ids==null&&p.asset_ids==null,asset_ids:!stored?[...new Set([...ids,...resources])].filter(id=>assets.has(id)):[]};
    try{
      if(!stored&&(!Array.isArray(anchors)||ids.some(id=>!Number.isSafeInteger(id)||id<=0)))throw new Error('旧资产引用不是有效 ID 列表');
      const contract=p.contract_present?p.contract:undefined;
      const identity=stored??workIdentity(normalizeContract(contract,summary),summary,anchors as number[],assets);
      return {...base,...workIndexKeys(identity,summary),strength:identity.strength,error:null};
    }catch(error){return {...base,error:String(error instanceof Error?error.message:error).slice(0,500)};}
  });
  await tx.query(`INSERT INTO intent_work_index(intent_id,exploration_id,identity_key,family,resource_hash,target_hashes,prose_key,has_work,strength,dynamic_assets,uses_graph_anchors,error)
    SELECT intent_id,exploration_id,identity_key,family,resource_hash,COALESCE(target_hashes,'{}'),prose_key,has_work,strength,dynamic_assets,uses_graph_anchors,error
    FROM jsonb_to_recordset($1::jsonb) AS x(intent_id bigint,exploration_id bigint,identity_key text,family text,resource_hash text,target_hashes text[],prose_key text,has_work boolean,strength text,dynamic_assets boolean,uses_graph_anchors boolean,error text)
    ON CONFLICT(intent_id) DO UPDATE SET exploration_id=EXCLUDED.exploration_id,identity_key=EXCLUDED.identity_key,family=EXCLUDED.family,resource_hash=EXCLUDED.resource_hash,
      target_hashes=EXCLUDED.target_hashes,prose_key=EXCLUDED.prose_key,has_work=EXCLUDED.has_work,strength=EXCLUDED.strength,
      dynamic_assets=EXCLUDED.dynamic_assets,uses_graph_anchors=EXCLUDED.uses_graph_anchors,error=EXCLUDED.error,indexed_at=now()`,[JSON.stringify(data)]);
  await tx.query('DELETE FROM intent_work_assets WHERE intent_id=ANY($1::bigint[])',[data.map(d=>d.intent_id)]);
  await tx.query(`INSERT INTO intent_work_assets(intent_id,asset_id)
    SELECT intent_id,unnest(asset_ids) FROM jsonb_to_recordset($1::jsonb) x(intent_id bigint,asset_ids bigint[]) ON CONFLICT DO NOTHING`,[JSON.stringify(data)]);
  // A concurrent asset edit can dirty a legacy identity while it is being built.
  // CAS, rather than a max cursor, preserves that later invalidation for re-read.
  await tx.query(`DELETE FROM intent_work_dirty d USING jsonb_to_recordset($1::jsonb) x(intent_id bigint,revision bigint)
    WHERE d.intent_id=x.intent_id AND d.revision=x.revision`,[JSON.stringify(data)]);
  return rows.length;
}

export async function ensureIntentWorkIndex(tx:Queryable,expID:number){
  while(await indexIntentWorkBatch(tx,expID)){}
  const invalid=(await tx.query('SELECT intent_id,error FROM intent_work_index WHERE exploration_id=$1 AND error IS NOT NULL ORDER BY intent_id LIMIT 1',[expID])).rows[0];
  if(invalid)throw new Error(`历史意图 #${invalid.intent_id} 的工作身份无法核实：${invalid.error}；已保留原文，请修复原记录后重试`);
}

/** Runs before restoring executors. Bounded transactions and try-locks avoid
 * holding the migration connection while waiting behind an active task. */
export async function backfillIntentWorkIndex(db:Database){
  const busy:number[]=[];let indexed=0;
  for(;;){
    const next=(await db.query('SELECT exploration_id FROM intent_work_dirty WHERE NOT(exploration_id=ANY($1::bigint[])) ORDER BY exploration_id,intent_id LIMIT 1',[busy])).rows[0];
    if(!next)return {indexed,busy};
    const expID=Number(next.exploration_id);
    const count=await db.transaction(async tx=>{
      if(!(await tx.query('SELECT pg_try_advisory_xact_lock($1) locked',[-expID])).rows[0]?.locked)return null;
      return indexIntentWorkBatch(tx,expID);
    });
    if(count===null)busy.push(expID);else indexed+=count;
  }
}
