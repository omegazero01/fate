/** Kept separate from active role defaults so historical identities remain readable. */
export const RETESTER_RETIRED = 'RETESTER_RETIRED';
export const RETESTER_RETIRED_MESSAGE = 'Retester 功能已移除；历史复测记录仅供读取，需要复测请正常下发任务。';

export function assertActiveRole(role: string): void {
  if (role.toLowerCase() === 'retester') {
    throw Object.assign(new Error(RETESTER_RETIRED_MESSAGE), {statusCode: 410, code: RETESTER_RETIRED});
  }
}
