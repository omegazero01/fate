/** A JSON document offset and an embedded string offset are different spaces.
 * Never interpret one as the other or fabricate a field read receipt. */
export type ReadCoordinate={ref:string;view:string;field:string;version?:number;cursor?:string;unit:'unicode_codepoints';format:'text'|'json'};
export class ReadSelectionRequired extends Error {
 readonly code='READ_SELECTION_REQUIRED';
 constructor(message:string,readonly read_options:Record<string,unknown>[]){super(message);}
}
const escape=(key:string)=>key.replace(/~/g,'~0').replace(/\//g,'~1');
export function fieldReadOptions(data:unknown,base:{ref:string;view:string;version?:number}){
 const fields:string[]=[];let inspected=0;
 const visit=(value:unknown,prefix:string,depth:number)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||depth>2)return;
  for(const key in value){
   if(!Object.hasOwn(value,key))continue;
   if(++inspected>64||fields.length>=24)return;
   const child=(value as Record<string,unknown>)[key];
   const field=`${prefix}/${escape(key)}`;
   if(typeof child==='string')fields.push(field);
   else if(child&&typeof child==='object'&&!Array.isArray(child))visit(child,field,depth+1);
  }
 };
 visit(data,'',0);
 const preferred=['/payload/evidence','/finding_detail/evidence','/finding_detail/report','/payload/detail','/content','/detail','/output'];
 const rank=(f:string)=>preferred.includes(f)?preferred.indexOf(f):preferred.length;
 fields.sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b));
 return [...new Set(fields)].slice(0,8).map(field=>({...base,field,offset:0}));
}
