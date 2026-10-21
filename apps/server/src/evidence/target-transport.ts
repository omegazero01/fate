import {Agent, fetch} from 'undici';

// SERIES traffic.go uses SslInsecure for test targets. Keep this scoped to
// target transport: model providers, MCP and process-wide TLS remain unchanged.
export const TARGET_TLS_OPTIONS = Object.freeze({rejectUnauthorized:false});
const dispatcher = new Agent({connect:TARGET_TLS_OPTIONS});

export async function targetFetch(url:string, init:{method:string;headers:Record<string,string>;body?:string;signal?:AbortSignal;redirect:'manual'}) {
  const timeout=AbortSignal.timeout(60_000);
  const signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout;
  try { return await fetch(url,{...init,signal,dispatcher}); }
  catch(error){
    init.signal?.throwIfAborted();
    const cause=error instanceof Error?error.cause:undefined;
    const code=timeout.aborted?'ETIMEDOUT':cause&&typeof cause==='object'&&'code' in cause?String(cause.code):'NETWORK_ERROR';
    // Codes are diagnostic; do not echo URLs, query tokens or request headers.
    throw new Error(`目标 HTTP 请求失败 (${code})；这是传输错误，不能据此认定目标不存在或端口关闭`,{cause:error});
  }
}
