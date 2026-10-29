import type { Activity } from './types';

// Only explicit control metadata is authoritative. A real steer_work tool call
// in the originating agent's lane remains a normal, counted tool call.
export const isSteering = (a: Activity) =>
  a.metadata?.event_type === 'steering' && ['user', 'status'].includes(a.kind);
export const steeringTurnID = (a: Activity) => a.metadata?.steering?.target_turn_id ?? a.turn_id ?? a.metadata?.turn_id;
export function steeringSource(a: Activity): string {
  const source = a.metadata?.steering?.source ?? a.metadata?.source;
  return source === 'planner' ? 'Planner' : source === 'mainagent' || source === 'main' ? 'Main' : '来源未记录';
}
export function steeringStatus(a: Activity): string {
  const status = a.metadata?.steering?.status;
  // "queued" was the old branch's native-enqueue receipt, not proof of effect.
  return status === 'submitted' || status === 'queued' ? '已提交' : '状态未记录';
}
export const steeringIntent = (a: Activity) => a.metadata?.steering?.intent_id ?? a.intent_id;
