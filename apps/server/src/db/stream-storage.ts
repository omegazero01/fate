import type {Database} from './index.js';

export const STREAM_CHUNK_UNITS=65536,STREAM_PREVIEW_CHARS=8192;
export type StreamRef={scope:'task'|'conversation';id:number;stream:string;channel:string};
export type StreamOwner={turn_id:string;worker:string;node_id?:number;main_seg?:number};
export const streamParams=(ref:StreamRef)=>[ref.scope,ref.id,ref.stream,ref.channel];

/** Lock only this presentation stream, not all Workers in the task. Final
 * projection takes its existing activity lock before this lock. Delta writes
 * never take the activity lock, so there is no inverse ordering. */
export async function lockStream(db:Database,ref:StreamRef){
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('stream:'||jsonb_build_array($1::text,$2::bigint,$3::text,$4::text)::text,0))",streamParams(ref));
}
export function finalStreamSQL(scope:StreamRef['scope']){
 return `SELECT 1 FROM ${scope==='task'?'activity':'conversation_activities'} WHERE ${scope==='task'?'exploration_id':'conversation_id'}=$2
  AND metadata->>'stream_id'=$3 AND metadata->>'channel'=$4`;
}

/** A lost COMMIT reply retries the same position and bytes. It cannot append
 * a duplicate chunk or resurrect a stream after its authoritative final. */
export async function appendStreamChunk(db:Database,ref:StreamRef,owner:StreamOwner,chunk:{no:number;start:number;text:string}){
 const result=await db.query('SELECT append_agent_stream_chunk($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) saved',
  [...streamParams(ref),owner.turn_id,owner.worker,owner.node_id??null,owner.main_seg??null,chunk.no,chunk.start,chunk.text]);
 return result.rows[0]?.saved===true;
}

/** Used only at explicit interrupted-output archival, within PostgreSQL. */
export function streamOriginalSQL(alias:string){
 return `CASE WHEN ${alias}.storage_version=1 THEN COALESCE((SELECT string_agg(c.body,'' ORDER BY c.chunk_no)
  FROM agent_stream_chunks c WHERE c.scope=${alias}.scope AND c.scope_id=${alias}.scope_id AND c.stream_id=${alias}.stream_id AND c.channel=${alias}.channel),'') ELSE ${alias}.body END`;
}
