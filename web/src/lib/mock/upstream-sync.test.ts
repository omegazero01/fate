import assert from "node:assert/strict";
import test from "node:test";
import type { MCPServer } from "../types";
import { mockHandle } from "./handler";

test("SSE MCP 保存及重新读取保留传输方式与 URL", async () => {
  const { id } = await mockHandle<{ id: number }>("POST", "/mcp", JSON.stringify({
    name: "sync-sse", transport: "sse", url: "https://example.com/sse", env: { Authorization: "test" },
  }));
  const { servers } = await mockHandle<{ servers: MCPServer[] }>("GET", "/mcp");
  const saved = servers.find((server) => server.id === id);
  assert.equal(saved?.transport, "sse");
  assert.equal(saved?.url, "https://example.com/sse");
  const invalid = await mockHandle<{ ok: boolean }>("POST", "/mcp/test", JSON.stringify({ transport: "sse", name: "invalid" }));
  assert.equal(invalid.ok, false);
});
