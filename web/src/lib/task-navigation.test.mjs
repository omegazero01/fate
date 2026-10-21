import test from 'node:test';import assert from 'node:assert/strict';
import {taskNavigation,taskViewURL} from './task-navigation.ts';
test('all legacy task links keep a reachable destination',()=>{
 for(const [tab,view,panel,explore] of [['sessions','sessions',null,'graph'],['overview','sessions',null,'graph'],['broadcast','sessions',null,'graph'],['coverage','graph',null,'coverage'],['assets','graph',null,'assets'],['asset-approvals','sessions',null,'graph'],['intercept','sessions',null,'graph'],['retests','findings',null,'graph'],['files','files',null,'graph'],['traffic','traffic',null,'graph']])assert.deepEqual(taskNavigation(new URLSearchParams({tab})),{view,panel,explore,section:['overview','broadcast'].includes(tab)?tab:'chat'});
});
test('old detail drawers map to full-width task content, without losing focus references',()=>{
 for(const section of ['overview','broadcast']){
  const old=taskNavigation(new URLSearchParams({tab:'sessions',panel:section}));
  const current=taskNavigation(new URLSearchParams({tab:'sessions',section}));
  assert.deepEqual(old,current);assert.equal(current.panel,null);assert.equal(current.view,'sessions');
 }
 assert.equal(taskNavigation(new URLSearchParams('tab=sessions&section=invalid')).section,'chat');
});
test('navigation preserves source references, task identity',()=>{
 const result=new URL(taskViewURL('id=3&session=intent%3A7&activity=99&node=42',{tab:'files',panel:null}),'http://localhost');
 assert.equal(result.searchParams.get('id'),'3');assert.equal(result.searchParams.get('session'),'intent:7');assert.equal(result.searchParams.get('activity'),'99');assert.equal(result.searchParams.get('node'),'42');assert.equal(result.searchParams.get('tab'),'files');assert.equal(result.searchParams.get('panel'),null);
});
