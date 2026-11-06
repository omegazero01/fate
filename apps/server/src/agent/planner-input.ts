type Row=Record<string,unknown>;
type Block={defaults:Row;columns:string[];rows:unknown[][]};
export type PlannerRowTable={format:'shared_fields_v1';meaning:string;blocks:Block[]};
const record=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Lossless encoding of host-authored JSON rows, not a summary or semantic
 * deduplication. Contiguous equal-shaped rows can share exact common values
 * and field names. Missing keys, null, empty values and order stay distinct.
 * Originals already stored in older sessions are never rewritten. */
export function compactPlannerRows(rows:Row[]):Row[]|PlannerRowTable{
 const blocks:Block[]=[];
 for(let start=0;start<rows.length;){
  const columns=Object.keys(rows[start]!).sort(),shape=JSON.stringify(columns);let end=start+1;
  while(end<rows.length&&JSON.stringify(Object.keys(rows[end]!).sort())===shape)end++;
  const group=rows.slice(start,end),defaults:Row=Object.create(null);
  if(group.length>=4)for(const key of columns){
   const value=JSON.stringify(group[0]![key]);if(group.every(row=>JSON.stringify(row[key])===value))defaults[key]=group[0]![key];
  }
  const varied=columns.filter(key=>!Object.hasOwn(defaults,key));
  blocks.push({defaults,columns:varied,rows:group.map(row=>varied.map(key=>row[key]))});start=end;
 }
 const table:PlannerRowTable={format:'shared_fields_v1',meaning:'按 blocks 和 rows 的顺序读取；每行将 defaults 与 columns 对应的各列值合并成完整记录。所有字段和值均保留，未合并不同记录。',blocks};
 return Buffer.byteLength(JSON.stringify(table))<Buffer.byteLength(JSON.stringify(rows))?table:rows;
}

/** Called only for a newly built Planner host delivery. Parsing its serialized
 * JSON first preserves precisely the JSON-visible values and missing keys. */
export function compactPlannerInput(input:string):string{
 const payload:unknown=JSON.parse(input);
 if(!record(payload)||!Array.isArray(payload.changes)||!payload.changes.every(record)||payload.changes.length<4)return input;
 const changes=compactPlannerRows(payload.changes);if(Array.isArray(changes))return input;
 const compact=JSON.stringify({...payload,changes});
 return Buffer.byteLength(compact)<Buffer.byteLength(input)?compact:input;
}
