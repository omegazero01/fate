import {roleContextPolicy} from './context-policy.js';
export const plannerContextPolicy=(contextWindow:number,configured?:string|null)=>roleContextPolicy('planner',contextWindow,configured);

type Row=Record<string,unknown>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Deduplicate fields only within the same source, node and content version.
 * Conflicting projections stay explicit; missing versions are never guessed. */
export function mergePlannerChanges(rows:Row[],taskID:number):Row[] {
  const out:Row[]=[],groups=new Map<string,Row>();
  for(const original of rows){
    const ref=original.ref??(Number.isSafeInteger(original.id)?`node:${original.id}`:undefined);
    if(typeof ref!=='string'||!ref.startsWith('node:')||!Number.isSafeInteger(original.version)){
      out.push(original);continue;
    }
    const source=original.source_task_id??taskID,key=JSON.stringify([source,ref,original.version]);
    const prior=groups.get(key);
    if(!prior){const row={...original,ref,source_task_id:source};groups.set(key,row);out.push(row);continue;}
    const conflicts:Row={};
    for(const [field,value] of Object.entries(original)){
      if(field==='section')continue;
      if(!(field in prior)){prior[field]=value;continue;}
      if(same(prior[field],value))continue;
      // Overview and event projections cap the same summary at different lengths.
      if(field==='summary'&&typeof value==='string'&&typeof prior[field]==='string'&&
        (value.startsWith(prior[field])||prior[field].startsWith(value))){
        if(value.length>prior[field].length)prior[field]=value;
      }else conflicts[field]=value;
    }
    prior.sections=[...new Set([...(prior.sections as string[]??[String(prior.section)]),String(original.section)])];
    if(Object.keys(conflicts).length)prior.projections=[...(prior.projections as Row[]??[]),{section:original.section,...conflicts}];
  }
  return out;
}
