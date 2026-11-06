/** Host control is distinct from an execution failure. Only trusted host code
 * constructs this error; message text is never used to classify a failure. */
export class ExecutionControlStop extends Error {
  constructor(readonly reason:'paused'|'queued'|'stopped'){
    super(reason==='paused'?'任务已暂停':reason==='queued'?'任务正在排队':'执行器正在停止');
    this.name='ExecutionControlStop';
  }
}

/** Context extensions may wrap the original error. A simultaneous abort must
 * not hide an unrelated DB/provider failure; require the actual abort reason
 * identity in the cause chain or an explicit host control error. */
export function executionControlReason(error:unknown,signal?:AbortSignal):string|undefined {
  const seen=new Set<unknown>();
  for(let value=error;value!==undefined&&!seen.has(value);){
    seen.add(value);
    if(value instanceof ExecutionControlStop)return value.reason;
    if(signal?.aborted&&value===signal.reason)return typeof signal.reason==='string'?signal.reason:'aborted';
    value=value instanceof Error?value.cause:undefined;
  }
}
