# SERIES 资产图与双图规划实现验收

日期：2026-10-19。基准：SERIES `78ab23f77da8fb111d3f6e9b2bea626cecaffdfc`。生产版本：`series-assets-20261019`。

已实现并部署本轮资产图改造。保留 PI SDK 1.3.0、既有按钮暂停恢复和结果订阅；未恢复资产审批、封禁或动作拦截。身份、任务隔离、执行租约和暂停校验继续有效。

## 实现

- `asset-write.ts` 统一六类资产输入、自然键、URL/域名/IP 规范化和追加合并。补齐工具字段 Schema；新 `assets/results/errors` 与旧 `items/name/inserted` 兼容。字符串 DNS 值转单元素数组，TXT 不拆分；A/AAAA 观察值补齐 IP，服务和接口补齐主机。每项独立事务同时提交资产、来源、显式意图锚点及范围；按执行身份、调用 ID、条目序号去重。失败项回滚，旧租约无法重试写入。
- `asset-query.ts` 与 `asset-dsl.ts` 共用于 REST、Agent、数量和图形。任务集合为本任务及直接、未删除的来源任务，按资产 ID 去重；来源只读、不递归。资产记录数与独立主机数分别统计；覆盖度按范围、锚点和已测集合计算。发现、写回和 Worker 完成均不自动标记已测。
- 新 `asset_search/asset_get` 提供摘要、未测筛选、字段组与 Unicode 续读，保留旧读取工具兼容入口。REST 补齐完整 DTO、DSL、批量登记及 ID/别名读取。
- 资产图使用完整集合，去除 500 条截断；优先真实根域，缺失时使用不计入统计的连接节点。端点显示方法与 URL，详情显示参数、指纹、DNS；资产与意图/事实/漏洞可双向跳转。修复图表在隐藏标签初始化为 100×100 后不随容器恢复的问题。
- Planner 同轮获取资产覆盖摘要、主机数及探索图信息；显式发现资产锚定执行意图。有效字段、任务关联、范围、来源及来源可见性变化进入持久化事件，由现有防抖机制合并。事实直接可读；PI 继续负责循环、会话、MCP 和取消，未添加结束工具或额外模型回合。
- 默认工具升级采用一次性精确匹配，保存原配置；历史别名及修复脚本支持预览、幂等执行和对账。

## 验证

| 检查 | 结果 |
|---|---|
| 后端完整回归 | 44 个文件，451 通过、1 跳过 |
| 最后接口/资产回归 | 22 通过 |
| 前端逻辑 / mock 回归 | 50 / 12 通过 |
| 后端编译、前端类型检查和生产构建 | 通过 |
| `git diff --check` | 通过 |
| 生产健康检查、资产列表与接口字段 | 通过 |

跳过项为独立回归库没有 DeepSeek 配置时的 `/api/llm/models` 网络用例；真实模型验收另行执行。后端回归包括并发去重、旧租约拒绝、部分失败回滚、事件不泄漏、多 IP、IPv6、TXT/SRV、参数合并、直接来源撤回/删除、覆盖关闭、超过 500 个资产和旧 ID 解析。

SERIES 对照证据：实际 Go 输出的 9 个 URL 与 9 个 DSL 夹具已保存，TypeScript 规范化及查询结果一致。其余六类资产身份、合并、派生、分页、计数、覆盖与父节点顺序按固定版本源码规则编写数据库契约测试。本轮没有对 SERIES 的整个 Go 应用执行全量跨语言端到端差分；未知 DSL 字段改为明确错误、审批机制删除属于已确定差异。

## 真实模型与远程 MCP

隔离库使用现有 DeepSeek 配置及官方 DeepWiki MCP，只读取公开 `microsoft/node-pty` 文档。共 **54 次真实模型请求**；各角色 `max_turns=0/run_seconds=0`，无请求数、累计 token 或验收时长限制，所有请求均未注入输出 token 上限。

闭环：Planner 意图 #3 → Worker 真实 MCP 读取 → 登记新资产 #3、事实 #4 → 在 Worker 仍执行时独立确认事实可见 → Planner 读取新资产和事实，下发不同方向的意图 #5，依据明确引用事实 #4 → Worker 真实 MCP 读取并保存事实 #6。两个意图均正常结束，目标依据事实完成，未制造漏洞报告。

页面实际点击暂停与恢复；意图 #5 两次运行使用同一 PI session ID/path。暂停前后都有成功的真实 MCP 调用。为稳定复现中途暂停，测试入口在远程响应已经返回后阻止向 PI 交付；该控制只证明平台能取消等待，不证明远端计算被中止。首次等待触发 SDK 60 秒网络超时，随后另一次 MCP 调用在按钮暂停时被取消。恢复后先出现工具未重新发现错误，经 `tool_search` 后成功继续。输入 DSL 错误与受限的活动读取也按真实日志保存，未用模拟成功替代。

Main 在会话段 **2** 订阅正在执行的意图，宿主返回 `already_running` 回执；没有重复派单。暂停/完成反馈只到会话段 2，会话段 1 没有反馈，稳定事件去重且反馈发出时执行槽位已释放。Main 下一轮可召回事实和资产。旧 Worker `/messages` 返回 410，页面保留按钮控制、无直接聊天。

证据中的初始 `main_a/main_b` 种子标签与后来 UI 选中的会话段不同；以 `real-run/verification.json` 的实际会话段 2/1 和回传记录为准。

## 历史修复与生产切换

停机后最新数据包含 1,479 条资产：根域 613、子域 308、IP 62、服务 187、接口 130、应用 179。最新副本预演后，在生产执行 **237 项修复：218 个显式意图锚点、19 条 URL 规范化**。重复执行为 **0 项**。

修复前后六类数量、任务总数与状态、探索节点/边、活动记录摘要、自定义工具摘要及角色配置一致。没有将失败工具输入升格为资产，没有推测 IP、测试状态或漏洞结论。此次生产数据没有需要合并的确定重复项；最小 ID 合并及旧 ID 映射由独立回归验证。

保留并待人工核实的历史数据：
- 资产 #57：域名格式无效。
- 资产 #8836：`params` 包含非对象元素。

旧后端正常退出后备份数据库、会话、配置、密钥及旧构建；前端 HTTP 监听关闭后残留进程未退出，最终结束了该无状态前端进程。完成迁移和对账后启动新后端与新前端。生产页面和 API 均验证通过；#4842 保持暂停、#4843 保持完成、#4844 保持运行。生产现有角色预算配置原样保留，本轮没有新增限制。

备份：`/Users/pphua/.local/share/fate/backups/series-assets-deploy-20261019-211734`

服务：前端 `http://127.0.0.1:5173`，后端 `http://127.0.0.1:8787`，本地出口 `127.0.0.1:8788`。当前 PID 和部署时间见 `deployment.json`。如需回退，必须先停止新执行器；恢复备份会丢失切换后新增数据，应先另做备份。

## 证据索引

证据目录：`evidence/series-asset-graph-20261019/`。

- `backend-full-tests.log`、`backend-final-http-tests.log`、`web-tests.log`、`web-mock-tests.log`、`web-build.log`、`validation.json`。
- `reference-comparison.json`、`series-reference.json`：固定版本 Go 对照夹具。
- `real-run/run.json`：脱敏模型请求统计、实际 MCP、活动、事实、会话和状态时间线；`real-run/verification.json`：自动核对结果。
- `repair-release-preview.json`、`repair-production-applied.json`、`repair-production-idempotence.json`：最终预览、应用和重复执行。其他 repair 文件是较早副本或迭代记录，不代表最终生产修复数。
- `deploy-before.json`、`deploy-after-repair.json`、`production-health.json`、`deployment.json`：切换对账和健康检查。
- `worker-running.png`、`worker-paused.png`、`worker-complete.png`、`main-feedback.png`、`main-recall.png`：真实按钮和回传。
- `assets-methods.png`、`assets-query-error.png`、`coverage-graph.png`、`dualgraph-asset.png`、`dualgraph-intent.png`、`production-assets.png`：列表、错误态、层级、双向跳转和生产页面。

证据文件已按现有模型配置密钥逐一检查，无密钥泄漏。隔离模型配置已清空密钥；验收服务关闭。生产数据和服务保留。
