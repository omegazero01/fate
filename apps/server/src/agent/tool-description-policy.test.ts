import {it,expect} from 'vitest';
import {ARTEX_CONSTRAINT_DESCRIPTION,ARTEX_INTENT_DESCRIPTION} from './tool-description-policy.js';
import {effectiveToolDescription,TOOL_DESCRIPTIONS} from './tool-descriptions.js';
import {applyToolBindings} from './tool-bindings.js';
import {contextSearchTool,contextGetTool} from '../tools/context-read.js';
import {setConstraintsTool} from '../tools/goals.js';
import {runContext} from '../tools/context.js';
import {ACTIVE_ROLES} from './tool-registry.js';

const fakeDB=(stored:Record<string,string>={})=>({query:async()=>({rows:Object.entries(stored).map(([key,description])=>({key,description,enabled:true,agents:[...ACTIVE_ROLES]}))})}) as any;

it.each(ACTIVE_ROLES)('%s only advertises its supported history references after binding',async role=>{
  const db=fakeDB(TOOL_DESCRIPTIONS),ctx=runContext(db,1,1,role as never);
  const tools=await applyToolBindings(db,role,[contextSearchTool(ctx),contextGetTool(ctx)]);
  const search=tools[0]!,get=tools[1]!,schema=search.parameters as any;
  expect(schema.properties.source.enum.includes('planner_session')).toBe(role==='planner');
  expect(search.description.includes('planner_session')).toBe(role==='planner');
  expect(schema.properties.source.description.includes('planner_session')).toBe(role==='planner');
  expect(get.description.includes('session:')).toBe(role==='planner');
  const ref=(get.parameters as any).properties.items.items.properties.ref;
  expect(new RegExp(ref.pattern).test('session:abc-123')).toBe(role==='planner');
  for(const value of ['node:12','activity:12','operation:12','output:abc','attachment:abc','traffic:abc'])expect(new RegExp(ref.pattern).test(value)).toBe(true);
});
it('recognizes the exact ARTEX constraint default and keeps edited text',async()=>{
  const db=fakeDB({set_constraints:ARTEX_CONSTRAINT_DESCRIPTION});
  const tools=await applyToolBindings(db,'goals',[setConstraintsTool(runContext(db,1,1,'goals'))]);
  expect(tools[0]!.description).toContain('单换行仍属同段');
  expect(tools[0]!.description).not.toContain('顶层 text/type');
  expect((tools[0]!.parameters as any).properties.constraints.items.required).toEqual(['kind','text']);
  const custom=ARTEX_CONSTRAINT_DESCRIPTION+' 自定义保留要求';
  expect(effectiveToolDescription('set_constraints','fallback',custom)).toEqual({description:custom,source:'custom'});
});
it('upgrades the immediately previous built-in paragraph hint without touching stored data',()=>{
  const previous='保存用户明确的操作要求，text/source_quote 必须为任务原文或本轮用户消息中的完整段落，保留例外和原有语气。不能把目标 URL 改写成仅限该地址；allow 不默认排他。';
  expect(effectiveToolDescription('set_constraints','fallback',previous)).toMatchObject({description:TOOL_DESCRIPTIONS.set_constraints,source:'builtin'});
});
it('preserves custom history descriptions while retaining role schema restrictions',async()=>{
  const text='用户要求：查询工单记录。',db=fakeDB({context_search:text});
  const tools=await applyToolBindings(db,'worker',[contextSearchTool(runContext(db,1,1,'worker'))]);
  expect(tools[0]!.description).toBe(text);
  expect((tools[0]!.parameters as any).properties.source.enum).not.toContain('planner_session');
});

it('removes retired approval tools only from the exact ARTEX intent default',()=>{
  const resolved=effectiveToolDescription('add_intent','fallback',ARTEX_INTENT_DESCRIPTION);
  expect(resolved.source).toBe('builtin');
  expect(resolved.description).not.toContain('check_target_access');
  expect(resolved.description).not.toContain('待审批');
  const custom=ARTEX_INTENT_DESCRIPTION+' 自定义规则';
  expect(effectiveToolDescription('add_intent','fallback',custom)).toEqual({description:custom,source:'custom'});
});
