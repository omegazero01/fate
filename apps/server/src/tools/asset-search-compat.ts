import {assertToolBinding} from '../agent/tool-registry.js';
import {assetSearchTool,listAssetsTool} from './assets.js';
import type {ToolRunContext} from './context.js';
/** One canonical entry, retaining legacy offsets and live switches for list/untested sub-capabilities. */
export function mergedAssetSearchTool(ctx:ToolRunContext){
 const search=assetSearchTool(ctx),list=listAssetsTool(ctx);
 return {...search,description:'按 dsl 检索资产摘要；空 dsl 分页列出，untested=true 查询未测资产。使用 next_offset 续读，详情用 asset_get。来源任务只读。',
  async execute(...args:Parameters<typeof search.execute>){
   const input=args[1] as {dsl?:string;untested?:boolean;limit?:number;offset?:number};
   try{
    await assertToolBinding(ctx.db,ctx.role,'asset_search');
    if(input.untested)await assertToolBinding(ctx.db,ctx.role,'list_untested_assets');
    if(!input.untested&&!input.dsl?.trim()){
     await assertToolBinding(ctx.db,ctx.role,'list_assets');
     return list.execute(...args);
    }
    return search.execute(...args);
   }catch(e){return {content:[{type:'text' as const,text:JSON.stringify({error:e instanceof Error?e.message:String(e)})}],isError:true,details:undefined};}
  }};
}
