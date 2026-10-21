/** Conclusion-level scope, never a per-request checklist or a completion protocol. */
export interface WritebackScope { tested: string; not_tested?: string; limitations?: string; }
export const writebackScopeSchema = {
  type:'object',additionalProperties:false,
  description:'本条结论的实际验证范围；可汇总多个相关接口和请求，不按每个参数拆节点。缺省保存为范围未说明，不计覆盖。',
  properties:{
    tested:{type:'string',minLength:1,maxLength:4000,description:'实际检查的范围和方法，不能直接复制意图计划充当已执行范围'},
    not_tested:{type:'string',maxLength:4000,description:'尚未验证的相关部分；未测不能表述为已否定'},
    limitations:{type:'string',maxLength:4000,description:'结论适用条件或限制，例如身份、协议、代理、样本范围'},
  },required:['tested'],
};
export function normalizeWritebackScope(value:unknown):WritebackScope|undefined {
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('scope 必须为对象');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(k=>!['tested','not_tested','limitations'].includes(k)))throw new Error('scope 包含未知字段');
  const out:Record<string,string>={};
  for(const key of ['tested','not_tested','limitations']){
    const v=input[key];if(v===undefined)continue;
    if(typeof v!=='string'||Array.from(v).length>4000)throw new Error(`scope.${key} 需要最多 4000 字符的文本`);
    if(v.trim())out[key]=v.trim();
  }
  if(!out.tested)throw new Error('scope.tested 不能为空');
  return out as unknown as WritebackScope;
}
export function writebackReceipt(assets:number[],scope:WritebackScope|undefined,evidence:string|undefined,observation:string){
  return {version:1,asset_binding:assets.length?'explicit':'unspecified',scope_status:scope?'reported':'unspecified',
    // This confirms a scoped report exists, not that the host verified its semantics.
    coverage_eligible:assets.length>0&&!!scope&&!!evidence?.trim()&&['observed','negative','finding'].includes(observation),
    gaps:[...(!assets.length?['asset_ids']:[]),...(!scope?['scope']:[]),...(!evidence?.trim()?['evidence']:[]),
      ...(!['observed','negative','finding'].includes(observation)?['observation_type']:[])],
  };
}

/** PostgreSQL jsonb order differs from insertion order; replay returns identical tool text. */
export function savedWritebackReceipt(value:unknown){
  if(!value||typeof value!=='object')return null;
  const v=value as ReturnType<typeof writebackReceipt>;
  return {version:v.version,asset_binding:v.asset_binding,scope_status:v.scope_status,coverage_eligible:v.coverage_eligible,gaps:v.gaps};
}
