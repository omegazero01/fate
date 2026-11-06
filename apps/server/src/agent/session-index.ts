import type {SessionEntry} from '@earendil-works/pi-coding-agent';

/** Derived, runner-local state. Native entries remain authoritative and immutable.
 * A different transcript or a rewind rebuilds the index instead of reusing reads
 * from another branch/session. No index grants permission to a graph record. */
export class SessionIndex<T> {
  private count=0;
  private first?:string;
  private last?:string;
  private state:T;
  processed=0;
  constructor(private create:()=>T,private apply:(state:T,entry:SessionEntry)=>void){this.state=create();}
  update(entries:readonly SessionEntry[]):T{
    if(entries.length<this.count||this.count>0&&(entries[0]?.id!==this.first||entries[this.count-1]?.id!==this.last)){
      this.state=this.create();this.count=0;this.first=undefined;this.last=undefined;
    }
    for(let i=this.count;i<entries.length;i++){this.apply(this.state,entries[i]!);this.processed++;}
    this.count=entries.length;this.first=entries[0]?.id;this.last=entries.at(-1)?.id;
    return this.state;
  }
}

const idIndexes=new WeakMap<object,SessionIndex<Set<string>>>();
export function sessionEntryIDs(owner:object|undefined,entries:readonly SessionEntry[]):ReadonlySet<string>{
  if(!owner)return new Set(entries.map(e=>e.id));
  let index=idIndexes.get(owner);
  if(!index){index=new SessionIndex(()=>new Set<string>(),(ids,entry)=>{ids.add(entry.id);});idIndexes.set(owner,index);}
  return index.update(entries);
}
