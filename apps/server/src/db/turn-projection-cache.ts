import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';

type Row=Record<string,any>;
const MAX_BYTES=8*1024*1024,MAX_ENTRIES=1024;
type ReadCounts={full_reads:number;delta_reads:number;control_reads:number;receipt_reads:number;indexed_reads:number;reference_hits:number};
const emptyCounts=():ReadCounts=>({full_reads:0,delta_reads:0,control_reads:0,receipt_reads:0,indexed_reads:0,reference_hits:0});
const identities=new WeakMap<Database,number>(),counts=new WeakMap<Database,ReadCounts>();
const entries=new Map<string,{row:Row;bytes:number}>();let sequence=0,bytes=0;
function identity(db:Database){let n=identities.get(db);if(!n){n=++sequence;identities.set(db,n);}return n;}
function key(db:Database,scope:StreamScope,id:number|string,turn:string){return JSON.stringify([identity(db),scope,id,turn]);}
function remove(k:string){const old=entries.get(k);if(old){bytes-=old.bytes;entries.delete(k);}}
export function forgetTurnProjection(db:Database,scope:StreamScope,id:number|string,turn:string){remove(key(db,scope,id,turn));}
export function getTurnProjection(db:Database,scope:StreamScope,id:number|string,turn:string):Row|undefined{
 const k=key(db,scope,id,turn),entry=entries.get(k);if(!entry)return;
 entries.delete(k);entries.set(k,entry);return structuredClone(entry.row);
}
export function putTurnProjection(db:Database,scope:StreamScope,id:number|string,row:Row){
 const k=key(db,scope,id,String(row.turn_id)),old=entries.get(k)?.row;
 // An overlapping old query must not replace a newer snapshot.
 if(old&&(BigInt(old.data_revision)>BigInt(row.data_revision)||old.data_revision===row.data_revision&&new Date(old.observed_at)>new Date(row.observed_at)))return;
 const size=Buffer.byteLength(JSON.stringify(row))+Buffer.byteLength(k)+128;
 remove(k);if(size>MAX_BYTES)return;
 entries.set(k,{row:structuredClone(row),bytes:size});bytes+=size;
 while(bytes>MAX_BYTES||entries.size>MAX_ENTRIES)remove(entries.keys().next().value!);
}
export function recordTurnProjectionRead(db:Database,kind:keyof ReadCounts,n:number){const c=counts.get(db)??emptyCounts();c[kind]+=n;counts.set(db,c);}
export function turnProjectionMetrics(db:Database){return {...(counts.get(db)??emptyCounts()),shared_entries:entries.size,shared_bytes:bytes,shared_max_bytes:MAX_BYTES,shared_max_entries:MAX_ENTRIES};}
export function clearTurnProjectionCache(db:Database){const prefix=`[${identity(db)},`;for(const k of entries.keys())if(k.startsWith(prefix))remove(k);counts.delete(db);}
