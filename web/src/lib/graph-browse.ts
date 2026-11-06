import type {Edge,TaskNode,Asset} from './types';
import type {ActivityContentPage} from './activity-content';
export type GraphSelection={mode?:'nodes'|'relations'|'members';focus?:string;before?:string;edge_before?:string;kind?:string;q?:string;revision?:string;direction?:'all'|'in'|'out'};
export type GraphPage={unchanged:false;revision:string;mode:string;focus:string|null;nodes:TaskNode[];edges:Edge[];total_nodes:number;total:number;edge_total:number;before:string|null;next_before:string|null;edge_before:string|null;next_edge_before:string|null;has_more:boolean;edges_has_more:boolean;complete:boolean};
export type GraphReply=GraphPage|{unchanged:true;revision:string};
export type GraphNodePage={revision:string;node:TaskNode;content:ActivityContentPage;assets:Asset[];assets_total:number;asset_offset:number;assets_next_offset:number|null};
export function graphPageQuery(task:string,selection:GraphSelection,known?:string){
 const q=new URLSearchParams({task,view:'page'});
 for(const [k,v] of Object.entries(selection))if(v!==undefined&&v!=='')q.set(k,v);
 if(known)q.set('known_revision',known);return q;
}
