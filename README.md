# dsh-local-memory-linqu · DeepSeek Harness 本地长期记忆

> 版本 `0.2.0`（2026-11-07）。这是05“本地长期记忆”能力的**首个可安装版本**：DSH Host plugin + Web 记忆中心 + 本地 SQLite 后端 + 受控 Provider 提炼/召回。
>
> 本版本完成统一待办的 **M1（单个登记项目的最小 Host 闭环）** 和管理界面/年度工作记录的基础可用子集；**M2 跨项目 abstract 共享、M3 非C盘冷档未实现**，M4 亦只完成到“自动草稿＋缺证提醒＋人工审定报告＋本地导出”，维度模板仍等待《年终总结维度.md》。完整交付边界见 [TODO.md](TODO.md) 与 [实现合同](docs/m1-plugin-design.md)。

## 1. 它解决什么

在 Harness 内保存和检索**有来源的跨会话经验**，并单独维护**年度工作记录**：

- 项目登记后，从当前获准对话自动提炼普通经验；也可手动“记住这条”。
- 按当前问题自动召回当前项目内的相关经验，保留“模型提炼、未核验”标记和来源；命中时在对话中显示一条带来源的召回消息。
- 经验可搜索、查看来源、纠正、归档/恢复、**明确删除**（删除即清除，归档才是可恢复动作）。
- 年度工作记录自动形成粗粒度草稿，区分本人贡献/过程/结果/时间精度/来源与证明状态；缺证明时在对话中低频提醒；最终报告由用户审定后本地导出 Markdown/JSON。
- 所有数据留在本地数据根；模型只走用户配置的批准 Provider；插件不接触 API key、不做遥测、不联网下载、不做云同步、不扫描历史会话。

## 2. 安装

前提：已安装并登录的 DeepSeek Harness（本版本针对 `0.2.1-rc.5` 验证），Node ≥ 24.9。

把本目录作为本地 bundle 安装到当前 profile（由 Harness 的插件管理完成依赖链接和 patch 组合）：

```text
plugin_manager install_bundle target = <本仓库绝对路径>
```

安装后：插件管理器出现 “Local Memory” 条目；设置面板出现“记忆中心”页；本目录为 linked package，后续修改文件会在重载/重启后生效。

### 配置

默认配置即可运行（不登记项目时不会提炼任何内容）。需要调整时修改 profile 的 `cordis.patch.yml`（用户 patch 层，升级不丢）：

```yaml
- id: dsh-local-memory-linqu
  name: dsh-local-memory-linqu
  config:
    dataRoot: 'E:/dsh-data/05-local-memory'      # 实际根 = <dataRoot>/<profile>
    routes:
      - routeRef: 'memory-default'
        provider: 'deepseek-official'
        model: 'deepseek-flash'
    projects:
      - name: 'demo-project'
        repositories:
          - repoId: 'main'
            canonicalRoot: 'E:/code/demo'
            worktreeRoot: 'E:/code/demo'
            revision: 'workspace'
            buildVariant: 'win-node24'
```

| 配置键 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `E:/dsh-data/05-local-memory` | 本地数据基础目录；必须为本地固定盘绝对路径（C:/E:/H:） |
| `profile` | `DSH_PROFILE` 或 `default` | 数据根下的 profile 子目录 |
| `routes` | `memory-default → deepseek-official/deepseek-flash` | 允许的模型路由；只作为“已批准路由”，不做 Provider 发现或 fallback |
| `extraction` | 开启，最多5条经验/次 | 自动提炼开关、路由、单次候选上限、最小输入长度（`maxMemories`/`minInputChars` 当前为**预留参数**：已校验但尚未接入提炼行为） |
| `recall` | 开启，5条/4000字符 | 自动召回开关与投影上限（`maxTokens` 为**预留参数**，当前按字符预算执行） |
| `projects` | 空 | 安装时静态登记的项目/仓库；也可在记忆中心或 `/memory register` 登记 |
| `scheduler` | 1000ms 轮询，并发1，10s 超时 | 持久任务调度；启动时恢复中断任务 |
| `limits` | 20次/日、5次/会话等 | 提炼预算；超过即拒绝，不换 Provider |
| `workSummary` | 开启 | 年度工作记录提炼路由与证明根 |
| `reminders` | 开启，24h 冷却，最多3项 | 缺证提醒去重/延后/停用 |
| `reports` | 开启 | 本地报告导出根（默认 `<dataRoot>/reports`） |

## 3. 使用入口

1. **记忆中心**：设置 → 记忆中心（三个分区：经验记忆 / 年度工作记录 / 处理任务；列表＋侧边详情）。项目登记/启用开关/搜索/纠正/归档/恢复/明确删除/任务状态/年度确认与报告导出都在这里。
2. **对话命令**：`/memory status | search <文本> | remember <文本> | projects | register <名称> | forget <id>`。`register` 是用户手势，用当前会话工作目录登记项目；未登记项目时记忆功能暂停，普通聊天继续。
3. **模型工具**（自动可用）：`memory_search`、`memory_remember`、`memory_list`、`memory_get`、`memory_correct`、`memory_archive`、`memory_delete`、`memory_tasks`、`memory_status`、`work_list`、`work_get`。其中纠正/归档/删除是用户动作，模型调用会得到 `USER_ACTION_REQUIRED`，需在记忆中手动执行。
4. **召回消息**：命中时对话中出现一条“未核验本地记忆，作为数据引用”的消息，含来源引用。

## 4. 关键行为

- **项目范围**：一个逻辑项目可登记多个仓库/工作树/版本/构建变体；每个具体 scope 独立 SQLite store 与任务队列，不跨 scope 合并。会话通过 `session.header.cwd` 绑定已登记最具体的工作树；未登记则记忆暂停、普通聊天继续。
- **提炼**：当前用户消息先经准入回执（活会话/绑定项目/开关/批准路由/内容摘要），再入持久队列；调度器只执行本地 `queued`，默认全局并发1；预算、来源、epoch、路由、授权在 claim/dispatch/commit 前后复核。unknown 结果保持隔离，不自动重试、不解除。
- **召回最终门**：pre-step 注入召回消息后，真正的 `llm/stream` dispatch 前会再次核验：记录仍有效（未删除/归档/替代）、来源/代次一致、项目仍 active 且绑定未变、召回开关仍开、授权版本未变、路由未变、消息正文未被替换。任一不满足则**不派发该请求**并返回 `memory_projection_stale`；只撤回本插件追加的内容，不改写用户消息和工具配对。代价：某会话历史里已含被删除记忆的召回消息时，该会话会被安全阻塞，直到开始新会话（fail-closed，见限制）。
- **删除 vs 归档**：明确删除 = 本地正文/索引清除 + 权威账本 tombstone + 在途/旧任务不可复活（不承诺 SSD 擦除或撤回模型已接收内容）；归档 = 可恢复、不参与自动召回。
- **项目退休**：保留记忆、来源和历史可管理性；退休后不再绑定新会话，不自动获得共享许可。
- **年度记录**：自动草稿按项目/需求/问题聚合；模型推断的贡献/时间保持 `pending`，用户确认或证明评审才改变 support；证明文件存在不等于断言已证实；报告审定绑定 `reportDigest + sourceRevisions`，源变化即 `REPORT_STALE`。

## 5. 架构与目录

```
plugin/index.mjs             Host 组装：生命周期、事件接线、工具/命令/HTTP、降级状态
plugin/configuration.mjs     配置校验、路由批准、数据根解析
plugin/project-registry.mjs  项目目录、会话→scope 绑定、store/queue 缓存
plugin/host-grants.mjs       准入回执、执行 lease、撤权、用户恢复确认
plugin/scheduler.mjs         持久任务轮询、重启恢复、有界停止
plugin/final-projection.mjs  llm/stream 最终召回门
plugin/management.mjs        管理操作 + 同源 HTTP API
plugin/work-management.mjs   年度/证明/报告/提醒管理操作
plugin/proof-reminders.mjs   缺证对话提醒
plugin/session-hooks.mjs     当前消息准入与 pre-step 召回注入（复用已受审组件）
plugin/harness-provider.mjs  受控 Provider 桥接（复用已受审组件）
plugin/harness-sdk.mjs       无依赖的 message/BlockAssembler 等价实现
src/*.mjs                    本地 SQLite/FTS、scope、作业队列、生命周期、年度记录、报告
client.js                    记忆中心 Web 客户端（单文件、无构建、仅 React 运行时）
tests/                       组件 + 集成 + 关闭闭环测试（Node 内置 test）
tools/                       隔离真实 Host 探针与验证 runner
docs/                        设计、阶段机制、评审、共享合同副本
```

## 6. 数据根与安全边界

```
<dataRoot>/<profile>/
  catalog.sqlite / catalog.identity.json   项目目录、偏好、提醒、报告修订（单writer）
  hot/scopes/<scopeHash>/                  每个具体 scope 的 memory store（authority.sqlite + scope-*.sqlite）
  reports/<reportId>/                      本地报告导出
  cold/、staging/                          预留（M3 未实现，本版不创建）
```

- 路径必须是本地固定盘绝对路径、不含符号链接；数据根独立于源码目录和插件安装目录。
- 插件不保存/读取 API key；模型调用只经 `ctx.llm` 的已批准路由；不发起额外网络请求、遥测、更新、云端记忆、Git 同步或远端 embedding。
- 管理 API 仅同源 POST JSON、body≤64KiB、Origin/Content-Type 校验、operationId 幂等；错误与状态不返回绝对路径或秘密。
- 项目登记是用户动作；模型不能自报 scope、不能授权、不能解锁 unknown、不能审定报告。

## 7. 验证与证据（2026-11-07）

| 验证 | 结果 | 证据 |
|---|---|---|
| 本地全量测试（Node 26.13，`.\runtime\node.exe --test tests/*.test.mjs`） | 258/258 通过 | `evidence/m1-node26.tap`、`evidence/m1-verification.json` |
| 真实安装库 Host 探针（真实 Cordis/LlmRuntime + 合成 adapter，无 profile/凭据/真实 Provider） | 3/3 通过：`llm/stream` waterfall 存在；监听器可放行或短路；最终门对已删除记录阻断且零派发 | `evidence/m1-host-probe.json`、`m1-host-probe.tap` |
| 真实安装（desktop profile，本地 linked bundle） | 插件行 `include:dsh-local-memory-linqu` fiber active；`POST /dsh-local-memory/api` 返回 `state:ready`；客户端 `settings.section` 注册项 `local-memory` active；管理 API `project.register→retire→list` 真实往返 | `evidence/m1-install-verification.json` |
| 流接口修复与现场复验 | `llm/stream` 监听器改为同步返回 `AsyncIterable`；重启桌面 Harness 后普通流式对话恢复；安装库回归 34/34 | `docs/stream-contract-fix.md`、`evidence/stream-contract-*.tap` |
| 端到端闭环（测试内 FakeHost：登记→审批→提炼→持久化→召回→最终门→删除后阻断→重启/晚到结果） | 通过 | `tests/plugin-entry.test.mjs` 等 |

**未证明边界**：本版本没有以真实 Provider 业务 API 跑过提炼/召回（测试与探针使用合成 adapter）；没有人工逐屏视觉验收（安装后仅以 Host 状态、客户端 slot 注册和静态检查验证）；没有 OS 级出口/沙箱证明；真实多仓、跨项目共享、冷档和年度维度模板未实现。

## 8. 已知限制与后续版本

1. **M2（abstract/跨项目共享）未实现**：项目目录已支持多仓，但 abstract、Agent 索引共享、共享明细读取仍待实现。
2. **M3（非C盘冷档/再次压缩/删除传播）未实现**：本版不创建冷档；明确删除已走权威账本，但冷 tier、二次压缩与备份恢复链路未交付。
3. **M4 维度模板待提供**：《年终总结维度.md》未提供，`dimensionMapping.status='pending_reference'`，不生成评分维度。
4. **证明正文读取的用户确认**：管理 API 为同步 dispatch，而 `ctx.approval.request` 是异步的；当前 HTTP `work.evidence.review` 会返回 `USER_ACTION_REQUIRED`，需要 Host 层先解析用户确认再调用（或后续提供同步确认接缝）。
5. **召回消息呈现与失效代价**：首版作为一条带来源的消息显示在对话中，尚未做成可折叠提示卡；召回后的删除会使该会话 fail-closed，需新会话继续；投影元数据淘汰或重装后旧召回消息同样阻断而非放行。
6. **管理 UI 子项**：年度记录人工纠正/合并、证明正文评审、项目仓库编辑等仍需后续补齐；基础列表/详情/确认/报告导出已可用。年度自动草稿当前按单条来源锚生成，尚未按 requirement/problem 自动聚合（需人工 `work.merge`，本轮 UI 未提供该按钮）。
7. **任务取消**：v0.2.0 的队列没有 `cancel` 方法，处理任务页的取消动作返回 `CANCEL_UNAVAILABLE`；真正停止只能停用插件/退出进程（可能落 `outcome_unknown`，重启后保持待核）。
8. **停用不等任务收尾**：dispose 会先 abort 调度并撤权，但不 `await` 在途任务完成；重启后由 `recoverInterrupted` 标为 `unknown`，不重发，数据不复活。
9. **安装/更新/卸载旅程**：停用会撤销 lease、停止调度、清理注入并保留数据；卸载默认保留 `dataRoot`；更新/迁移/版本门禁仍按总工作区门禁执行。
10. **宿主缺少 `llm/stream` 的降级分支**：本版没有运行时探测；该接缝由固定 Host `0.2.1-rc.5` 的安装库探针与版本门禁保证，缺接缝时会在激活阶段失败而不是自动降级为手动搜索。
11. **数据根 profile 默认值**：Host 进程不导出 `DSH_PROFILE` 时，数据根使用 `.../default` 子目录（不是桌面 profile 名）；多 profile 隔离需显式配置 `profile`/`dataRoot`。
12. **卷白名单硬编码**：当前只接受 C:/E:/H: 本地固定盘（`src/scope.mjs`），D:/F: 等会被拒绝；换机器或换卷需改代码/配置并重新验证。
13. **配置冲突行为**：静态 `projects` 与既有 catalog 绑定不一致时，插件记录 `CONFIG_CONFLICT` 并**停用自动提炼/召回**（`status.automaticDisabled='config_conflict'`），手动管理仍可用；需先通过管理 API 更新/退休旧项目再恢复自动记忆。
14. **静态配置只做语法校验**：`extraction.maxMemories`、`extraction.minInputChars`、`recall.maxTokens` 为预留参数（已校验但未接入行为）。

## 9. 文档

- [统一待办与验收映射](TODO.md)
- [M1 实现合同（接口/存储/配置/入口/管理 API/验收）](docs/m1-plugin-design.md)
- [完整机制说明（场景→触发→判断→动作→状态→证据→失败恢复；skill 可调策略 vs 硬边界）](docs/mechanisms.md)
- [独立评审](docs/m1-independent-review.md)
- [流接口修复记录（llm/stream 监听器必须同步返回 AsyncIterable）](docs/stream-contract-fix.md)
- [实施路线与逐来源机制](docs/implementation-route.md)
- 历史阶段：Task 1 [证据](docs/task1-evidence.md)/[评审](docs/task1-review.md)、Task 2 [证据](docs/task2-evidence.md)/[机制](docs/task2-mechanisms.md)/[评审](docs/task2-review.md)、Task 3 [宿主接口](docs/task3-host-interfaces.md)、[Provider](docs/task3-provider-review.md)、[钩子](docs/task3-hooks-review.md)、[执行授权](docs/task3-execution-review.md)及各自机制说明
- [产品形态与确认记录](docs/product-form.md)、[年度工作记忆设计](docs/work-summary-design.md)
- [共享合同副本](docs/shared/README.md)（总工作区约束/合同的只读副本）

## 10. 许可

本项目采用 Apache-2.0（见 [LICENSE](LICENSE)）。直接复用的第三方代码仅限固定版本 kovey/dsh-memory 0.3.2 的 `vendor/kovey/cjk.js`（Apache-2.0，字节一致），来源、许可与清单见 [source-lock.json](source-lock.json)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；其余为接口参考或自行实现，未合入上游代码。
