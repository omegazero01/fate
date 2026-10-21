import {startRecordingGateway} from './recording.js';
// 出口网关装配（M6）：startEgressGateway(db, addr) → { server, addr, proxyURL, close }。
// -proxy 非空时由 apps/server/src/index.ts 接线；worker 侧用 proxyURL() +
// taskCredentials 拼出带签名的 http://user:pass@addr/ 注入 HTTP(S)_PROXY（见 agent/roles.ts）。

import type http from "node:http";
import type { Database } from "../db/index.js";
import { createEgressServer } from "./gateway.js";

export { taskCredentials, proxyAuthorizationHeader, parseAndVerify } from "./credentials.js";
export { authorizeTaskRequest, createEgressServer } from "./gateway.js";

export interface EgressGateway {
  /** 底层 http 服务器（已监听）。 */
  server: http.Server;
  caFile?: string;
  /** 客户端应使用的网关地址（host:port；全接口绑定时映射为 127.0.0.1）。 */
  addr: string;
  /** worker 环境注入用的代理 URL（http://<addr>/）。 */
  proxyURL(): string;
  close(): Promise<void>;
}

function parseListenAddr(addr: string): { host: string; port: number } {
  const a = addr.trim().startsWith(":") ? `0.0.0.0${addr.trim()}` : addr.trim();
  const idx = a.lastIndexOf(":");
  const host = idx >= 0 ? a.slice(0, idx) : "0.0.0.0";
  const port = idx >= 0 ? Number.parseInt(a.slice(idx + 1), 10) : 8788;
  // port=0 合法：交给内核分配临时端口（测试用；实际监听口以 server.address() 为准）。
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效的出口网关地址: ${addr}`);
  }
  return { host: host || "0.0.0.0", port };
}

/** 全接口绑定 → 客户端侧地址用回环（与 Go Traffic.ProxyAddr 一致）。 */
function clientHost(bindHost: string): string {
  return bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "" ? "127.0.0.1" : bindHost;
}

/** 启动出口代理：保留执行身份、暂停和租约校验。 */
export async function startEgressGateway(db: Database, addr: string, dataDir?: string): Promise<EgressGateway> {
  const { host, port } = parseListenAddr(addr);
  if(dataDir)return startRecordingGateway(db,host,port,dataDir);
  const server = createEgressServer(db);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  const displayHost = typeof bound === "object" && bound !== null ? clientHost(bound.address) : clientHost(host);
  const displayPort = typeof bound === "object" && bound !== null ? bound.port : port;
  const gw: EgressGateway = {
    server,
    addr: `${displayHost}:${displayPort}`,
    proxyURL: () => `http://${displayHost}:${displayPort}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return gw;
}
