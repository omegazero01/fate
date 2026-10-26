import type {Database} from '../db/index.js';
import {aggregateUsage,unverifiedUsageHistory} from '../db/usage-ledger.js';
/** Public input is inclusive of cache. All scopes share the retained request ledger. */
export async function modelTokenUsage(db:Database,taskID?:number){
 return {unverified_history:await unverifiedUsageHistory(db,{taskID}),models:(await aggregateUsage(db,{taskID},'model')).map(row=>({...row,model:row.bucket,calls:row.calls_complete?row.calls:null}))};
}
