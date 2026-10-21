import {it,expect} from 'vitest';
import {TerminalSessions} from './terminal.js';
import {tmpdir} from 'node:os';
const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));
it('keeps a REPL alive across input, Unicode output, incremental reads and exit',async()=>{
 const m=new TerminalSessions(tmpdir(),env);
 try{
  const opened=await m.open({command:"python3 -u -c 'import sys; print(\"READY\"); [print(\"回复😀\" + line.strip()) for line in sys.stdin]'",mode:'interactive',quiet_ms:80,timeout_ms:3000});
  // A quiet PTY can still be starting its login shell/Python under build load.
  await expect.poll(async()=>(await m.read({session_id:opened.session_id,since_cursor:0})).output,{timeout:10000}).toContain('READY');
  const response=await m.send({session_id:opened.session_id,text:'hello',submit:true,quiet_ms:80,timeout_ms:3000});
  await expect.poll(async()=>(await m.read({session_id:opened.session_id,since_cursor:0})).output,{timeout:10000}).toContain('回复😀hello');expect(response.running).toBe(true);
  const all=await m.read({session_id:opened.session_id,since_cursor:0,max_bytes:32768});expect(all.output).toContain('READY');
  expect((await m.read({session_id:opened.session_id,since_cursor:all.cursor})).output).toBe('');
  await m.send({session_id:opened.session_id,keys:['ctrl-c'],quiet_ms:80,timeout_ms:3000});
  expect((await m.close(opened.session_id)).closed).toBe(true);
 }finally{await m.shutdown();}
});
it('bounds long output and cancels a blocked read before closing every owned process',async()=>{
 const controller=new AbortController(),m=new TerminalSessions(tmpdir(),env,controller.signal);
 try{
 const opened=await m.open({command:"python3 -u -c 'import time; print(\"😀\" * 100000); time.sleep(60)'"});
 await expect.poll(async()=>(await m.read({session_id:opened.session_id,since_cursor:0,max_bytes:8192})).truncated,{timeout:10000}).toBe(true);
 const page=await m.read({session_id:opened.session_id,since_cursor:0,max_bytes:8192});
 expect(Buffer.byteLength(page.output)).toBeLessThanOrEqual(8192);expect(page.truncated).toBe(true);expect(page.output).not.toContain('\ufffd');
 const reading=m.read({session_id:opened.session_id,wait:true,timeout_ms:120000,quiet_ms:120000});
 const rejected=expect(reading).rejects.toThrow();controller.abort();await rejected;await m.shutdown();
 expect(m.list()).toEqual([]);await expect(m.send({session_id:opened.session_id,text:'echo old'})).rejects.toThrow();
 const other=new TerminalSessions(tmpdir(),env);try{await expect(other.read({session_id:opened.session_id})).rejects.toThrow('句柄');}finally{await other.shutdown();}
 }finally{await m.shutdown();}
});
