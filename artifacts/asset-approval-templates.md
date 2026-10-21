# 任务资产审批模板

> 历史设计记录：资产审批与动作拦截已于 2026-10-19 移除。当前行为以 `apps/server/README.md` 和源码为准；本文审批相关内容不再适用。

新任务默认 `all_assets`；旧任务及缺少字段的旧归档使用 `explicit_targets`。

| 值 | 页面名称 | 自动批准范围 |
| --- | --- | --- |
| `all_assets` | 全部资产免审批 | 所有合法新发现，包括与原始目标无关联的资产 |
| `related_assets` | 关联资产自动批准 | 用户明确提供的资产、其根域下域名、有 A/AAAA 记录依据的解析 IP |
| `explicit_targets` | 明确目标免审批 | 精确主机及其服务接口，明确声明的通配域或 CIDR 范围 |

三个模板都保留用户主动封禁、撤回、删除以及输入校验、任务隔离和其他 Guard 规则。“全部免审批”不等于关闭安全检查。来源任务仍只读。

## 接口

- 创建任务：`POST /api/tasks` 增加可选 `asset_approval_template`；省略使用 `all_assets`，无效值返回 400。
- 修改模板：`PUT /api/tasks/{id}/asset-approval-template`，正文 `{"asset_approval_template":"explicit_targets"}`。仅首次运行前可改；数据库锁内校验，并与资产写入串行协调。
- 聚合审批：`GET /api/tasks/{id}/asset-approvals?group_by=host`，返回 `group_key`、`asset_ids`、`record_types`、`sources`、`mixed_state`。省略参数保留逐记录查询。
- 批准、撤回、封禁接口支持 `{"group_keys":["任务ID|host:主机名"],"reason":"原因"}`，与 `asset_ids` 二选一。客户端应使用查询返回的分组标识，不自行构造。分组展开与整批校验在事务内完成。

同一主机的 DNS 记录不物理合并；审批界面按主机和授权所属任务聚合。状态冲突按封禁、撤回、待审批、已批准取最严格状态。来源任务分组不可直接修改。

## 来源与异常数据

用户手动添加、任务创建时选择或关联企业、任务描述中的明确目标，统一展示“用户提供”。描述登记只开放给目标分解器，要求原文依据；初始化种子也复用原文核验，不能把参考或禁止项当作目标。

`task_asset_grants` 保存用户的精确主机、域名范围及网段授权，并随任务归档恢复。发现、模板匹配和授权判断不依赖模型自行声明来源。

Agent 输入 `www_host`、变量占位符或非法 URL 时，错误项在写入前拒绝，不创建副作用资产。合法 TXT/SRV 的下划线记录名存放在真实父主机的 `extra.dns_records` 中，不建立对应的可测试主机。

旧非法 Agent 主机以 `block_kind=invalid` 隔离并保留审计；普通批准和重新关联不能解除。应提供纠正后的合法资产，而不是把占位符批准为测试目标。自由格式手动信息不套用 Agent 主机输入规则。

服务和接口只继承有效主机授权：精确主机批准后，不被自动创建的待审批上级根域阻挡；明确撤回或封禁仍优先。查询、意图领取、工具执行和测试状态写入沿用统一授权入口。

## 验证入口

- Go：`db/asset_templates_test.go`、`server/asset_templates_test.go` 及原有资产授权、Worker 取消、归档测试。
- 前端 Mock：在 `web` 下运行 `npx tsx --test src/lib/mock/asset-approval-templates.test.ts`。
- 数据库测试必须使用独立 `SERIES_PG_DSN`，不得指向业务库。
