/** Public creation paths must never infer an objective from background prose. */
export function requireTaskGoal(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('请填写任务目标；任务描述不能代替目标'), {statusCode:400, code:'TASK_GOAL_REQUIRED'});
  }
  return value.trim();
}
