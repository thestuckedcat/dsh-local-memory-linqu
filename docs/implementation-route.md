# 05 本地记忆实施路线与来源

更新：2026-11-07。状态：Task 1/2已有组件验收；Task 3宿主接口、Provider桥接、当前消息钩子与作业执行授权组件已通过独立复审；**2026-11-07把上述组件接成v0.2.0可安装插件（M1闭环＋基础管理/年度子集），已本地全量测试、真实安装库探针与桌面profile安装验证**。未使用真实业务模型API做提炼/召回，未做完整GUI视觉走查。本文件保留“每个项目开工前说明路线和各来源机制”的开工说明，并在末尾追加本轮实施记录。

## 路线

1. **MEM-01：独立本地后端。** 固定来源、许可、运行时和宿主基线；实现显式scope、来源版本、SQLite/FTS、中文检索、重开持久化与同源去重。已完成组件验收。
2. **MEM-02/03：受控智能提炼与生命周期。** 持久任务队列固定入队时Provider/model/scope/来源/代次；预算、结构化结果校验、unknown；更正与独立权威删除账本，阻止晚到结果和旧备份复活。新增独立年度工作记录collection，粗粒度项目/需求/探索及本人贡献、结果、时间与证明状态。已完成组件验收，详见[测试与评审](task2-review.md)、[机制说明](task2-mechanisms.md)。
3. **MEM-04：原生插件。** 一个writer，接Harness事件和批准Provider，提供召回与本地管理入口，注册和卸载幂等；年度工作记录具备缺证对话提醒和本地带引用导出。作业执行许可见[当前评审](task3-execution-review.md)及[机制](task3-execution-mechanisms.md)：queue内默认deny、同lease撤权、提炼prepare/stream及提交前后复核，直接复用原事务/预算/桥接，自行实现授权合同，不新增上游代码。**2026-11-07已完成M1集成**：项目目录/多仓scope绑定、真实Host准入与执行授权映射、轮询调度/重启恢复、`llm/stream`最终请求门、同源管理API、`/memory`命令、模型工具、客户端记忆中心；详见下文“2026-11-07 M1插件实施记录”。
4. **验收与安装。** 本地行为、隔离真实宿主、负向出口和独立评审通过后，沿用已有授权安装并以已注册API做合成测试。高级向量、多Agent MCP及额外UI后置。2026-11-07已在本机desktop profile安装linked bundle并核对插件行/状态API/客户端slot；真实业务Provider调用和OS级出口证明仍留后续。

首个可验交付是MEM-01后端，不声称它本身是可安装记忆plugin。v0.2.0已把前三任务接成可安装首版（M1闭环），但M2/M3与完整M4/M5仍未交付。

## 2026-11-07 M1插件实施记录

本轮没有采纳新的上游来源：来源固定表保持上表不变；新增代码均为本项目实现，复用已受审组件（`plugin/harness-provider.mjs`、`plugin/session-hooks.mjs`、`src/jobs.mjs`、`src/lifecycle.mjs`、`src/work-summary.mjs` 等）。新增模块与职责见[m1实现合同](m1-plugin-design.md)与[完整机制](mechanisms.md)。

| 本轮新增 | 机制/边界 |
|---|---|
| `plugin/configuration.mjs` | 配置fail-closed；批准路由按configDigest版本化；数据根必须本地固定盘绝对路径 |
| `src/projects.mjs`、`plugin/project-registry.mjs` | catalog单writer、项目/多仓bindingRevision、会话按最具体worktree绑定scope、退休保留store、config漂移degraded不覆盖用户数据 |
| `plugin/host-grants.mjs` | 准入回执绑定活会话/项目/开关/路由/来源锚；执行lease一次purpose消费、同lease撤权abort、unknown仅用户确认可解 |
| `plugin/scheduler.mjs` | 每scope单任务、全局并发1、启动显式恢复中断、无unknown重发、有界幂等stop |
| `plugin/final-projection.mjs` | `llm/stream`最终dispatch前重核；每次请求都复核历史中本插件消息；失败零dispatch并返回`memory_projection_stale`；深冻结请求零改写 |
| `plugin/index.mjs`、`client.js` | Host装配与降级状态、工具/命令/HTTP、记忆中心三tab；客户端无Harness包导入 |
| `plugin/management.mjs`、`plugin/work-management.mjs`、`plugin/proof-reminders.mjs`、`src/reports.mjs` | 管理API actor模型/user-only、同源校验与幂等；年度草稿→缺证提醒→审定→本地Markdown/JSON导出；`REPORT_STALE` |
| `plugin/harness-sdk.mjs` | 插件不可import Harness运行时包，故实现最小等价message/BlockAssembler（形状与已核安装库一致） |

验证（2026-11-07，命令均在05目录）：
- `.\runtime\node.exe --test tests/*.test.mjs` → 258/258通过（Node 26.13，TAP与摘要见`evidence/m1-node26.tap`、`evidence/m1-verification.json`）。
- `.\runtime\node.exe tools\test-m1-host.mjs` → 真实安装库Cordis/LlmRuntime探针3/3：`llm/stream` waterfall存在、监听器可放行/短路dispatch、最终门删除后阻断零派发（`evidence/m1-host-probe.json`）。
- 安装：desktop profile linked bundle `dsh-local-memory-linqu@0.2.0`，插件行`include:dsh-local-memory-linqu` fiber active；`POST /dsh-local-memory/api` 返回`state:ready`；客户端`settings.section`注册项`local-memory` active（见`evidence/m1-install-verification.json`）。
- 未证明：真实业务Provider调用、完整GUI视觉走查、OS级出口/子进程/DNS证明；M2 abstract共享与M3冷档未实现；证据正文读取的异步用户确认接缝未接（README已知限制）。

## 来源与具体机制

| 来源与锁定基线 | 借鉴机制 | 采用方式与边界 |
|---|---|---|
| [kovey/dsh-memory 0.3.2](https://github.com/kovey/dsh-memory/tree/73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c)，commit `73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c` | 独立CJK切分、双字索引、混合中英文查询表达式 | 仅直接复用原字节`dist/store/sqlite/cjk.js`。正式vendor的Git blob已与上游`b2ad929db70287f2e6b2647955d91df0abb523e4`一致；不装整个上游。 |
| 同一固定kovey版本的scope/recall、Provider提炼与hook源码 | 项目召回、路由选择、agent/pre-step及提炼触发接缝 | 只作设计/接口参考。原scope全局回退、执行时重选路由、自动导入、Git同步和远端embedding不采用。Task 2边界及当前hook自行实现，未合入上游hook/db。 |
| 本机DeepSeek Harness `0.2.1-rc.5`，build `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916` | 现有Provider、消息构造、工具注册、Agent生命周期、会话append和资源清理 | 直接依赖实际宿主服务，不复制Host。已在内嵌运行时挂真实LLM/SDK/Context/SessionStore/AgentRegistry和fiber测试，核Controller来源及loop顺序；agent/adapter/grant仍是合成替身，完整profile/真实Provider旅程待验证。 |
| SQLite / FTS5，来自本机运行时`node:sqlite` | 参数绑定、事务、本地外部内容全文表及触发器同步 | 使用标准数据库能力，records/schema/身份和错误处理为本项目实现；未导入上游records/db/log模块。FTS不可用时明确拒绝，不扩大范围回退检索。 |
| [SPDX标准Apache-2.0文本](https://github.com/spdx/license-list-data/blob/main/text/Apache-2.0.txt)，取件Git blob `137069b823873b8bcf42979bcf8e9371052d26a2` | 第三方许可文本物料 | 不是记忆机制或运行依赖。保留上游manifest许可声明和来源；不冒称kovey提供了根LICENSE/NOTICE。 |

RestRegular、Hindsight、Mneme、OpenViking等保留为调查对照，当前没有合入其代码或服务。它们不是本轮实现来源；若后续采用，先补具体机制、锁定来源与变更理由。

## 本项目独立补强

- 可信调用方显式绑定项目、工作树、revision/dirty及构建变体；模型不能选存储路径或扩大scope。来源版本和同源证据去重独立保留。
- 源码准入在vendor执行前校验原字节、封闭依赖集合和许可；它不是任意JavaScript安全扫描器，也不防有权限者替换整个插件。
- 秘密模式过滤只是一层防线，不能承诺识别任意短密码；凭据来源隔离和模型输入边界在后续Host/队列层落实。
- 删除账本、缓存有效性、旧备份和在途任务规则由本项目实现；Task 2已提供组件级删除/恢复入口，具体边界见阶段机制说明。
- 出口验证覆盖宿主及子进程。安装包声明更新服务，后续不能仅据插件源码无fetch判定宿主无外发。

## 首个验收与证据边界

当前验收命令：在05目录执行`.\runtime\node.exe --test tests/*.test.mjs`（258/258），`.\runtime\node.exe tools\test-m1-host.mjs`（真实安装库`llm/stream`/最终门探针3/3），旧执行授权runner仍保留历史证据身份。测试只用临时合成资源、FakeHost与假adapter；真实安装库探针挂真实Cordis/LlmRuntime但adapter为合成。业务模型请求、完整GUI视觉走查、OS出口、M2共享、M3冷档尚未验收。历史阶段报告/runner为历史快照，当前验收以`evidence/m1-*`与本轮评审为准。

新增年度工作维度的来源是用户要求，不是新合入的框架；模板仍待用户提供。完整项目交付时按[机制说明合同](shared/mechanism-document-contract.md)编写[完整机制](mechanisms.md)，重点为后续skill改进说明触发、判断规则、提醒、工具/证据与硬边界。
