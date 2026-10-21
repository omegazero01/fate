import {describe,it,expect} from 'vitest';
import {groundConstraint,renderConstraints,CONSTRAINT_PROTOCOL,GOALS_CONSTRAINT_RULES} from './constraint-policy.js';

describe('operator-sourced operation constraints',()=>{
  it('does not turn a task locator into an exclusive host or port restriction',()=>{
    const sources={description:'测试目标：\nhttp://fixture.invalid/\n\n发现可复现问题。'};
    for(const text of ['仅对目标 http://fixture.invalid/ 进行授权测试','http://fixture.invalid/','测试目标：\nhttp://fixture.invalid/']){
      expect(()=>groundConstraint({kind:'allow',text},sources)).toThrow();
    }
    expect(()=>groundConstraint({kind:'allow',text:'仅限该主机',source_quote:'测试目标：\nhttp://fixture.invalid/'},sources)).toThrow('逐字');
  });
  it('keeps explicit restrictions and their exceptions exactly as written',()=>{
    const text='仅允许测试 fixture.invalid:443，不测试其他端口。';
    expect(groundConstraint({kind:'allow',text},{description:`测试目标：fixture.invalid\n\n${text}`})).toMatchObject({text,source:{field:'description',quote:text}});
    const conditional='无需重点关注以下问题：\n- XSS\n- 低风险版本信息\n除非能形成实际攻击链。';
    expect(groundConstraint({kind:'deny',text:conditional},{description:conditional}).text).toBe(conditional);
    expect(()=>groundConstraint({kind:'deny',text:'- XSS'},{description:conditional})).toThrow('完整段落');
    expect(()=>groundConstraint({kind:'deny',text:'禁止提交 XSS'},{description:conditional})).toThrow();
  });
  it('does not strip negation or turn ordinary permission into exclusivity',()=>{
    const text='允许测试 API。';
    const block=renderConstraints([{kind:'allow',text},{kind:'deny',text:'不要禁用 API 测试。'}]);
    expect(block).toContain(text);expect(block).not.toContain('仅允许：');expect(block).not.toContain('禁止：不要');
    expect(()=>groundConstraint({kind:'deny',text:'禁用 API 测试。'},{user_message:'不要禁用 API 测试。'})).toThrow();
    expect(renderConstraints([])).toBe('');
  });
  it('explains the blank-line boundary without accepting partial multiline constraints',()=>{
    const first='仅允许 GET 本地合成资源。',rest='禁止外部请求。\n例外：模型请求使用已配置的供应商。';
    const source=first+'\n'+rest;
    expect(()=>groundConstraint({kind:'allow',text:first},{description:source})).toThrow('单换行仍属同段');
    expect(()=>groundConstraint({kind:'allow',text:'【任务描述】\n'+source},{description:source})).toThrow('宿主添加');
    expect(groundConstraint({kind:'allow',text:source},{description:source}).text).toBe(source);
    expect(groundConstraint({kind:'allow',text:first},{description:first+'\n\n'+rest}).text).toBe(first);
  });
  it('binds exact raw source hashes and accepts legacy exact-text calls',()=>{
    const text='禁止写入生产库。',source='\r\n'+text+'\r\n';
    const v=groundConstraint({kind:'deny',text},{user_message:source});
    expect(v.source).toMatchObject({version:1,field:'user_message',quote:text});
    expect(v.source.source_hash).toHaveLength(64);
    expect(()=>groundConstraint({kind:'deny',text},{})).toThrow('原文依据');
    expect(CONSTRAINT_PROTOCOL).toContain('未执行不能记为实测阴性');
    expect(GOALS_CONSTRAINT_RULES).toContain('保留列表');
  });
});
