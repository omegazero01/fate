// 出口网关（M6）测试：凭据生成/验签/篡改拒绝（纯单测，无 PG）+
// 端到端（本地 echo 上游 + 桩 db：授权通过/拒绝）+ CONNECT 隧道双向通。
// 运行：cd apps/server && npx vitest run src/egress/gateway.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Database } from "../db/index.js";
import {
  taskCredentials,
  proxyAuthorizationHeader,
  parseAndVerify,
} from "./credentials.js";
import { startEgressGateway, type EgressGateway } from "./index.js";

// ─── 凭据：生成/验签往返、篡改拒绝、常数时间比较（无异常即可）────────────────

describe("任务代理凭据（guard/proxy_tag.go 语义）", () => {
  it("worker scope 凭据生成 → Basic 头 → 验签往返", () => {
    const creds = taskCredentials(42, "worker:7");
    expect(creds).not.toBeNull();
    expect(creds!.username).toMatch(/^series-task-42~[A-Za-z0-9_-]+$/);
    expect(creds!.password).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex（与 Go 一致）
    const parsed = parseAndVerify(proxyAuthorizationHeader(creds!));
    expect(parsed).toEqual({ tagged: true, taskID: 42, scope: "worker:7" });
  });

  it("无 scope 凭据：identity 不带 ~，往返 scope 为空", () => {
    const creds = taskCredentials(42, "");
    expect(creds!.username).toBe("series-task-42");
    const parsed = parseAndVerify(proxyAuthorizationHeader(creds!));
    expect(parsed).toEqual({ tagged: true, taskID: 42, scope: "" });
  });

  it("taskID<=0 或非整数 → null", () => {
    expect(taskCredentials(0)).toBeNull();
    expect(taskCredentials(-1, "worker:1")).toBeNull();
    expect(taskCredentials(1.5)).toBeNull();
  });

  it("篡改密码（含等长篡改）→ 拒绝（常数时间路径无异常抛出）", () => {
    const creds = taskCredentials(42, "worker:7");
    // 等长篡改：走 timingSafeEqual 主路径
    const tamperedPass = creds!.password.slice(0, 62) + (creds!.password.slice(62) === "00" ? "11" : "00");
    expect(tamperedPass).not.toBe(creds!.password);
    expect(() =>
      parseAndVerify(`Basic ${Buffer.from(`${creds!.username}:${tamperedPass}`).toString("base64")}`),
    ).toThrow("任务代理签名无效");
    // 长度不同：显式长度短路（与 Go subtle 分支一致），同样拒绝且不抛 timingSafeEqual 异常
    expect(() =>
      parseAndVerify(`Basic ${Buffer.from(`${creds!.username}:deadbeef`).toString("base64")}`),
    ).toThrow("任务代理签名无效");
  });

  it("篡改 taskID / scope（借别任务身份）→ 验签拒绝", () => {
    const creds = taskCredentials(42, "worker:7");
    const forgedUser = "series-task-43~" + Buffer.from("worker:7", "utf8").toString("base64url");
    expect(() =>
      parseAndVerify(`Basic ${Buffer.from(`${forgedUser}:${creds!.password}`).toString("base64")}`),
    ).toThrow();
    const forgedScope = "series-task-42~" + Buffer.from("worker:8", "utf8").toString("base64url");
    expect(() =>
      parseAndVerify(`Basic ${Buffer.from(`${forgedScope}:${creds!.password}`).toString("base64")}`),
    ).toThrow();
  });

  it("非打标凭据 → tagged:false（普通代理凭据按未打标上报，不报错）", () => {
    expect(parseAndVerify(undefined)).toEqual({ tagged: false });
    expect(parseAndVerify("")).toEqual({ tagged: false });
    expect(parseAndVerify("Bearer xyz")).toEqual({ tagged: false });
    expect(
      parseAndVerify(`Basic ${Buffer.from("plainuser:plainpass").toString("base64")}`),
    ).toEqual({ tagged: false });
    // 非法 base64（Go StdEncoding 严格校验的对应分支）→ 未打标
    expect(parseAndVerify("Basic !!!not-base64!!!")).toEqual({ tagged: false });
    // 冒号缺失 → 未打标
    expect(parseAndVerify(`Basic ${Buffer.from("series-task-42-nocolon").toString("base64")}`)).toEqual({
      tagged: false,
    });
  });

  it("打标但身份非法 → 明确拒绝", () => {
    expect(() =>
      parseAndVerify(
        `Basic ${Buffer.from("series-task-notanumber:hmac").toString("base64")}`,
      ),
    ).toThrow("无效的任务代理标识");
    // 空 scope（~ 后 base64url 解码为空）
    expect(() =>
      parseAndVerify(`Basic ${Buffer.from("series-task-42~:whatever").toString("base64")}`),
    ).toThrow();
  });
});

// ─── 端到端：echo 上游 + 桩 db + 网关 ────────────────────────────────────────

interface UpstreamRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Minimal execution lifecycle fixture; destinations have no approval state. */
function stubDB(opts: {paused?:boolean}) {
 const db={tasks:()=>({getTask:async()=>({exploration_id:42,status:'running',paused:opts.paused===true,queued:false})}),exploration:()=>({getNode:async()=>({kind:'intent',state:'running',payload:{}})})} as unknown as Database;
 return {db};
}

let upstream: http.Server;
let upstreamRecords: UpstreamRecord[] = [];
let upstreamAddr: string;

let echoTCP: net.Server;
let echoTCPAddr: string;

let gatewayAllow: EgressGateway;
let gatewayDeny: EgressGateway;


beforeAll(async () => {
  // echo HTTP 上游：记录方法/路径/头/体并回显。
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: UpstreamRecord = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      upstreamRecords.push(rec);
      res.writeHead(200, { "Content-Type": "application/json", "X-Upstream": "echo" });
      res.end(JSON.stringify({ ok: true, method: rec.method, url: rec.url, body: rec.body }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamAddr = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  // TCP echo：CONNECT 隧道测试的上游。
  echoTCP = net.createServer((sock) => {
    sock.pipe(sock);
  });
  await new Promise<void>((r) => echoTCP.listen(0, "127.0.0.1", r));
  echoTCPAddr = `127.0.0.1:${(echoTCP.address() as AddressInfo).port}`;

  const allow = stubDB({});
  gatewayAllow = await startEgressGateway(allow.db, "127.0.0.1:0");

  const deny = stubDB({paused:true});
  gatewayDeny = await startEgressGateway(deny.db, "127.0.0.1:0");
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([
    gatewayAllow.close(),
    gatewayDeny.close(),
    new Promise<void>((r) => upstream.close(() => r())),
    new Promise<void>((r) => echoTCP.close(() => r())),
  ]);
}, 60_000);

/** 经网关发一条普通代理请求（绝对 URI 请求行 + 目标 Host 头，curl -x 形态）。 */
function proxiedRequest(
  gateway: EgressGateway,
  target: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const [host, port] = gateway.addr.split(":");
    const req = http.request({
      method: init.method ?? "GET",
      host,
      port: Number(port),
      path: target,
      headers: { host: u.host, ...init.headers },
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

describe("普通 HTTP 代理转发", () => {
  it("带（mock 授权通过的）凭据：转发成功，方法/头/体保持，上游收不到 Proxy-Authorization", async () => {
    const creds = taskCredentials(42, "worker:7")!;
    const res = await proxiedRequest(gatewayAllow, `http://${upstreamAddr}/echo?x=1`, {
      method: "POST",
      headers: {
        "Proxy-Authorization": proxyAuthorizationHeader(creds),
        "X-Custom": "keepme",
        Authorization: "Bearer target-token",
      },
      body: "hello=egress",
    });
    expect(res.status).toBe(200);
    const seen = upstreamRecords.at(-1)!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/echo?x=1");
    expect(seen.body).toBe("hello=egress");
    expect(seen.headers["x-custom"]).toBe("keepme");
    expect(seen.headers["authorization"]).toBe("Bearer target-token"); // 目标自身的 auth 保持
    expect(seen.headers["proxy-authorization"]).toBeUndefined(); // 内部凭据绝不到目标
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, body: "hello=egress" });
  });

  it("暂停任务 → 403，不触达上游", async () => {
    const before = upstreamRecords.length;
    const creds = taskCredentials(42, "worker:7")!;
    const res = await proxiedRequest(gatewayDeny, "http://blocked.example:80/path", {
      headers: { "Proxy-Authorization": proxyAuthorizationHeader(creds) },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("执行已停止");
    expect(upstreamRecords.length).toBe(before); // 上游零接触
  });

  it("篡改凭据 → 403（验签失败在任何授权之前）", async () => {
    const before = upstreamRecords.length;
    const res = await proxiedRequest(gatewayAllow, `http://${upstreamAddr}/x`, {
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from("series-task-99:deadbeef").toString("base64")}`,
      },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("任务代理");
    expect(upstreamRecords.length).toBe(before);
  });

  it("未带凭据的流量：直接放行（与 Go 一致：独立聊天/enrich 不打标）", async () => {
    const res = await proxiedRequest(gatewayAllow, `http://${upstreamAddr}/plain`);
    expect(res.status).toBe(200);
    expect(upstreamRecords.at(-1)!.headers["proxy-authorization"]).toBeUndefined();
  });
});

describe("CONNECT 隧道", () => {
  function connectThrough(
    gateway: EgressGateway,
    authority: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; socket?: net.Socket }> {
    return new Promise((resolve, reject) => {
      const [host, port] = gateway.addr.split(":");
      const req = http.request({
        method: "CONNECT",
        host,
        port: Number(port),
        path: authority,
        headers,
      });
      req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
      req.on("error", reject);
      req.end();
    });
  }

  it("带授权通过的凭据：CONNECT 建立且双向字节透传", async () => {
    const creds = taskCredentials(42, "worker:7")!;
    const { status, socket } = await connectThrough(gatewayAllow, echoTCPAddr, {
      "Proxy-Authorization": proxyAuthorizationHeader(creds),
    });
    expect(status).toBe(200);
    expect(socket).toBeDefined();

    const echoed = await new Promise<string>((resolve, reject) => {
      const sock = socket!;
      const chunks: Buffer[] = [];
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on("error", reject);
      sock.write("ping-through-tunnel");
      const timer = setTimeout(() => reject(new Error("echo timeout")), 5_000);
      sock.on("data", () => {
        const got = Buffer.concat(chunks).toString("utf8");
        if (got.includes("ping-through-tunnel")) {
          clearTimeout(timer);
          resolve(got);
        }
      });
    });
    expect(echoed).toContain("ping-through-tunnel");
    socket!.end();
  });

  it("暂停任务的 CONNECT → 403", async () => {
    const creds = taskCredentials(42, "worker:7")!;
    const { status, socket } = await connectThrough(gatewayDeny, "blocked.example:443", {
      "Proxy-Authorization": proxyAuthorizationHeader(creds),
    });
    expect(status).toBe(403);
    socket?.destroy();
  });

  it("未带凭据的 CONNECT：放行（本地回环 echo 仍可达）", async () => {
    const { status, socket } = await connectThrough(gatewayAllow, echoTCPAddr);
    expect(status).toBe(200);
    socket?.destroy();
  });

  it("无法解析的 CONNECT 目标 → 400", async () => {
    const { status, socket } = await connectThrough(gatewayAllow, "no-port-host");
    expect(status).toBe(400);
    socket?.destroy();
  });
});
