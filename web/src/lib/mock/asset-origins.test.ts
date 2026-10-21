import assert from "node:assert/strict";
import test from "node:test";
import type { Activity, Asset } from "../types";
import { mockHandle } from "./handler";

type Page = {
  items: Activity[];
  earliest_cursor: number;
  latest_cursor: number;
  has_more: boolean;
  has_newer: boolean;
};

test("资产来源可打开原始调用，窗口连续且限制在所属任务和会话", async () => {
  const { assets } = await mockHandle<{ assets: Asset[] }>(
    "GET",
    "/assets?task_id=t-acme-web",
  );
  const row = assets.find((x) => x.domain === "new-api.acme.com");
  assert.ok(row);
  const source={available:true,task_id:1,session:'main:0',activity_id:0,tool_use_id:`mock-insert-${row.id}`};
  const history=await mockHandle<Page>('GET','/exploration/activity/history?task=1&session=main:0');
  source.activity_id=history.items.find(x=>x.tool_use_id===source.tool_use_id && x.kind==='tool_use')!.seq;
  assert.ok(source?.available);
  const query = new URLSearchParams({
    task: String(source.task_id),
    session: source.session,
    around: String(source.activity_id),
    limit: "2",
  });
  const page = await mockHandle<Page>("GET", `/exploration/activity/history?${query}`);
  assert.deepEqual(
    page.items.map((x) => x.kind),
    ["tool_use", "tool_result"],
  );
  assert.ok(page.items.every((x) => x.tool_use_id === source.tool_use_id));
  assert.ok(page.has_more && page.has_newer);
  const command = await mockHandle<{ detail: string }>("GET", `/exploration/activity/${source.activity_id}?task=1`);
  assert.match(command.detail, /new-api.acme.com/);
  const before = await mockHandle<Page>(
    "GET",
    `/exploration/activity/history?task=1&session=main:0&before=${page.earliest_cursor}`,
  );
  const after = await mockHandle<Page>(
    "GET",
    `/exploration/activity/history?task=1&session=main:0&after=${page.latest_cursor}`,
  );
  assert.ok(before.items.every((x) => x.seq < page.earliest_cursor));
  assert.ok(after.items.every((x) => x.seq > page.latest_cursor));
  assert.equal(after.has_newer, false);
  query.set("task", "t-acme-api");
  await assert.rejects(mockHandle("GET", `/exploration/activity/history?${query}`));
  query.set("task", "1");
  query.set("session", "plan");
  await assert.rejects(mockHandle("GET", `/exploration/activity/history?${query}`));
});
