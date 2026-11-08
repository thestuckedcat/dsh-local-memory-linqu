# 05 本地长期记忆：统一产品待办与后续交接

版本 `MEM-TODO-5`，2026-11-09。**M1已实现并完成真实安装/最终请求门验证；M2的MEM-201/202/203已实现并自测，MEM-204事件消费器已实现（真实03事件源未接入）；v0.4.0体验/后台增量已交付 Phase A/B、摘录、整理 manifest/校验/队列/候选/版本、派生视图与删除传播、显式纠正挂起、M3 layout/journal 骨架；自动空闲派发、后台反思根因、M3实际搬移和完整GUI/真实Provider验收仍未完成。** 本文是05新增要求和未完工程的现行入口；旧Task 1/2/3报告保留各自受审基线，不由本文改写。安装包与验证证据见[README](README.md)、[M2证据](evidence/m2-verification.json)、[机制说明](docs/mechanisms.md)、[M2独立评审](docs/m2-independent-review.md)。

## 1. 已收束的产品形态

主形态为Harness原生plugin＋本地后端。开发者从“记忆中心”查看**经验记忆、年度工作记录**两个独立分区，以列表＋侧边详情连续核对；另有统一“处理任务”入口。聊天仅显示命中提示和必要的缺证提醒。无需05依赖08完成，08以后组合已有入口。

项目启用后自动从当前获准对话提炼，保留手动“记住这条”。普通经验校验后自动保存并可召回，明确标注“模型提炼、未核验”及来源；按当前问题自动召回，支持手动搜索。有命中才显示“本次召回N条经验”并可展开来源，**首版不提供单次跳过，只保留项目级召回开关**。未知项目时提示选择/登记，暂停记忆功能，普通聊天继续。

一个研发项目显式登记多个仓库，经验仍有工作树、版本和构建适用条件。项目普通经验二次压缩为abstract，在本地跨项目发现；Agent可发现摘要，但由用户确认才建立共享索引，之后自动跟随最新有效版本，按当前许可检索相关明细。年度工作记录和证明正文不自动参加共享。长期未调用记忆存非C盘冷档，再做语义合并压缩；摘要优先、明细按需，不能整库塞入上下文。

**源项目删除后，记忆独立保留。记忆中心明确“删除”即清除；可恢复内容使用单独“归档”动作。** 两者和会话移除是不同生命周期。年度维度自动形成项目/需求/问题探索的工作草稿，缺证明在对话中提醒，最终报告人工审定后本地导出Markdown/JSON。模型输出不等于本人贡献已核实。《年终总结维度.md》尚未提供，维度映射保持`pending_reference`，不妨碍先记录粗粒度事实。

上述依据为既有PF-01..05、PF-13、PF-06a及集中Q05明确答复。没有尚待用户逐项确认的机制问题；下文路径、阈值、频率、接口与布局细节均是**可修改设计决定**，不冒称用户逐项选定。真实Provider、项目与证明路径作为运行时配置，不在本轮索取。

## 2. 已完成组件和仍缺的用户旅程

| 基线 | 已有代码/证据 | 覆盖界限 |
|---|---|---|
| 本地SQLite/FTS、严格scope、来源/版本、同源去重 | `src/backend.mjs`、`src/scope.mjs`；[Task 1](docs/task1-review.md) | 现有scope是具体root/worktree/revision/build身份，不是逻辑多仓项目 |
| 持久队列、预算、结果校验、unknown隔离 | `src/jobs.mjs`、`src/provider.mjs`；[Task 2](docs/task2-review.md) | 没有完整Host自动scheduler；旧queued不能自动获得新授权 |
| 纠正、归档/恢复、权威删除账本 | `src/lifecycle.mjs`、`src/store-internals.mjs` | 不等于项目退休、跨项目共享或冷档删除传播已实现 |
| 独立年度记录/证明状态 | `src/work-summary.mjs`、`src/work-summary-evidence.mjs`；[年度设计](docs/work-summary-design.md) | 缺实际提醒、维度模板映射、人工审定报告与正式导出 |
| Provider桥接、当前消息hook、执行lease复核 | `plugin/`；[执行授权评审](docs/task3-execution-review.md)及[当前证据清单](evidence/task3-execution-verification.json) | 已有受审组件；真实Host grant/config映射、调度、主模型最终投影、UI及完整安装旅程仍缺 |

旧证据记录Node26组件125项、Host内嵌Node24组件及原生库共146项通过；这是此前组件验证。`docs/implementation-route.md`固定实际来源：仅直接复用kovey固定版本CJK文件，其余Provider/hook为接口参考和自行实现；RestRegular、Hindsight等没有合入。

### 2.1 2026-11-07 M1实施结果（v0.2.0）

| 新增交付 | 实际文件/入口 | 验证边界 |
|---|---|---|
| 配置与数据根、批准路由 | `plugin/configuration.mjs`、`configDesign`（`docs/m1-plugin-design.md` §4） | 未知字段/越界预算/非本地路径拒绝；路由版本随配置变化 |
| 逻辑项目/多仓目录与scope绑定 | `src/projects.mjs`、`plugin/project-registry.mjs`；catalog.sqlite v1 | 同scope冲突、退休保留、配置漂移degraded；会话按最具体worktree绑定 |
| 真实Host准入/执行授权 | `plugin/host-grants.mjs` | 回执绑定活会话+绑定项目+开关+批准路由+来源锚；同lease撤权signal abort；未知不自动解闸 |
| 自动调度与重启恢复 | `plugin/scheduler.mjs`；`src/jobs.mjs`新增只读`pending/list` | 每scope单任务、全局并发1、unknown不重发、有界幂等stop |
| 主模型最终请求门 | `plugin/final-projection.mjs`；`llm/stream` waterfall | 每次请求重核已注入消息；删除/归档/退休/偏好/授权/路由/正文变化→阻断且零dispatch；真实安装库探针3/3 |
| Host/Client入口 | `plugin/index.mjs`、`client.js`、`/memory`命令、11个模型工具、同源管理API | 安装后插件行active、`POST /dsh-local-memory/api` ready、客户端`settings.section`注册`local-memory` active |
| 年度草稿/证明提醒/报告/导出 | `src/work-summary.mjs`复用、`plugin/proof-reminders.mjs`、`src/reports.mjs`、`plugin/work-management.mjs` | 草稿/确认/证据/审定/两格式导出与STALE负例通过；证据正文读取仍需异步确认接缝（已知限制） |
| 验证与机制 | `tests/*.test.mjs`（258项）、`tools/test-m1-host.mjs`、`evidence/m1-*.json`、`docs/mechanisms.md` | 本地Node26 258/258；真实安装库探针3/3；未调用真实业务Provider、未做视觉走查、无OS级出口证明 |

本表不替代M2/M3：abstract共享（MEM-201/202/203）已于v0.3.0交付，`MEM-204`能力事件消费器已交付（真实03 outbox未接入）；冷档、跨项目向量/相关性合并仍未实现；年度维度模板仍`pending_reference`。

### 2.2 2026-11-08 M2实施结果（v0.3.0）

| 新增交付 | 实际文件/入口 | 验证边界 |
|---|---|---|
| catalog v1→v2显式迁移 | `src/projects.mjs`（v1签名校验、单事务新增表、user_version=2、失败保持v1） | 现有catalog真实迁移成功；漂移拒绝与幂等由`tests/projects.test.mjs`覆盖 |
| 项目abstract（抽取式二次压缩） | `src/abstracts.mjs`；`abstract_revisions/abstract_state`；`abstracts.*`配置；10分钟维护timer | basis绑定记录版本/来源；删除/纠正即时重建；10条/24h合并；非模型语义压缩 |
| 用户授权的跨项目共享 | `src/sharing.mjs`；`share_relations`；`abstract.list/refresh`、`share.discover/list/grant/revoke`、`shared.search` | 用户动作才能grant/revoke；grant必须当前abstract revision；自动跟随最新有效revision；撤权/删除即时断开；明细不复制 |
| 退休适用性 | `plugin/project-registry.mjs` applicabilityForProject/Scope；共享摘要/明细带applicability | current/historical_unknown/unavailable；退休源不自动获得新共享 |
| 模型入口 | 工具`memory_abstracts`、`memory_shared_search`（11→13个工具） | 工具不能grant/revoke/refresh；shared search只在active关系内 |
| 记忆中心第4个tab | `client.js`「项目摘要与共享」、`locale/*.json` | 静态/字典/渲染冒烟通过；真实页面视觉需重载后复核（未做截图验收） |
| 验证与机制 | `tests/abstracts/sharing/m2-management`等（全量318项）、`tools/verify-m2.mjs`、`evidence/m2-*`、`docs/m2-design.md`、`docs/mechanisms.md` MEM-MECH-4 | 本地Node26 318/318；真实安装库最终门回归3/3；真实数据根catalog已升v2；未做真实profile M2写入旅程、未调用真实业务Provider、无视觉/OS级出口证明 |

同日回归修复：`plugin/final-projection.mjs`的`llm/stream`监听器必须**同步返回`AsyncIterable`**；原`async`声明会让普通聊天与其他插件的模型请求收到Promise并报`stream is not async iterable`，属插件/Host接口硬合同缺陷。修复与证据见[流接口修复记录](docs/stream-contract-fix.md)；重启桌面Harness后普通流式对话已现场复验恢复。另对最终门做fail-closed加固：未登记的own召回消息阻断、无投影时不注入召回（见`docs/mechanisms.md` MEM-FINAL-02/03）。

## 3. 后续增量与退出条件

所有未勾选项均**待实现/待验证**。优先做一条真实入口闭环，避免新增大量底座却无法使用；已有安全边界不因闭环优先而省略。

### M1：单个登记项目的最小Host闭环

- [x] **MEM-101 范围与真实授权适配**：已实现`plugin/project-registry.mjs`、`plugin/host-grants.mjs`、`plugin/configuration.mjs`。登记逻辑项目、仓库列表及当前具体scope；真实Host会话/调用方/来源读取权限映射到现有入队准入与`authorizeExecution`。授权固定job、purpose、source/version/inputDigest、route及代次，同lease撤权使AbortSignal失效；不接受模型自报scope或布尔开关作为可信授权。证据：`tests/project-registry.test.mjs`、`tests/host-grants.test.mjs`、`tests/plugin-entry.test.mjs`。
- [x] **MEM-102 可见入口与调度**：已实现`plugin/index.mjs`、`plugin/scheduler.mjs`、`client.js`。提供登记/启用/手动记忆/搜索/来源/删除和任务状态，复用已有queue/provider/hooks。每scope一个在途任务，全局默认1个，轮询默认1秒；入队只登记，scheduler获取当前有效许可后执行，不重选Provider，不盲目重发unknown。证据：`tests/scheduler.test.mjs`、`tests/plugin-entry.test.mjs`、真实安装后`/dsh-local-memory/api`与客户端slot核对。
- [x] **MEM-103 主模型最终请求复核**：已实现`plugin/final-projection.mjs`。把召回集与确切source/version/grant/route绑定，在`llm/stream`水的最终dispatch前检查适用性与撤权；只撤回本插件追加内容，保留原用户消息和工具配对；现有pre-step投影不算此门通过。证据：`tests/final-projection.test.mjs`（含删除后同一请求阻断、`next()`零调用；未登记own消息fail-closed；不可注入未投影召回）与真实安装库探针`evidence/m1-host-probe.json`（3/3）。
- [x] **MEM-104 第一条闭环验收**：已在隔离临时profile/合成源（FakeHost + 真实SQLite/队列）跑通：登记→启用→当前对话提炼→持久保存→新会话命中→查看来源→纠正→删除→重启及晚到结果不能复活；真实Host侧安装、最终请求门（真实Cordis/LlmRuntime）和撤权/负例分别验证。证据：`tests/plugin-entry.test.mjs`、`tests/execution-authorization.test.mjs`、`evidence/m1-verification.json`。边界：未以真实业务Provider跑提取/召回。

M1可进入后续开发的前提：真实Host绑定证据和负例完成；不能仅凭当前Host API列表推断存在授权功能。先用现有来源锁核接口；如果缺少必要权限信息，适配层默认拒绝相关模型动作，记录具体Host缺口而不写假API。安装/注册API验证沿用已有授权及[隔离验证计划](docs/shared/live-installation-plan.md)，不在本轮提前执行。

### M2：逻辑多仓、共享abstract与独立保留

**2026-11-08 v0.3.0增量：MEM-201/202/203已实现并自测；MEM-204能力事件消费器已交付（合成事件与临时库验证；真实03事件源未接入），M2整体仍不整项完成。**

- [x] **MEM-201 多仓映射**：已实现`src/projects.mjs`。逻辑`projectId`只负责组织；`RepositoryBinding`含`repoId, canonicalRoot, worktreeRoot, revision, buildVariant, scopeRef, bindingRevision`。沿用`createScope`具体身份与权限过滤，逐scope受控查询后聚合，不把过滤改成全局或宽泛project字符串；新增仓库不扫描全部历史、不迁移/放宽旧scope授权。证据：`tests/projects.test.mjs`、`tests/project-registry.test.mjs`。
- [x] **MEM-202 abstract与共享关系**：已实现`src/abstracts.mjs`（catalog v2 `abstract_revisions/abstract_state`，本地确定性抽取式二次压缩：basis含记录版本/来源/摘要、counts、generationRoute；basis失效即时重建；新增变动按10条/24h合并刷新）与`src/sharing.mjs`（`share_relations`，用户授权关系、发现abstract、自动跟随source最新有效revision、读取时二次核active关系/原scope/记忆状态/适用性、撤权/删除立即断开、明细不复制）。管理API/模型工具/客户端第4个tab已接入；模型不能 grant/revoke/refresh。证据：`tests/abstracts.test.mjs`、`tests/sharing.test.mjs`、`tests/m2-management.test.mjs`、`tests/plugin-entry.test.mjs` M2用例、`evidence/m2-verification.json`。边界：abstract为本地抽取而非模型语义压缩；不含向量检索。
- [x] **MEM-203 项目退休**：已实现退休保留记忆/store/abstract与既有共享可读性；新增`registry.applicabilityForProject/applicabilityForScope`：active且源码根存在→`current`，退休或源码根不可用→`historical_unknown`，未登记→`unavailable`；共享明细读取与abstract视图带适用性标记，退休源不自动获得新共享。未单独创建`src/project-lifecycle.mjs`（逻辑并入registry/sharing），作为实现方式差异记录。证据：`tests/project-registry.test.mjs` applicability用例、`tests/sharing.test.mjs` retired 用例。
- [x] **MEM-204 失效和消费代次**：已新增`plugin/capability-events.mjs`，沿用共同合同v1事件。基线/游标/事件日志持久化于catalog v2 `capability_*` 表；无基线、generation gap、late generation、partial/outcome_unknown、未登记scope、store失败均创建可见hold且不应用；sequential completed事件经`src/lifecycle.consumeCapabilityEvent`落stale；`getScopeState`可选适配拒绝producer mismatch；hold scope通过`isScopeHeld`暂停准入与召回。证据：`tests/capability-events.test.mjs`（4项）、`tests/session-hooks.test.mjs` held-scope用例、`evidence/capability-events.json`。**边界**：真实03-session-management producer/outbox与Host事件传输未实现，`capability/event`监听仅为未来接缝，无真实事件被消费；恢复需可信baseline/getScopeState适配，本版无自动恢复或管理UI。当前`consumeCapabilityEvent`没有完整producer generation对比，新适配先持久化每producer/scope lastGeneration及eventId；来源恢复时同步记录生产方当前generation，不能只依赖已收到事件的最大值。每次应用迟到移除前，通过本地适配`getScopeState`比较生产方当前状态/代次，避免尚未投递的restore被旧移除覆盖；断档/unknown/partial或无法重核则暂停相关来源使用。适配不是声称Host已提供该方法；03停用时保留待核并靠本地检查。源项目注销不冒充`session_removed`，新kind协商后才能交给支持它的消费者。**catalog v2已预留`capability_cursors/capability_holds/capability_events`表；本增量未接线。**

M2退出：合成驱动/用户库两个登记仓库不互相放宽适用性；两个逻辑项目通过摘要发现、许可明细读取；撤权/删除即时断开；项目退休后仍可查看/管理已有记忆。乱序事件和重启重放不复活旧状态（MEM-204消费器已交付；真实03事件源仍待接入）。

### M3：非C盘冷档、再次压缩和删除闭环

- [ ] **MEM-301 独立数据根**：**部分实现** `src/storage-layout.mjs`：路径规划、绝对/UNC/父级/源码树/符号链接/卷类型校验与 `allowC` 测试例外；**未创建生产数据根**，卷类型仅注入探针，ACL/真实非C卷未验证。
- [ ] **MEM-302 分层召回**：长期未有效调用默认90天转冷，可配置；仅通过权限/适用性检查且实际交付的用户检索更新lastAccess，后台压缩/索引遍历不能令全库永不变冷。热索引只保留冷条目的安全摘要与ref，按当前问题、预算、来源有效性选中后再读取小段明细。二次压缩是语义合并＋保留来源图，不是只压ZIP；原明细独立保留，不因总结而丢失证明。
- [ ] **MEM-303 可恢复归档与明确删除**：`archive`进入用户归档、不参与自动召回；`restoreArchived`需重新核许可/适用性。冷存储是tier，不等于用户归档状态：active+cold仍可按需召回。明确删除先在独立权威账本提交tombstone/提升epoch/撤销在途lease，再清理本工具控制的正文、FTS、冷块、abstract、共享缓存和报告受控缓存。失败处保持不可读并重试清理，不能因残留块而恢复可召回状态。不得承诺SSD底层擦除或撤回模型已接收数据。
- [ ] **MEM-304 崩溃/备份**：**部分实现** `src/cold-archive.mjs` 的 journal 状态机与 fail-closed 恢复（prepared→copied_verified→index_switched→source_cleaned、原子写、digest 校验）；**未搬运正文**、无真实崩溃/备份/authority 恢复集成。

M3退出：非C盘路径断开、磁盘满、搬移中崩溃、旧备份、摘要残留和晚到模型结果均不得突破删除。上下文检查只出现所选摘要/片段，不出现整库；冷存储路径和上下文token控制分别证明。

### M4：年度工作草稿、证明和人工审定报告

- [x] **MEM-401 当前获准对话自动草稿**（v0.2.0子集）：复用`work_summaries`、draft校验和持久queue，独立记录项目/需求/问题、目标、本人贡献、过程/结论、结果、时间精度、来源；与普通经验job同一次准入原子入队。证据：`tests/work-management.test.mjs`、`tests/plugin-entry.test.mjs`。仍缺：按明确requirement/problem标识聚合的完整规则与用户审定断言的冲突保留（现由merge/correct流程覆盖）。
- [x] **MEM-402 证明管理与提醒**（v0.2.0子集）：`plugin/proof-reminders.mjs`在pre-step附一次简短“缺证提醒”，按`(scope,record,claim,generation)`24小时去重，可延后/停用；不另发外部通知；引用区分unread/current/changed/unavailable，读取正文仍需用户确认（HTTP入口当前返回`USER_ACTION_REQUIRED`，见已知限制）。证据：`tests/proof-reminders.test.mjs`。
- [x] **MEM-403 审定报告**（v0.2.0子集）：`src/reports.mjs`固定时间范围、项目集合、选中workRevision、每条确认与证明状态及待补证清单；审定绑定`reportDigest+sourceRevisions`，源变化`REPORT_STALE`；草稿无需模型即可生成。证据：`tests/reports.test.mjs`。
- [x] **MEM-404 本地导出**（v0.2.0子集）：Markdown＋JSON，保留引用、未核验/缺证标记、时间精度、schema和manifest摘要；默认去掉绝对路径，只给稳定ref；未审定只能导出标明draft的材料。证据：`tests/reports.test.mjs`（含离线导出与路径约束）。
- [ ] **MEM-405 模板增量**：《年终总结维度.md》提供后，单独创建带版本/来源摘要的映射，不猜评分维度。映射不会修改原工作事实；用缺维度/无来源/维度冲突负例验收，未提供模板不阻断粗粒度草稿与基础报告。**当前`dimensionMapping.status='pending_reference'`，仍未实现。**

M4退出：从合成开发对话形成草稿→缺证提示→仅引用/经授权读取证明→人工纠正贡献/时间→选定记录审定→本地两格式导出。变化或缺证必须如实显示，不能把模型写出的成果当完成证据。

### M5：完整记忆中心、部署与最终交付

- [ ] **MEM-501 管理界面**：v0.2.0已交付`client.js`基础版：经验/年度两分区及统一任务入口、列表＋侧边详情、搜索/来源/纠正/归档恢复/明确删除/项目登记与开关/退休、任务状态（含unknown“待核”用户确认、无盲重试）、报告确认与两格式导出。仍缺：年度记录人工合并/纠正与证明正文评审UI、窄屏专项、删除前“受影响记录与派生引用”清单等完整交互，故不整项勾选。
- [ ] **MEM-502 安装/更新/停用**：v0.2.0已交付：实际manifest/`cordis.patch.yml`/导出与显示资源、本地bundle安装、停用撤销lease/停止scheduler/清理注入且保留数据（dispose实测；卸载默认保留dataRoot）。仍缺：更新停writer/版本备份/迁移、schema不兼容只读、离线依赖闭包证明。
- [ ] **MEM-503 最终验证与独立评审**：已完成：范围隔离/Provider预算/撤权/最终请求/队列故障/删除/年度审定/安装与停用的组件与安装级负例、独立评审（`docs/m1-independent-review.md`）。仍缺：真实业务Provider旅程、完整GUI视觉走查、OS级出口与子进程/DNS/代理负例、M2剩余（MEM-204）与冷档（M3未实现）。
- [ ] **MEM-504 完整机制交付**：`docs/mechanisms.md`已按[机制说明合同](docs/shared/mechanism-document-contract.md)交付（稳定机制ID、触发、规则、硬边界、代码/接口、命令与证据、失败恢复、skill可改参数），但独立评审曾判阻断（F-01..F-05），修复后的复核通过前不勾选；原阶段机制保留历史身份。

### M6：体验与后台巩固增量（MEM-EXP-1 / MEM-BG-1，2026-11-09 起）

设计依据：[MEM-EXP-1](docs/memory-experience-contract.md)、[MEM-BG-1](docs/memory-background-plan.md)、[实施计划](docs/experience-implementation-plan.md)。本增量与既有 M1–M5 并行，不把设计稿当已实现。

- [x] **EXP-T1 阅读优先界面（Phase A 子集）**：经验列表改为短标题/摘要/项目/日期优先，归档状态弱化；详情保留原有管理动作。证据：`client.js`、`tests/management.test.mjs` 客户端用例、`evidence/experience-phase-ab.json`。未做完整视觉验收。
- [x] **EXP-T2 小 bar 底座（Phase A）**：`conversation.composer.dock` 注册只读 `local-memory-status`，轮询 `status.experience`，页面隐藏时停止；真实 slot 已在运行客户端 active。仍缺聊天正文不插入、失败自动恢复的完整验证。
- [x] **EXP-T3 结论归因底座（Phase B）**：召回短引用 `记1..`、系统 prompt 引用规则、`agent/turn-stopping` 解析与实时复核、≤100 码点映射、`memory.attribution` 只读操作、`conversation.chat.turnTail` slot（active）。边界：归因当前仅进程内存储，重启丢失；assistant 正文无可替换 slot，内联可点击角标未实现，turnTail 显示映射文本。
- [ ] **EXP-T2/T3 真实模型闭环**：真实 Provider 输出引用、行内标记校验、超限重生成、点击定位记忆与旧角标更正；待真实 Host/Provider 验证。
- [ ] **EXP-T4 自然语言纠正与后台反思**：尚未实现。
- [ ] **EXP-T5 自动后台巩固与证据摘录**：**存储底座与最小证据摘录闭环已实现**（content v3/authority v2 迁移、excerpt 登记/读取/遗忘、提炼提交时自动捕获、删除/纠正清正文、归档保留不可读、只读 metadata 列表、v3 snapshot 安全子集；`tests/consolidation-storage.test.mjs` 13项及 excerpt/jobs/entry 用例、真实profile store已迁移）。新增 **manifest/批次许可底座**：`src/consolidation-inputs.mjs` 对 2..16 条活记忆生成 pinning manifest/InputSnapshot、用户 batch permission（24h、user-only）、读时重核（epoch/revision/binding/memory/rootSources/permission）。新增 **`mc-output-v1` 严格校验器**（`src/consolidation-output.mjs`）：覆盖/引用/去重/capacity/secret/source_correction 约束与本地 candidate metadata/warnings。新增 **持久整理队列底座**（`src/consolidation-queue.mjs`）：幂等 enqueue、manifest/InputSnapshot/permission 事务写入、pending/get/list/cancel、running→outcome_unknown 恢复、同 scope 容量2。新增 **provider purpose/prompt + runJob + candidate 持久化**：`memory_consolidate` 固定 prompt、受控执行授权、模型输出 mc-output-v1 校验、候选正文/来源/dependency 落库、job ready、input 清理且不推进 store.revision。新增 **候选读取 + publish/head CAS + 版本正文/来源/dependency 落库**（`src/consolidation-versions.mjs`），发布不推进 memory revision，幂等/陈旧拒绝/读取 fail-closed 已测。新增 **派生视图只读 API + 阅读优先 UI 卡片**：`memory.derived` 返回已发布 head（含原记忆正文/未验证/语义未验证标记），真实安装态空 head 已调用通过；客户端在记忆列表上方展示派生视图，locale 完整。新增 **删除/纠正传播**：删除或纠正原记忆会清除依赖候选/版本文本、tombstone entry、标记 job stale、推进并清空失效 head；`memory.derived` 自动回退 head=null。仍缺：归档传播、版本 search/list、历史保留/GC、excerpt 依赖、发布/候选 UI、预算 broker、真实 Host 空闲派发。
- [ ] **EXP-T6 真实集成**：小 bar/归因/纠正的真实 Host 连续性、失效上下文清理与普通聊天连续性未验证。

## 4. 接口与状态合同（v0.2.0已实现子集）

以下为设计合同；v0.2.0已实现 `project.register/update/retire/preference`、`memory.search/list/get/correct/archive/restore/delete`、`task.list/inspect/cancel/confirmRemoteQuiescence`、`recovery.confirm`、`work.*`、`report.draft/get/approve/export`、`reminder.defer/disable`，通过同源HTTP `/dsh-local-memory/api` 与模型工具复用同一实现。`MEM-API-ABSTRACT` 未实现；`MEM-API-PROOF` 的正文读取确认仍受同步dispatch限制（见README已知限制）。

所有新控制请求使用`schemaVersion:1, operationId, expectedRevision, projectId, input`，身份与许可从可信调用上下文注入，不接受模型自报grant。相同operationId＋标准化payloadDigest返回原结果；不同payload拒绝`OPERATION_CONFLICT`。响应含`currentRevision, state, evidenceRefs, reasonCode?`，原始凭据/Provider错误不外露。

| 接口ID | input及返回要点 | 边界/错误 |
|---|---|---|
| MEM-API-PROJECT register/bind/retire | register `{name,repositories:[RepositoryBinding]}`；bind `{sessionRef,projectRevision}`；retire `{reason}`；返回项目revision/具体scope列表/retired | realpath固定根、未知仓库拒绝；`UNBOUND/STALE_REVISION/OUTSIDE_ROOT`；退休保留记忆 |
| MEM-API-RECALL search | `{query,mode:manual或automatic,collections:['memories'],limit,cursor?,contextRef}`；返回 `{items:[{recordRef,revision,origin,verification,applicability,sourceRefs,tier}],nextCursor?,projectionDigest}` | limit默认10、上限50；cursor绑定查询/projectRevision/许可及页边界；变化`STALE_CURSOR`；年度不混入自动经验 |
| MEM-API-ABSTRACT refresh/share | refresh `{sourceProjectId,reason:manual或coalesced}`返回jobRef；share `{sourceProjectId,abstractRevision,decisionBasis,permissionRef}`返回relationRevision | 已存在索引后无需逐次Agent重选；`SHARE_DENIED/STALE_ABSTRACT/ROUTE_CHANGED`；只返回获准abstract投影 |
| MEM-API-LIFECYCLE archive/restore/forget | `{collection,recordId,recordRevision}`返回 `{state,generation,cleanupState}` | 复用底层lifecycle但补全派生tier；`forgotten`不可restore；`cleanup_pending`仍禁止读取 |
| MEM-API-TASK list/inspect/cancel | `{stateFilter?,cursor?,limit}`、`{jobRef}`；返回安全状态、阶段、耗时、原因及合法actions | 取消不等于远端已静止；unknown仅可信recovery调查可解闸；不向普通客户端开放“标记远端完成” |
| MEM-API-PROOF attach/defer | `{workId,workRevision,claimRef,localRef,readRequested}`或`{workId,claimRefs,deferUntil}`返回proofStatus/提醒状态 | readRequested只是请求，仍查真实范围许可；`PROOF_UNREADABLE/PROOF_CHANGED`不提升support |
| MEM-API-REPORT draft/approve/export | draft `{timeRange,projectIds,workRefs,templateRef?}`；approve `{reportId,reportDigest,sourceRevisions}`；export `{reportId,revision,format,outputRootRef,includeLocalPaths:false}` | 源变化`REPORT_STALE`；未审定只能draft；跨项目汇总必须具备每个project读取许可 |

设计默认：提炼继承现有队列限额，abstract积累10条有效变动或距首条变动24小时后合并刷新、最短间隔10分钟，手动刷新仍受预算/许可约束；不设置无授权定时模型任务。经验召回投影上限优先按批准模型精确token计数、默认min(4096 tokens,请求可用预算的10%)；无可信计数/最终dispatch门禁时不给自动追加，手动本地搜索仍可用。分页/容量和频率可改，不需要重新产品确认，但要重测受影响边界。

新增独立project catalog保存project/repository_binding/abstract_revision/share_relation/record_locator/archive_job/report_revision/reminder/event_cursor；所有表带schema版本、scope/项目键和revision，复合唯一约束按实体ID＋revision，外键在单事务内维护。定位表只存ref和摘要，不重复存秘密正文。抽象/报告依赖边`derived_from(recordRef,revision)`供删除传播与读取时复核；catalog失败不能绕过底层authority。数据迁移单writer持本地锁→校验旧schema/authority→写新文件→完整性检查→原子发布manifest，旧generation/queued许可不得自动升级。详细SQL/迁移由M2开始前按本文字段与新测试交接补齐，不用修改旧受审数据库来假装多仓已有。

## 5. 最小验收映射和依赖

| 验收ID | 覆盖待办 | 需要观察的结果 | 2026-11-07状态 |
|---|---|---|---|
| MEM-A01 | 101..104 | 真实隔离Host入口闭环；撤权后零后续dispatch/提交；最终请求只含合法所选经验 | **通过（合成Provider边界）**：`tests/plugin-entry.test.mjs`、`evidence/m1-host-probe.json`；真实业务Provider未运行 |
| MEM-A02 | 201..204 | 多仓范围不放宽；abstract发现/最新明细；撤权/乱序/项目退休的分别处理 | **部分通过（2026-11-09）**：多仓、abstract发现/授权明细/自动跟随/撤权/删除/退休适用性已验；MEM-204消费器已验（合成契约事件/持久游标/hold/暂停召回）；真实03事件源与真实Host传输未接入 |
| MEM-A03 | 301..304 | 非C本地卷、冷档按需展开、崩溃恢复、删除后旧块/备份/共享均不能复活 | **未实现**（删除权威账本沿用既有组件） |
| MEM-A04 | 401..405 | 草稿来源/证明/本人审定/两格式报告可追溯；缺模板不造维度 | **部分通过**：401..404已有测试；405待模板 |
| MEM-A05 | 501..504 | 两分区＋任务完整交互、停用/更新/卸载与出口负例、完整机制说明 | **部分通过**：四分区（含M2共享页）静态/冒烟；安装停用负例；机制说明与M1/M2独立评审已完成；完整交互、更新/卸载与出口实测待补 |

M1不等待03/04/08：合成事件、来源和本地入口可独立验收；M2共享不等待向量后端；M4提醒不依赖外部通知；M5组合08前先测试自身生命周期。后置：多Agent MCP、Hindsight/OpenViking等新服务、远端向量、全历史扫描和高级语义检索，不成为首版前提。**v0.3.0已交付M1闭环与M2的abstract/共享/退休适用性，但不是完整05交付**：MEM-204消费器已实现（真实03源待接）、M3与M5剩余项仍未实现，安装包不构成这些能力的验收。

编码时为上述验收创建真实行为测试，再记录运行时/构件摘要、命令、退出码、断言和覆盖限制；本轮只检查文档与独立评审，不写不存在的测试命令或重新使用旧测试数冒充新增功能成功。

## 6. 局部修改与修订

沿用[局部修订规则](docs/shared/design-change-policy.md)：新增字段/筛选使用新ID和默认语义；改阈值/文案只变局部规则及相关验收；改变共享许可、删除语义、真实接收方或跨项目自动化须重核受影响产品项/权限，不能当普通参数。新增schema或公共事件给迁移和旧客户端行为。修订记录保留已实现基线，完成待办时填实际文件/接口/验收证据，不直接给全部checkbox打勾。

| 修订 | 来源与影响 | 实现状态 |
|---|---|---|
| MEM-TODO-1 / 2026-11-07 | 汇总已确认PF、删除即清除、年度自动草稿与高层集中确认要求；MEM-101..504/API/A01..A05 | 本文均为后续待办，旧组件仍按原证据计 |
| MEM-TODO-2 / 2026-11-07 | 用户要求继续实现、自测并同步仓库；M1方案落地为v0.2.0安装包，新增M1/MEM-201/M4子集/M5部分勾选与验收状态列 | M1、MEM-201、MEM-401..404、MEM-504已实现；M2/M3/405与M5剩余项未完成；证据见`evidence/m1-*`、`docs/mechanisms.md`、`docs/m1-independent-review.md` |
| MEM-TODO-3 / 2026-11-08 | 继续M2：v0.3.0交付abstract/共享/退休适用性（MEM-202/203），catalog v2迁移、7个管理操作、2个模型工具、第4个tab；保留MEM-204/M3/405/M5未完成勾选 | MEM-201/202/203已实现；全量318/318+真实安装库最终门3/3；真实数据根catalog v2；证据见`evidence/m2-*`、`docs/m2-design.md`、`docs/m2-independent-review.md` |
| MEM-TODO-4 / 2026-11-09 | Phase A/B体验底座与MEM-204消费器落地；设计文档MEM-EXP-1/MEM-BG-1已提交，新增composer小bar、turnTail归因、阅读优先列表与capability事件消费 | Phase A/B与MEM-204消费器已实现；真实模型引用/纠正/后台巩固/证据摘录/冷档仍未实现；证据见`evidence/experience-phase-ab.json`、`evidence/capability-events.json` |
| MEM-TODO-5 / 2026-11-09 | 继续执行 MEM-EXP-1/MEM-BG-1 修订3 与 M3 可行边界；实现摘录闭环、manifest/许可/校验/队列/runJob候选/发布版本、派生视图与删除传播、显式纠正挂起、M3 layout/journal 骨架 | 代码与测试见提交历史；全量379/379；证据见 `evidence/consolidation-*.json`、`evidence/correction-suspension.json`、`evidence/m3-storage-layout.json`。仍缺自动调度/反思根因/M3搬移/GUI与真实Provider验收 |

