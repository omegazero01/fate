import type {Activity} from './types';

export const ACTIVITY_PAGE_SIZE=8192;
export type ActivityContentPage={detail:string;offset:number;next_offset:number;total_chars:number;has_more:boolean;version?:string;field?:'detail'|'summary'|'metadata';offset_unit?:'unicode_codepoints'};
export type ActivityContentOptions={offset?:number;version?:string;field?:'detail'|'summary'|'metadata';signal?:AbortSignal};
export function activityContentQuery(options:ActivityContentOptions,task?:string){
 const query=new URLSearchParams({page:'1',offset:String(options.offset??0),limit:String(ACTIVITY_PAGE_SIZE)});
 if(task)query.set('task',task);if(options.version)query.set('version',options.version);if(options.field)query.set('field',options.field);
 return query;
}
export function activityPreview(step:Activity):ActivityContentPage|undefined {
 if(step.detail===undefined)return undefined;
 const count=Array.from(step.detail).length,start=step.detail_start??0,total=step.detail_total_chars??count;
 return {detail:step.detail,offset:start,next_offset:start+count,total_chars:total,has_more:start+count<total,version:step.detail_version,field:'detail'};
}
export const isPartialPage=(page:ActivityContentPage)=>page.offset>0||page.has_more||page.next_offset<page.total_chars;
