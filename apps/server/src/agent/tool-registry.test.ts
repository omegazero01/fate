import {it,expect} from 'vitest';
import {toolIdentity,isCoreTool,assertToolBinding,RETIRED_TOOLS} from './tool-registry.js';
import {workerTools,plannerTools,mainTools,goalsTools} from '../tools/index.js';
import {runContext} from '../tools/context.js';

it('classifies actual role factories and preserves custom/legacy identities',()=>{
  for(const [role,factory] of [['worker',workerTools],['planner',plannerTools],['mainagent',mainTools],['goals',goalsTools]] as const){
    const tools=factory(runContext({} as never,1,1,role));
    for(const tool of tools)expect(toolIdentity(tool.name).implementation_status,tool.name).not.toBe('unsupported');
  }
  expect(toolIdentity('create_mcp')).toMatchObject({implementation_status:'unsupported'});
  expect(toolIdentity('read_tool_output')).toMatchObject({implementation_status:'compatibility',canonical_name:'context_get'});
  expect(toolIdentity('operator_command','command')).toMatchObject({implementation_status:'active',source:'custom'});
  for(const name of RETIRED_TOOLS)expect(toolIdentity(name).implementation_status).toBe('retired');
});
it('keeps incremental writeback direct and persistent terminal capabilities discoverable',()=>{
  for(const tool of ['record_fact','insert_assets','report_finding','http_request','read','bash'])expect(isCoreTool('worker',tool)).toBe(true);
  for(const tool of ['shell_open','shell_send','asset_search','asset_get'])expect(isCoreTool('worker',tool)).toBe(false);
  expect(isCoreTool('planner','steer_work')).toBe(true);
  expect(isCoreTool('planner','asset_search')).toBe(true);
  expect(isCoreTool('planner','asset_get')).toBe(false);
  expect(isCoreTool('reporter','report_finding')).toBe(false);
});
it('checks live sub-capability bindings without resurrecting retired tools',async()=>{
  let row:unknown={enabled:true,agents:['worker']};
  const db={query:async()=>({rows:row?[row]:[]})} as never;
  await expect(assertToolBinding(db,'worker','read_attachment')).resolves.toBeUndefined();
  row={enabled:false,agents:['worker']};await expect(assertToolBinding(db,'worker','read_attachment')).rejects.toThrow('权限');
  row={enabled:true,agents:['mainagent']};await expect(assertToolBinding(db,'worker','read_attachment')).rejects.toThrow('权限');
  row=undefined;await expect(assertToolBinding(db,'worker','record_finding_retest_result')).rejects.toThrow('移除');
});
