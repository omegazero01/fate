import type {PlannerHistorySnapshot} from './planner-history.js';
import type {AgentHistorySnapshot} from './agent-history.js';

/** Identifiers are selected by host code, never by a model/query parameter. */
export const HOST_STORES = {
  planner:{table:'planner_host_state',column:'exploration_id',entries:'planner_history_entries',sources:'planner_history_sources'},
  agent:{table:'agent_session_host_state',column:'session_key',entries:'agent_session_entries',sources:'agent_session_sources'},
} as const;
export type HostSnapshot = PlannerHistorySnapshot | AgentHistorySnapshot;
export const isAgentHistory = (s:HostSnapshot):s is AgentHistorySnapshot => 'kind' in s && s.kind==='agent';
export function sessionHostStore(s:HostSnapshot){return isAgentHistory(s)?{...HOST_STORES.agent,key:s.key}:{...HOST_STORES.planner,key:s.expID};}
