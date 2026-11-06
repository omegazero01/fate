import type {Database} from './index.js';
import {assetContextCTE,assetDTO} from './asset-query.js';
import {graphProjection,graphProjectionRevision} from './graph-projection.js';

export const COVERAGE_PAGE_SIZE=50;
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
/** Hierarchy identity uses complete narrow metadata in PostgreSQL. Only the
 * current seeds and their ancestors cross the wire; full asset bodies do not.
 * Max IDs preserve the original ascending-row Map overwrite rule. */
const hierarchy=`${assetContextCTE}, scoped AS MATERIALIZED (
 SELECT a.id,a.type,a.company_id,a.domain,a.root_domain,a.ip,a.port FROM assets a JOIN target t USING(id)
), roots AS (
 SELECT domain,max(id) id FROM scoped WHERE type='root_domain' GROUP BY domain
), missing AS (
 SELECT DISTINCT s.root_domain domain FROM scoped s LEFT JOIN roots r ON r.domain=s.root_domain
 WHERE s.type='subdomain' AND s.root_domain<>'' AND r.id IS NULL
), connectors AS (
 SELECT COALESCE('a:'||a.id,'r:'||m.domain) key,a.id asset_id,'root_domain'::text kind,a.company_id,m.domain,m.domain root_domain,''::text ip,NULL::int port,false in_scope
 FROM missing m LEFT JOIN LATERAL(SELECT id,company_id FROM assets WHERE type='root_domain' AND domain=m.domain ORDER BY id LIMIT 1) a ON true
), asset_nodes AS (
 SELECT 'a:'||id key,id asset_id,type kind,company_id,domain,root_domain,ip,port,true in_scope FROM scoped
 UNION ALL SELECT * FROM connectors
), all_nodes AS MATERIALIZED (
 SELECT * FROM asset_nodes UNION ALL
 SELECT 'c:'||c.id,NULL::bigint,'company',c.id,''::text,''::text,''::text,NULL::int,false FROM companies c
 WHERE c.id IN(SELECT company_id FROM asset_nodes)
), root_map AS (SELECT domain,max(key) key FROM asset_nodes WHERE kind='root_domain' GROUP BY domain),
 sub_map AS (SELECT domain,'a:'||max(id) key FROM scoped WHERE type='subdomain' GROUP BY domain),
 ip_map AS (SELECT ip,'a:'||max(id) key FROM scoped WHERE type='ip' GROUP BY ip),
 service_map AS (SELECT COALESCE(NULLIF(domain,''),ip) host,port,'a:'||max(id) key FROM scoped WHERE type='service' GROUP BY 1,2),
 host_map AS (SELECT COALESCE(NULLIF(domain,''),ip) host,'a:'||max(id) key FROM scoped WHERE type='service' GROUP BY 1),
 parent_candidates AS (
 SELECT n.*,CASE
  WHEN n.kind='subdomain' THEN r.key
  WHEN n.kind IN('root_domain','app','ip') THEN 'c:'||n.company_id
  WHEN n.kind='service' THEN COALESCE(s.key,i.key,r.key)
  WHEN n.kind='endpoint' THEN COALESCE(v.key,h.key,hs.key,hi.key,i.key,r.key)
 END parent FROM all_nodes n
 LEFT JOIN root_map r ON r.domain=n.root_domain
 LEFT JOIN sub_map s ON s.domain=n.domain
 LEFT JOIN ip_map i ON i.ip=n.ip
 LEFT JOIN service_map v ON v.host=COALESCE(NULLIF(n.domain,''),n.ip) AND v.port IS NOT DISTINCT FROM n.port
 LEFT JOIN host_map h ON h.host=COALESCE(NULLIF(n.domain,''),n.ip)
 LEFT JOIN sub_map hs ON hs.domain=COALESCE(NULLIF(n.domain,''),n.ip)
 LEFT JOIN ip_map hi ON hi.ip=COALESCE(NULLIF(n.domain,''),n.ip)
), tree AS MATERIALIZED (
 SELECT n.*,p.key parent_key FROM parent_candidates n LEFT JOIN all_nodes p ON p.key=n.parent AND p.key<>n.key
)`;

export async function readCoverageGraphPage(db:Database,taskID:number,q:Record<string,unknown>={}){
 const task=(await db.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskID])).rows[0];
 if(!task)throw fail('任务不存在',404);
 const page=q.page===undefined?1:Number(q.page),focus=typeof q.focus==='string'?q.focus:'';
 if(!Number.isSafeInteger(page)||page<1||(page-1)*COVERAGE_PAGE_SIZE>2147483646||focus.length>1024||focus&&!/^(a:[1-9]\d*|c:[1-9]\d*|r:.+)$/.test(focus))throw fail('无效资产图分页或节点');
 const expected=q.revision;if(expected!==undefined&&(typeof expected!=='string'||!/^[a-f0-9]{32}$/.test(expected)))throw fail('无效资产图版本');
 const expID=Number(task.exploration_id);
 const result=await graphProjection(db,taskID,expID,JSON.stringify(['coverage-page',page,focus]),async tx=>{
  const revision=await graphProjectionRevision(tx,taskID,expID);
  if(expected&&expected!==revision)throw fail('资产图已变化，请刷新第一页',409);
  const r=(await tx.query(`WITH RECURSIVE ${hierarchy}, matched AS MATERIALIZED (
   SELECT key,asset_id FROM tree WHERE CASE WHEN $2::text='' THEN in_scope ELSE parent_key=$2 END
  ), seeds AS (SELECT key FROM matched ORDER BY asset_id NULLS LAST,key LIMIT ${COVERAGE_PAGE_SIZE} OFFSET $3),
  ancestors(key) AS (
   SELECT key FROM seeds UNION SELECT key FROM tree WHERE key=$2
   UNION SELECT c.key FROM tree c JOIN tree s ON s.company_id=c.company_id JOIN seeds seed ON seed.key=s.key WHERE c.kind='company'
   UNION SELECT t.parent_key FROM ancestors a JOIN tree t ON t.key=a.key WHERE t.parent_key IS NOT NULL
  ), chosen AS (SELECT t.* FROM tree t JOIN ancestors a USING(key)),
  counts AS (SELECT s.type,count(*)::int total,count(*) FILTER(WHERE s.id IN(SELECT asset_id FROM tested))::int tested FROM scoped s GROUP BY s.type)
  SELECT EXISTS(SELECT 1 FROM tree WHERE key=$2) focus_exists,
   (SELECT count(*)::int FROM matched) total,(SELECT count(*)::int FROM scoped) total_assets,
   (SELECT count(*)::int FROM all_nodes WHERE NOT in_scope) connector_count,
   COALESCE((SELECT jsonb_agg(counts ORDER BY type) FROM counts),'[]') counts,
   COALESCE((SELECT jsonb_agg(key ORDER BY key) FROM seeds),'[]') seed_keys,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('src',key,'dst',parent_key) ORDER BY key) FROM chosen WHERE parent_key IS NOT NULL),'[]') edges,
   COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'key',n.key,'asset_id',COALESCE(n.asset_id,0),'kind',n.kind,'company_id',n.company_id,'in_scope',n.in_scope,
    'tested',n.in_scope AND n.asset_id IN(SELECT asset_id FROM tested),'legacy_tested',n.in_scope AND n.asset_id IN(SELECT asset_id FROM legacy_tested),
    'domain',left(n.domain,512),'root_domain',left(n.root_domain,512),'ip',left(n.ip,128),'port',n.port,
    'url',left(a.url,1024),'method',left(a.method,32),'service_type',left(a.service_type,128),'app_name',left(a.app_name,512),'page_title',left(a.page_title,512),'status_code',a.status_code,
    'label',left(CASE WHEN n.kind='company' THEN c.name WHEN n.kind='endpoint' THEN a.method||' '||a.url ELSE COALESCE(NULLIF(a.url,''),NULLIF(n.domain,''),NULLIF(n.ip,''),NULLIF(a.app_name,''),n.key) END,1024),
    'preview',true,'label_truncated',CASE WHEN n.kind='company' THEN char_length(c.name)>1024 WHEN n.kind='endpoint' THEN char_length(a.method||' '||a.url)>1024 ELSE greatest(char_length(a.url),char_length(n.domain),char_length(a.app_name))>1024 END
   ) ORDER BY n.key) FROM chosen n LEFT JOIN assets a ON a.id=n.asset_id LEFT JOIN companies c ON n.kind='company' AND c.id=n.company_id),'[]') nodes,
   (SELECT coverage_enabled FROM tasks WHERE id=$1) enabled`,[taskID,focus,(page-1)*COVERAGE_PAGE_SIZE])).rows[0]!;
  if(focus&&!r.focus_exists)throw fail('资产图节点不在当前范围中',404);
  const enabled=Boolean(r.enabled),counts=(r.counts as any[]).map(c=>({...c,tested:enabled?c.tested:0}));
  return {nodes:(r.nodes as any[]).map(n=>({...assetDTO(n),tested:enabled&&n.tested})),edges:r.edges,
   revision,page,page_size:COVERAGE_PAGE_SIZE,focus:focus||null,seed_keys:r.seed_keys,total:Number(r.total),total_assets:Number(r.total_assets),
   connector_count:Number(r.connector_count),tested:counts.reduce((n,c)=>n+Number(c.tested),0),counts,coverage_enabled:enabled,
   next_page:page*COVERAGE_PAGE_SIZE<Number(r.total)?page+1:null,complete:!focus&&Number(r.total)<=COVERAGE_PAGE_SIZE};
 });
 if(expected&&expected!==result.revision)throw fail('资产图已变化，请刷新第一页',409);
 return result;
}
