// 任务代理：记录流量，验证执行身份、租约和暂停状态。
import {stripHostPort} from "../db/task_scope.js";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Database } from "../db/index.js";
import { parseAndVerify } from "./credentials.js";

/** 请求放行/拒绝判定结果。 */
type GateDecision = { allowed: true } | { allowed: false; status: number; message: string };

export async function authorizeTaskRequest(db: Database, taskID: number, host: string, port=443,scope=''): Promise<void> {
  try {
    const task=await db.tasks().getTask(taskID);
    if(!task||task.paused||task.queued||['done','failed','stopped','timeout'].includes(task.status))throw new Error('任务已暂停、终止或不可执行');
    const worker=/^worker:(\d+)(?::(.+))?$/.exec(scope);
    if(worker){
      const intent=await db.exploration(task.exploration_id).getNode(Number(worker[1]));
      if(!intent||intent.kind!=='intent'||intent.state!=='running'||intent.payload.cancelled_by_user===true)throw new Error('意图已停止或不属于当前任务');
      if(worker[2]&&!(await db.query('SELECT 1 FROM engine_task_leases WHERE task_id=$1 AND token=$2 AND expires_at>clock_timestamp()',[taskID,worker[2]])).rowCount)throw new Error('执行租约已失效');
    }else if(scope.startsWith('main:')){
      const main=/^main:(\d+):(\d+):(.+)$/.exec(scope);
      if(!main||Number(main[1])!==taskID||!(await db.query('SELECT 1 FROM runtime_session_leases WHERE key=$1 AND token=$2 AND expires_at>clock_timestamp() AND NOT stop_requested',[`main:${taskID}:${main[2]}`,main[3]])).rowCount)throw new Error('Main 会话租约已失效');
    }else{
      const planner=/^planner:(.+)$/.exec(scope);
      if(planner&&!(await db.query('SELECT 1 FROM engine_task_leases WHERE task_id=$1 AND token=$2 AND expires_at>clock_timestamp()',[taskID,planner[1]])).rowCount)throw new Error('Planner 租约已失效');
      const conversation=/^conversation:(\d+):(.+)$/.exec(scope);
      if(conversation&&!(await db.query('SELECT 1 FROM runtime_session_leases WHERE key=$1 AND token=$2 AND expires_at>clock_timestamp() AND NOT stop_requested',[`conversation:${conversation[1]}`,conversation[2]])).rowCount)throw new Error('会话租约已失效');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`执行已停止: ${msg}`);
  }
}

/** 每请求鉴权 + 授权门：未打标放行（debug 留痕），打标无效/未授权拒绝。 */
async function gateRequest(
  db: Database,
  proxyAuthorization: string | undefined,
  host: string,
  port:number,
): Promise<GateDecision> {
  let parsed;
  try {
    parsed = parseAndVerify(proxyAuthorization);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { allowed: false, status: 403, message: `任务代理凭据无效: ${msg}` };
  }
  if (!parsed.tagged) {
    console.debug(`[egress] 未打标流量直接放行: ${host}`);
    return { allowed: true };
  }
  try {
    await authorizeTaskRequest(db, parsed.taskID, host,port,parsed.scope);
    return { allowed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      status: 403,
      message: `${msg}。跳过本项资源，继续其他已授权测试，不要重试该地址。`,
    };
  }
}

/** CONNECT authority（host:port / [v6]:port）→ { host, port }；解析失败返回 null。 */
function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = authority.match(/^\[([0-9a-fA-F:.]+)\]:(\d+)$/) ?? authority.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const port = Number.parseInt(m[2]!, 10);
  if (!(port > 0) || port > 65535) return null;
  return { host: m[1]!, port };
}

/** 内部凭据绝不能到目标：转发前删除代理层头 + 逐跳头。 */
function sanitizeOutgoingHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  for (const h of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade", "te", "trailer"]) {
    delete out[h];
  }
  return out;
}

/** CONNECT 隧道：鉴权 → net.connect 上游 → 双向原样管道。 */
function handleConnect(db: Database, req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
  const fail = (status: number, message: string) => {
    const body = Buffer.from(message, "utf8");
    clientSocket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Forbidden"}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${body.length}\r\n` +
        `Connection: close\r\n\r\n` +
        body.toString("utf8"),
    );
  };

  const target = parseAuthority(req.url ?? "");
  if (!target) {
    fail(400, "出口网关：无法解析 CONNECT 目标");
    return;
  }

  void gateRequest(db, req.headers["proxy-authorization"], target.host,target.port)
    .then((decision) => {
      if (!decision.allowed) {
        fail(decision.status, decision.message);
        return;
      }
      const upstream = net.connect({ host: target.host, port: target.port });
      let established = false;
      upstream.on("error", (err) => {
        if (established) {
          clientSocket.destroy();
          return;
        }
        fail(502, `出口网关：连接上游失败: ${err.message}`);
      });
      clientSocket.on("error", () => upstream.destroy());
      upstream.on("connect", () => {
        established = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    })
    .catch(() => fail(500, "出口网关：内部错误"));
}

/** 普通 HTTP 代理请求（绝对 URI）：鉴权 → http.request 转发 → 回写。 */
async function handlePlainHTTP(db: Database, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const fail = (status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  };

  // 绝对 URI 优先；缺失时退回 Host 头 + 原始路径（非代理形态请求按目标不可达拒绝）。
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      fail(400, "出口网关：缺少请求目标");
      return;
    }
    try {
      target = new URL(req.url ?? "/", `http://${stripHostPort(hostHeader)}`);
    } catch {
      fail(400, "出口网关：无法解析请求目标");
      return;
    }
  }
  if (target.protocol !== "http:") {
    fail(400, `出口网关：不支持的协议 ${target.protocol}（HTTPS 请走 CONNECT）`);
    return;
  }

  const decision = await gateRequest(db, req.headers["proxy-authorization"], target.hostname,Number(target.port)||80);
  if (!decision.allowed) {
    fail(decision.status, decision.message);
    return;
  }

  const upstream = http.request(target, {
    method: req.method,
    headers: sanitizeOutgoingHeaders(req.headers),
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) fail(502, `出口网关：转发失败: ${err.message}`);
    else res.destroy();
  });
  upstream.on("response", (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** 构造出口网关服务器（未监听；由 startEgressGateway 绑定）。 */
export function createEgressServer(db: Database): http.Server {
  const server = http.createServer((req, res) => {
    void handlePlainHTTP(db, req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("出口网关：内部错误");
      } else {
        res.destroy();
      }
    });
  });
  server.on("connect", (req, socket, head) => handleConnect(db, req, socket, head));
  return server;
}
