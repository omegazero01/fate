import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsProfiles, taskModelSelection } from './task-model-settings.ts';

test('numeric server model IDs remain selected after saving and reopening settings', () => {
  const profiles = settingsProfiles([{id:1,name:'Local A'}, {id:'2',name:'Local B'}]);
  const selection = taskModelSelection({llm_profile_id:1,active_llm_profile_id:1});
  assert.equal(profiles[0].id,selection.active);
  assert.equal(profiles[1].id,'2');
  assert.deepEqual(selection.ids,['1']);
});
test('candidate order and active cursor survive normalization; unavailable cursors fall back', () => {
  assert.deepEqual(taskModelSelection({llm_profile_ids:[2,'1'],active_llm_profile_id:1}),{ids:['2','1'],active:'1'});
  assert.deepEqual(taskModelSelection({llm_profile_ids:[2,1],active_llm_profile_id:0}),{ids:['2','1'],active:'2'});
  assert.deepEqual(taskModelSelection({llm_profile_id:0}),{ids:[],active:''});
});
