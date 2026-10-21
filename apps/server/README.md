# SERIES TypeScript 后端

后端以 pi SDK 1.3.0 管理模型、会话、工具执行与扩展生命周期，以 PostgreSQL 保存双图黑板和任务状态。Engine 负责调度，不能把领域状态机交给模型会话隐式决定。完整对照见 [迁移复核](../../docs/pi-core-reconciliation-20261017.md)。

## 开发与验证

```bash
# 仓库根目录
pnpm install

# 本地 PostgreSQL（已有容器时不要重复创建）
docker run -d --name series-ts-pg -e POSTGRES_USER=series -e POSTGRES_PASSWORD=series \
  -e POSTGRES_DB=series -p 127.0.0.1:5433:5432 postgres:16-alpine

cd apps/server
npx tsx src/index.ts -addr 127.0.0.1:18787
npm test
npm run build
```

配置来自 `config.json` 或 `SERIES_PG_DSN`、`SERIES_CONFIG`、`SERIES_SKILL_DIR`。首次进入 `POST /api/auth/init` 设置口令。测试默认连接 `series_test`，可用 `SERIES_TEST_PG_DSN` 指定专用测试库；不要指向业务数据库，集成测试会修改配置和清理夹具。

## 模块与职责

| 模块 | 职责 |
| --- | --- |
| `db/` | 全局资产图、任务探索图、锚点、任务范围、配置与幂等迁移 |
| `engine/` | 任务启动/暂停/恢复/结束、意图领取、worker 池、planner 唤醒、聊天运行状态 |
| `agent/roles.ts` | 四角色装配及工具边界；worker 执行，mainagent 沟通和编排 |
| `agent/coldgraph.ts` | 冷节点判定、digest 投影与原始证据保留 |
| `agent/resources.ts` | 按角色读取技能和 MCP 可见性，每次新会话刷新 |
| `pi/runner.ts` | 原生 SessionManager、扩展绑定/关闭、guard、预算、取消、会话压缩及事件归一化 |
| `pi/modelResolver.ts` | 每轮读取模型配置，按完整 profile 内容缓存 provider |
| `tools/` | 图查询、资产/事实/漏洞写回、意图与目标操作、自定义工具 |
| `egress/` | 流量代理与记录，执行身份、租约和暂停校验 |
| `http/` | REST/JWT、历史回放、SSE 增量及管理接口 |

领域工具仍由服务端定义，作为 pi 自定义工具注册。MCP 通过 pi 的 `createMcpExtension` 接入，技能通过原生资源加载器加载；不另建一套模型工具循环。SDK 类型也出现在角色和自定义工具装配层，因此不再声称“只有 pi/ 目录依赖 SDK”。

## 当前保证

- 下发先完成数据库提交再唤醒；worker 领取后立即处理下一条，空队列才等待。
- 同一进程内任务启动幂等；暂停/停止传递 AbortSignal 并等待当前执行结束。
- 普通聊天和目标编辑只初始化会话，不启动 Worker 池；Main 显式下发意图才请求调度。
- Main 使用角色绑定的本地、领域和 MCP 工具；Planner 仅在尚无 Worker 事实时进行每轮最多三次开局探测。执行工具共用任务归属、代理、执行租约和实时禁用检查。资产登记后直接可用，不进行资产审批或工具动作审批。
- Worker 在执行中用 `record_fact`、`report_finding` 边发现边写回，提交后立即可见；漏洞提交唤醒 Planner，普通事实不单独触发规划。无需检查点或完成工具，最终简短总结即可，完成事件在执行槽位释放后发送。
- 引擎以 `execution_stop` 保存本次结束原因及记录引用：正常返回 `done`，预算耗尽 `exhausted`，异常 `blocked`；目标是否达成由 Planner 根据证据判定。旧草稿和历史验收结果可读，未发布草稿不会自动升级为正式事实。
- worker 会话固定为 `data/sessions/exp<N>-worker-i<M>.jsonl`；主聊天按任务和分段保存。
- Planner 会话固定为 `data/sessions/exp<N>-planner.jsonl`，每轮复用原 PI JSONL，结束后释放运行器和 MCP／终端资源。首次从当前双图建基线，后续只追加未交付或版本变化的投影；目标、活动意图、调度和约束在每次请求边界读取当前数据库，不反复追加到会话。宿主交付批次关联会话条目，只确认实际交付事件，恢复时不重加已保存输入。
- Planner 原文通过 `context_search(source="planner_session", q=...)` 和 `context_get(items=[{ref:"session:<entry_id>",field:"/content"}])` 召回；仅当前任务 Planner 可读，支持快照分页和 Unicode 续读。PI 原生压缩保留规划理由、否定证据、未完成事项和 ID／版本，原始 JSONL 不删除；压缩失败或文件损坏保留原文并报错。历史摘要不能替代最新双图查询。唤醒、直接派单、Worker 写回和暂停恢复机制不变。
- 历史检索固定到本轮开始前的条目，过滤查询本身及纯召回副本，原始条目仍可按已有引用读取；分段返回 `segment` 明示本次读取范围，未返回部分不能当作已读。冷图摘要生成后再截取领域事件，摘要与对应事件在同轮交付；触发文案同时说明持久化通知与领域变化，避免误报“无新事件”。这些约束不替代原始测试证据，历史中的泛化结论仍须按实测范围复核。
- Planner 结论由宿主出具执行回执：只确认本轮实际成功的 `add_intent` 结果、目标现有状态及原文返回范围；模型自由文本不作为方向已否定或全文已读的凭据，也不额外请求模型修正。模型原文完整保留于 PI JSONL，可通过原 `session:` 引用召回；后续请求及原生压缩使用对应宿主回执的投影，不改写原文件。
- `context_get` 返回宿主生成的 `read_receipt`，以来源哈希、版本、字段/关系页与 Unicode 区间记录实际交付。重叠和乱序区间合并，版本/内容变化重新计算；只返回尾段、失败结果、旧格式或摘要不产生全文已读证明。读取账本从原生工具结果重建，跨重启和压缩保留，最新版本与权限重新检查。
- `negative` 仍保留为 Worker 的原始负面报告；`confirmed`、高置信度、资产锚点和覆盖率都不是宿主核验的测试矩阵。没有可核验范围时，未测方向状态保持 `unknown`，不能用该报告调用 `prove_goal` 自动关闭目标。本改动没有伪造历史测试范围、修改旧事实或增加新的完成工具。
- 冷图仅折叠投影，保留原节点、因果边及资产锚点；图或锚点变化使旧 digest 失效。
- 最终活动先持久化再广播；临时 delta 单独传输，不推进历史游标。工具调用 ID、主聊天分段和消息流 ID 保留到前端。
- 模型错误可见，连续工具调用有轮数上限；达到预算可有限收尾，墙钟超时直接取消。

这些保证由本地 pi faux provider、独立 PostgreSQL、stdio MCP 夹具和本机命令/PTY 回归验证；页面验收使用隔离数据库。真实服务商和远程 MCP 仍需环境验收。

## 尚未完成的迁移

旧版流量证据/MITM、复测、旁路提问、任务模板/归档、ScopeSentry 同步、模型池/录制与完整重试策略仍有缺口；旧路径在 `http/routes/removed.ts` 中显式返回 404。附件对话尚未接入，提交附件返回明确错误。不能把这些接口或页面算作已恢复能力。

LLM 基础协议、角色绑定及配置刷新已接入；高级代理、限流、额度故障切换、全局任务 FIFO 仍需统一调度设计。MCP 的 stdio 和 Streamable HTTP 使用原生实现；旧 SSE、insecure 配置及远程服务需兼容验收。自定义工具运行时已接入，但管理页测试器及目录/延迟加载等元数据尚未完全统一。具体接口契约与验收条件见迁移复核文档。

## ARTEX / PI 流程（2026-10-19）

Planner 的 `add_intent` 事务提交即进入 frontier，领取时才占 Worker 槽位；正常总结直接结束。宿主保存实际依据版本、确认已交付事件，保留去重、取消、租约和执行前校验。无须 `record_plan_decision`，整图变化不撤销无关派单。

`context_search` 统一检索节点及显式选择的 activity；`context_get(items)` 支持 node/activity 引用、detail/output/parents/members 视图、字段读取和 Unicode 分页。旧单节点参数仍可调用，旧 trace 权限继续控制活动详情。`record_fact(facts)` 按条目独立提交和去重，不影响单条接口。

交互终端由会话级 PI 扩展和 node-pty 实现 `shell_open/send/read/close/list`，普通命令继续用 PI Bash。终端句柄在执行结束或暂停后失效。首次安装会修复包内 macOS spawn-helper 的执行位；没有额外常驻服务。`shell` 目录项作为命令环境说明附到 Bash，原有可执行配置迁移前备份。

Main／Planner 运行中纠偏使用 PI `session.steer()`；Worker 页面只保留只读记录及暂停、恢复按钮。旧 `/intents/:id/messages` 返回 410，不创建消息。暂停等待执行器和终端退出，之后才能恢复原意图和 PI 会话；重复恢复不重复执行，任务整体暂停、排队或终态时拒绝单 Worker 恢复。暂停后的 Main 查询和编辑仍可使用。新会话默认 native 压缩，显式 domain 设置保持有效。

Main 下发或选择运行中意图时，事务内订阅宿主验证的原会话分段；选择运行中工作不重复派单。Worker 释放执行资源后回传结果，回传不调用模型，其他主会话不自动接收。

真实模型验收入口为 `scripts/real-mcp-acceptance.mts`，创建独立数据库、会话目录和端口，复制现有 DeepSeek 配置并只读访问 DeepWiki 的 node-pty 文档。验收角色 `max_turns=0`、`run_seconds=0`，任务无截止时间；请求数和 token 只作统计。OpenAI 兼容配置未设置输出限制时，不注入输出 token 上限。`scripts/verify-real-mcp-acceptance.py <证据目录>` 校验写回、暂停、订阅和恢复证据。

升级时停止旧执行器、备份数据库和数据目录，再启动新版；启动中的幂等升级仅替换精确匹配的旧默认值，保留自定义/禁用配置及历史草稿、结果、会话。未激活旧规划提案须重新验证。验收夹具为 `src/engine/artex-flow.test.ts`、`src/pi/terminal.test.ts`；比较脚本为 `scripts/artex-compare.mts`，通过 `FATE_BASELINE` 指向修改前源码快照运行。

### 同夹具开销对比

以修改前工作区快照和当前版本分别运行本地确定性模型，使用独立数据库，保留默认交互终端配置：

| 角色 | 模型请求（前→后） | 默认工具（前→后） | 累计消息字节（前→后） |
| --- | --- | --- | --- |
| Planner | 2 → 1 | 18 → 23 | 26,499 → 17,302 |
| Worker | 1 → 1 | 20 → 20 | 14,216 → 15,651 |
| Main | 1 → 1 | 18 → 27 | 10,455 → 18,637 |

字节数是 faux 模型收到的序列化消息体积，不是服务商计费 token。去除结束协议使正常 Planner 少一次请求、累计消息约减少 35%；恢复 Main/Planner 执行能力增加了单次上下文和工具数，不能据此声称所有维度都变小。Worker 删除五个旧查询工具、增加五个终端工具后，总数保持不变。完整数据及页面验收证据在 `docs/reviews/evidence/artex-alignment-20261019/`。

## 审批与拦截移除（2026-10-19）

资产审批模板、待审批/封禁状态、动作拦截规则和 LLM 审批器已移除，旧接口返回 404。升级前停止旧执行器并备份数据库；启动时幂等归档旧记录到 `retired_feature_data`，删除对应活动表、字段及触发器。保留资产与图谱内容、来源关联、任务隔离、暂停/取消、执行租约及配置中的工具绑定。内置提示词及工具描述只精确升级已识别的旧默认内容，自定义内容和历史版本保留。
