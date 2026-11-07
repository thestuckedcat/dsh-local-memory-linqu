# 05 本地长期记忆插件 M1 独立评审

- 评审对象：`E:\dsh\plugin\05-local-memory`（`dsh-local-memory-linqu` 0.2.0，DSH 0.2.1-rc.5，Windows）
- 评审人：独立评审会话（未参与实现）
- 时间：2026-11-07 09:00–09:20（Asia/Shanghai）
- 结论：**初评阻断；复核后见 §7**。初评核心是 F-01（激活失败可终止 Host）与 F-02/F-03/F-04/F-05；Lead 在 09:18–09:22 修复后，本人已独立复跑通过 F-01/F-02/F-03/F-05/F-09/F-12/F-13。**最新判定：代码/安全不阻断；以当前 `evidence/` 发布仍阻断（仅证据快照未重生成，见 §7.3）。**
- 说明：本次评审期间工作区被另一进程持续修改（详见 §0.1）。§0.2 是初评快照；§7.1 是复核快照。发布前必须在冻结后的最终树上重跑命令并复核本报告结论。

---

## 0. 快照、环境与过程

### 0.1 评审期间工作区被并发修改（必须知道）

评审开始（约 09:00）与结束（约 09:16）之间，以下文件被另一进程修改：`plugin/index.mjs`（09:10:26）、`plugin/final-projection.mjs`（09:12:12）、`plugin/session-hooks.mjs`（09:12:36）、`tests/final-projection.test.mjs`（09:12:21）、`README.md`（09:15:02）、`TODO.md`（09:15:02）、`docs/mechanisms.md`（09:14:12）、`docs/m1-plugin-design.md`（09:10:45）以及 `evidence/m1-*`（09:14:14–15）。

观察到的中间态：

- 约 09:12 我的一次全量测试在 `tests/final-projection.test.mjs:312` 失败（当时测试文件已更新、`session-hooks.mjs` 的对应修复尚未落盘）；在修改停止后重跑为 **254/254 通过**。这说明当时工作区不是可复现的单一快照，不是最终缺陷。
- 约 09:14 我读到 `README.md`/`TODO.md` 曾短暂出现双重编码乱码（`鐗堟湰` 类）；09:15:02 的重写后又恢复为可读 UTF-8（当前无 U+FFFD）。这同样是并发编辑的中间态。
- 当前已安装进程加载的是**启动时的旧模块代次**，不会自动拾取 09:10–09:15 的源码修改；live 状态路由能证明“插件已安装且可服务”，不能证明“当前源码已被加载”。

结论：以下发现以我实际读取的源码/文档内容和运行输出为准；若 Lead 在发布前继续编辑，请按 §6 重新冻结并复跑。

### 0.2 评审快照（SHA-256 前 16 位，时间约 09:16）

| 文件 | 哈希 | 备注 |
|---|---|---|
| `plugin/index.mjs` | `e85377962163fbc9` | 与 `m1-verification.json` 中 `8185153b…` 不同（并发修改） |
| `plugin/project-registry.mjs` | `20fe4ecc1c5f88c8` | 与证据一致 |
| `plugin/final-projection.mjs` | `ec9ad28d4e058108` | 与证据一致；09:12 修复了未登记投影的 fail-closed |
| `plugin/session-hooks.mjs` | `e7e0c93fa4167efb` | 09:12 修复了投影登记失败仍注入的问题 |
| `plugin/management.mjs` | `2fb786a558a43538` | 与证据一致 |
| `plugin/host-grants.mjs` | `dfb159df845351f3` | 与证据一致 |
| `src/reports.mjs` | `6edb9d6291aa0551` | 与证据一致 |
| `src/jobs.mjs` | `ac2b05cbea5ce687` | 与证据一致 |
| `tests/final-projection.test.mjs` | `1512012d3ad1319a` | 与证据不一致（并发修改） |
| `README.md` | `25a46ab6860f5f67` | 254/254；与证据不一致（证据在 09:14 生成，README 09:15 改） |
| `TODO.md` | `dcb1a94db49f4776` | 254/254；与证据不一致（同上） |
| `docs/mechanisms.md` | `9f7699e0077488d0` | 254/254；**不在** `m1-verification.json` 的 artifacts 列表中 |
| `package.json` | `39ad4794eea60b70` | 与证据一致 |
| `client.js` | `c7dc90d02274341b` | 与证据一致 |
| `evidence/m1-verification.json` | `0e65a121f334e9c7` | 254/254；artifacts 仅 `README.md`/`TODO.md`/`docs/implementation-route.md` 与当前文件不一致（文档在证据生成后又被编辑） |
| `evidence/m1-node26.tap` | `b39386670d3bd8aa` | 254/254，与 `m1-verification.json` 的 `tapSha256` 一致 |

### 0.3 环境与命令

- `.\runtime\node.exe --version` → `v26.13.0`（Host 内嵌 Node 为 24.21.0）。
- `.\runtime\node.exe --test tests/*.test.mjs`（修改停止后）：`tests 254 / pass 254 / fail 0 / cancelled 0 / skipped 0 / todo 0`，`duration_ms 7241.7949`，exit 0。
- `.\runtime\node.exe tools\test-m1-host.mjs`：exit 0，`tests 3 / pass 3 / fail 0`，`verified true`，`profileLoaded false`，`realProviderCalled false`，`tapSha256` 在我的一次运行为 `90a1b1e0…`（每次运行 TAP 时间戳不同；当前 `evidence/m1-host-probe.json` 同为 3/3 且 `verified:true`）。
- `.\runtime\node.exe --check client.js` → 通过。
- `locale/en.json`、`locale/zh.json`、`package.json`、`evidence/m1-host-probe.json` 均为可解析 JSON；en/zh 各 245 个键（`meta.title`/`meta.description` + 243 个 `memoryCenter.*`），键集合一致；`client.js` 内字典的 243 个键与 locale 完全对齐。
- 与真实安装实例核对：
  - `plugin_manager list_plugins`：`include:dsh-local-memory-linqu`，`enabled:true`，`fiberPhase:active`；profile `C:\Users\admin\.dsh\profiles\desktop` 的 `package.json` 依赖为 `dsh-local-memory-linqu: link:E:/dsh/plugin/05-local-memory`。
  - `POST http://127.0.0.1:8656/dsh-local-memory/api`，body `{"schemaVersion":1,"operationId":"review-status-1","operation":"status","input":{}}` → HTTP 200，`ok:true`，`state:"ready"`，`registry.state:"ready"`，`scheduler.state:"running"`，`provider:"active"`，`recallIntegration:"llm-stream-gate"`，`config.profile:"default"`，`dataRoot:"E:\\dsh-data\\05-local-memory\\default"`（摘要，不显示完整绝对路径），`projectCount` 初始为 0；随后 `project.list` 可见真实往返留下的 `install-verification`（retired，revision 2）。
  - HTTP 负向：`Origin: http://evil.example` → 403 `ORIGIN_DENIED`；无 Origin → 200；`Content-Type: text/plain` → 415 `UNSUPPORTED_MEDIA_TYPE`；`schemaVersion:2` → 400；未知 operation → 200 `UNKNOWN_OPERATION`；HTTP 请求体内的 `"actor":"model"` 被忽略（HTTP 固定 `actor:'user'`，路由只提供用户动作，正确）。
  - 客户端 Slot 实时复核：`cordis_inspect_query platform=client provider=Slots method=listSubTree root=settings.section` 在 10s 超时（无页面响应），**未能独立复现**安装证据中的 slot active 声明；见 §5。
- 数据根：live 实例实际写入 `E:\dsh-data\05-local-memory\default`（存在 `catalog.sqlite`、`catalog.identity.json`、`hot/`），与设计 §2 中“默认 `.../desktop`”的示例不一致，原因见 F-08。
- 证据一致性：`evidence/m1-node26.tap` 254/254、哈希与 `m1-verification.json` 一致；`m1-verification.json` 的代码 artifacts 与当前代码一致，但 README/TODO/implementation-route 三个文档哈希与当前文件不一致（09:15 的文档编辑发生在 09:14 证据生成之后）。见 F-14。
- 副作用声明：运行指定的 `tools/test-m1-host.mjs` 会按其设计重写 `evidence/m1-host-probe.json` 与 `.tap`（我也观察到了 09:14 另一进程的重写）。除该工具产物、以及我自己的 `scratch-review/` 临时脚本（评审结束已删除）外，我没有修改源码或文档。

### 0.4 我独立编写的负向探针（摘要）

1. `probe-plugin-activation-failure.mjs`：让 `dataRoot` 指向一个文件，调用真实 `apply` + FakeHost；`apply()` 正常返回，只注册 `memory_status` 与错误路由，但 `registry.initialize()` 的 async 拒绝以 **unhandledRejection ENOTDIR** 出现；Node 无 handler 时进程 **exit 1**（`probe-registry-init3.mjs`）。见 F-01。
2. `probe-mixed-projection.mjs`：同一请求含一条已登记、有效的 own 召回消息 + 一条无投影的旧 own 召回消息；`verify` 返回 `{"action":"pass"}`、`next` 被调用 1 次。见 F-02。
3. `probe-tool-trust.mjs`：以模型身份调用真实注册的 `memory_status` 工具，输出两次包含绝对数据根；`memory_remember` 成功写入 `origin:"user"`；`memory_delete` 返回 `USER_ACTION_REQUIRED`。见 F-03、F-16。
4. `probe-gate-eviction.mjs`：基线删除记录后 `{action:'block',reason:'record_unavailable'}`；填充 1030 条投影后，旧 own 消息现在返回 `{action:'block',reason:'projection_unrecorded'}`、`nextCalls:0`。**09:12 的修复已生效**（见 §1.3）。
5. `probe-delete-lifecycle.mjs`：删除后 `records` 0 行、FTS 对关键词 0 命中、账本 `deleted`；旧快照 `restoreSnapshot` 返回 `{restored:0,skipped:1}`，搜索仍为 0。删除链正向通过。
6. HTTP 负向：见 §0.3（403/415/400/未知 operation）。

---

## 1. 发现

### 1.1 汇总表

| ID | 级别 | 位置 | 一句话 | 影响 |
|---|---|---|---|---|
| F-01 | **Critical** | `plugin/index.mjs:198`、`plugin/project-registry.mjs:116-127` | 未 await 的 async `initialize()` 拒绝变成 unhandledRejection，Host 致命退出，而不是设计要求的 degraded | 数据根/目录/catalog 不可用时整个 DSH 进程退出 |
| F-02 | **Important** | `plugin/final-projection.mjs:138-145` | 当请求中至少有一条已登记投影时，额外的“无投影 own 召回消息”不会被检查，整请求放行 | 最终门不变量不完整；与机制说明“未登记 own 消息一律阻断”矛盾 |
| F-03 | **Important** | `plugin/index.mjs:253` | 模型工具 `memory_status` 把绝对 `dataRoot` 返回给模型/Provider | 本地路径外泄；与状态净化意图和机制说明不一致 |
| F-04 | **Important** | `TODO.md:92`、`docs/mechanisms.md:389/222/200/257` | MEM-504 在独立评审未完成时勾选；机制说明含与代码不符的断言 | 交付声明/机制文档不可全信，违反“不得以文档替代验证” |
| F-05 | **Important** | `plugin/project-registry.mjs:83-99,116-127`；`docs/m1-plugin-design.md:143` | `CONFIG_CONFLICT` 只记 degraded，插件仍 `ready` 并继续自动记忆；设计要求停止自动记忆 | 配置变更可能被静默忽略，继续用旧 scope 提炼 |
| F-06 | Minor | `plugin/management.mjs:775`；`src/jobs.mjs`（无 `cancel`） | `task.cancel` 永远 `CANCEL_UNAVAILABLE`，设计 §9 将其列为可用操作 | UI 无法取消；无安全影响，已由机制说明记录 |
| F-07 | Minor | `plugin/work-management.mjs:176-201` | `work.evidence.review` 经默认 HTTP 永远 `USER_ACTION_REQUIRED`（同步 dispatch 与异步 approval 冲突） | 本版 UI 无法将断言升级为 supported；已记录为已知限制 |
| F-08 | Minor | `plugin/configuration.mjs:123-127`；live status | 安装进程解析 `profile='default'`，数据根为 `.../default`，不是设计示例的 `.../desktop` | 多 profile 隔离依赖配置；默认情况下所有无 `DSH_PROFILE` 的进程共享同一数据目录 |
| F-09 | Minor | `package.json:20-32`；`src/source-lock.mjs:15` | `files` 未包含 `source-lock.json`；`npm pack` 后 `backend.mjs` 导入期 `verifySourceLock` 会失败 | 本地 link 安装不受影响；打包分发/仓库安装会坏 |
| F-10 | Minor | `src/scope.mjs:21-29` | 卷白名单硬编码 `C:/E:/H:`，注释声称经 `GetDriveTypeW` 证明但代码没有运行时探测；D:/F: 被拒 | 换机器不可用；默认 E: 不存在时触发 F-01 崩溃 |
| F-11 | Minor | `plugin/management.mjs:549-554` | `memory.search` 的 cursor 只绑定 `{revision,offset}`，未绑定 query/project/许可，换查询可继续翻同一 offset | 分页语义与设计不符；不跨 scope |
| F-12 | Minor | `plugin/project-registry.mjs:170-173` | `setPreference` 不 `rebuild()`，binding 缓存的 `projectRevision` 保持旧值 | 安全上由实时 `preferencesForScope` 兜底；版本一致性声明偏弱 |
| F-13 | Minor | `plugin/session-hooks.mjs:59`、`plugin/host-grants.mjs:89-90` | 生产准入回执从不携带 `inputDigest`，因此该比较恒被跳过；机制说明声称匹配 `inputDigest` | 实际安全由 `sourceVersion=fingerprint({originRef,contentHash})` 绑定内容；文档/合同不准确 |
| F-14 | Minor | `evidence/m1-verification.json` artifacts | README/TODO/implementation-route 哈希在证据生成后变化；机制说明不在 artifacts 清单 | “verified” 不覆盖最终文档；需在冻结后重跑 |
| F-15 | Minor（观察） | `plugin/management.mjs:821-843` | `recovery.confirm` 生成一次性 confirmationRef，但没有消费者；可用路径是 `task.confirmRemoteQuiescence` | 死操作/误导；无安全影响 |
| F-16 | Minor（观察） | `plugin/index.mjs:260-279` | 模型可调用 `memory_remember` 写入 `origin:"user"`，没有用户手势校验 | 来源标注可被模型影响；机制说明 §6.4-7 已承认，仍建议收紧 |

### 1.2 关键发现详情

#### F-01（Critical）未 await 的 async `initialize()` 让激活失败变成 Host 致命退出

**代码**：

- `plugin/index.mjs:198`：`registry.initialize();`（没有 `await`，没有 `.catch()`；`apply` 是同步函数）。
- `plugin/project-registry.mjs:116`：`async initialize()`；`:120` `mkdirSync(dataRoot, ...)`；`:122-123` 打开 catalog/种子/rebuild；`:126-128` catch 中 `state='failed'; throw error;`。
- 设计合同：`docs/m1-plugin-design.md:270-274` 要求“任何一步失败→回滚…进入 `status.state='failed'`/`catalog_unavailable` 降级，不抛穿事件循环”；`docs/mechanisms.md:166`、`:389` 声称 `apply` 吞掉激活异常。

**证据（我的运行）**：

```text
apply() returned normally = true
tools registered: memory_status
routes registered: /dsh-local-memory/api
memory_status = {"ok":false,"error":{"code":"activation_failed",...}}
UNHANDLED REJECTION OBSERVED = ENOTDIR: ... mkdir '...\data-root-is-a-file\probe'
```

用完全同构的无 handler 探针（`probe-registry-init3.mjs`）：进程打印 stack 后 **exit 1**。`E:\dsh\resources\app.asar` 中可检索到 Host 的 `installFailLoud(NAME, process, ...)`：其 `onRejection` 分支写 `fatal load failure` 并 `proc.exit(1)`（desktop boot 路径使用同一 helper）。即使不考虑 Electron 特定处理，Node 默认策略也是 unhandled rejection → 进程退出。

**影响**：数据根不可写/盘不存在、catalog identity 不匹配、catalog schema 损坏等“设计上应降级”的场景，实际会终止整个 DSH；`activation_failed` 状态面注册成功也来不及服务。这直接违反失败隔离合同，属于发布阻断项。

**建议修复**：

1. 最简：把 `initialize()` 改为同步函数（它没有任何 `await`），让 throw 落在 `index.mjs` 的 try/catch 中；测试 `await registry.initialize()` 对非 Promise 仍可用。
2. 或：在 `index.mjs` 内 `try { const init = registry.initialize(); if (init?.catch) init.catch(error => { status.state='degraded'; ... }); }`，并确保没有未处理 rejection；但同步 throw 路径仍要处理。
3. 增加回归测试：`dataRoot` 指向普通文件、catalog identity 不匹配两种情况，断言 `apply` 返回、`status.state='degraded'`、只注册 `memory_status`/错误路由、无 unhandledRejection。

#### F-02（Important）最终门的“未登记 own 消息”只在**零匹配**时阻断，混合请求仍放行

**代码**：`plugin/final-projection.mjs:138-145`：

```js
if(matched.length<1){
  const unmatchedOwn=messages.some(message=>{try{return ownMessage(message);}catch{return false;}});
  if(unmatchedOwn){diagnostic('projection_unrecorded');return Object.freeze({action:'block',reason:'projection_unrecorded'});}
  return Object.freeze({action:'not_ours'});
}
```

只要请求中有一条已登记且复核通过的 own 消息（`matched.length>=1`），代码不再检查其他 own 消息是否有投影。

**证据（`probe-mixed-projection.mjs`）**：

```text
VERIFY MIXED REQUEST = {"action":"pass"}
NEXT CALLS = 1 CHUNKS = [{"marker":"DOWNSTREAM"}]
DIAGNOSTICS = []
```

请求包含：新登记的 own 召回消息（记录仍 active）+ 旧的、无投影的 own 召回消息（模拟 1024 淘汰/插件重装后的历史）。两者都被放行。

**影响**：`MEM-FINAL-01/02` 的核心不变量“本插件 own 召回消息必须逐条可核”不成立；被删除/失效记录的历史正文可能随“另一条有效召回消息”一起进入模型。正常 `agent/pre-step` 会 `stripOwned` 去掉旧 own 消息，因此现实可达性依赖“请求绕过 pre-step”或 Host 某条 llm 调用带历史消息；但机制说明 `docs/mechanisms.md:222`、`:383` 明确声称此类消息“一律 fail-closed 阻断”，与代码/探针不符，必须修正或加固。

**建议修复**：在 `verify` 中先收集 `ownMessages` 与 `matched`，对**每条** own 消息要求其 messageId 有投影；任何一条缺失 → `block`。补一条“1 条已登记 + 1 条未登记”的测试（当前测试只覆盖零匹配）。

#### F-03（Important）`memory_status` 工具把绝对数据根发给模型

**代码**：`plugin/index.mjs:253`：

```js
tool('memory_status', ..., {}, async () => ({ok:true, value:{plugin: status, projects: registry.status(), ...}}));
```

`status.dataRoot` 在 `:101` 设置；`registry.status()` 也返回 `dataRoot`（`plugin/project-registry.mjs:256-265`）。HTTP `status` 操作有 `sanitizeStatusValue` 过滤 `dataRoot`（`plugin/management.mjs` 的 `UNSAFE_STATUS_KEY`），但工具路径没有。

**证据（`probe-tool-trust.mjs`，真实 apply + 真实工具注册）**：

```text
STATUS TOOL LEAKS ABSOLUTE DATA ROOT = true
["C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Temp\\\\mem-review-tool-...\\\\probe", ...]
```

**影响**：模型/外部 Provider 会看到本机绝对路径（用户名、数据根布局）；与 README §6、设计 §9 的“状态不返回绝对路径”意图不一致；机制说明 `docs/mechanisms.md:257`（MEM-DATA-01）明确写“`status` 不回显绝对路径”，但只对 HTTP 成立。

**建议修复**：工具返回复用管理层的 `sanitizeStatusValue`，或去掉 `dataRoot`/`registry.dataRoot`；增加测试断言工具输出不含 `[A-Za-z]:\\`。

#### F-04（Important）MEM-504 的勾选与机制说明的若干断言不实

- `TODO.md:92` 将 **MEM-504 完整机制交付** 勾为 `[x]`，并写“由独立评审核对”。评审实际在 09:16 尚未交付，且本报告发现 F-01/F-02/F-03；`docs/mechanisms.md` 是 09:11 才出现的，勾选在 09:06 就已经写入。把“完整机制交付 + 独立评审核对”作为已完成项早于评审，是交付声明不实。
- `docs/mechanisms.md:389`：“**`apply` 吞掉激活异常**：失败只体现为 `degraded` 状态与错误路由……不抛穿事件循环。”——F-01 证明不成立；这是最直接的机制文档与代码矛盾。
- `docs/mechanisms.md:222`：“含 own 消息但未登记……**fail-closed 阻断**”——F-02 证明混合请求不阻断。
- `docs/mechanisms.md:200` / `:106`：描述回执检查含 `inputDigest` 相同；生产 hook 不传 `inputDigest`（F-13），该分支实际不生效（安全性由 `sourceVersion` 绑定兜底）。
- `docs/mechanisms.md:257`：“`status` 不回显绝对路径”——HTTP 成立、`memory_status` 工具不成立（F-03）。

**建议**：先修复 F-01/F-02/F-03，再修改机制说明上述行；MEM-504 在独立评审判定通过前保持 `[ ]`，或在 TODO 明确注明“机制文档已交付、独立评审未完成”。

#### F-05（Important）`CONFIG_CONFLICT` 与设计合同不符

- 设计 `docs/m1-plugin-design.md:143`：“同名不同 binding → 插件状态 `config_conflict` 并停止自动记忆，不覆盖用户数据。”
- 实现 `plugin/project-registry.mjs:83-99`：`seedConfigProjects` 捕获错误，`degraded.push({project, code:'CONFIG_CONFLICT'})`；`:116-127` 之后仍 `state='ready'`，`bindings` 仍用 catalog 里旧的项目绑定；`plugin/index.mjs:362` 仍 `status.state='ready'`。
- 测试 `tests/project-registry.test.mjs:147-166` 明确断言 `second.state==='ready'`、旧 binding 仍生效、仅 `degraded` 记录；这与设计合同相反，但与机制说明 `MEM-PROJ-02`（`:195` 附近，“单项目冲突只降级该项”）一致。

**影响**：配置文件想改仓库/构建变体但同名冲突时，插件静默继续用旧 scope 自动提炼/召回；用户以为新配置生效。无跨项目提权，但属于“配置变更未按合同停用自动记忆”的正确性问题。Lead 必须二选一：按设计停止自动记忆，或明确修改设计/README 接受“单项目降级继续”，不能两处说法不一致。

#### F-06–F-16（Minor）

- **F-06**：`task.cancel` 在 `plugin/management.mjs:775` 因 `queue.cancel` 不存在而永远 `CANCEL_UNAVAILABLE`；`src/jobs.mjs` 的 api 没有 `cancel`；测试 `tests/management.test.mjs:536` 以“honestly unavailable”断言了这一点；设计 §9 却把它列为操作。无安全影响，合同/实现不一致。
- **F-07**：`work-management.mjs:176-201` 的 `evidenceApproved` 只接受同步 decision；HTTP 固定 `actor:'user'` 但不传 `userConfirmed`，所以 `work.evidence.review` 默认返回 `USER_ACTION_REQUIRED`。README:134、机制 §6.4-1 已记录，属于已知限制；它使“proof review→support 升级”在本版 UI 不可用。
- **F-08**：`configuration.mjs:123-127` 用 `env.DSH_PROFILE ?? 'default'`；安装进程没有该环境变量时用 `default`（live status 与 `E:\dsh-data\05-local-memory\default` 证实），设计 §2 示例写 `.../desktop`。若同一机器跑多个 profile，它们默认共享同一记忆目录。
- **F-09**：`package.json:20-32` 的 `files` 没有 `source-lock.json`；`src/source-lock.mjs:15` 在 `backend.mjs` 导入期读取它。当前 link 安装正常，但 `npm pack`/仓库分发会失败；若走打包发布需补。
- **F-10**：`src/scope.mjs:21-29` 硬编码 `C:/E:/H:`；注释写“checked with GetDriveTypeW (DRIVE_FIXED=3)”，但代码没有调用任何卷类型 API；本机 D:/F: 同为 fixed 却被拒。更关键的是默认 `E:` 不存在时 `mkdirSync` 失败会触发 F-01。
- **F-11**：`management.mjs:549-554` 的 cursor 只含 `{revision,offset}`；设计 §9/MEM-API-RECALL 说 cursor 绑定查询与许可。安全上仍 scope 内，但换 query 可复用 offset 翻页，语义不严谨。
- **F-12**：`registry.setPreference`（`project-registry.mjs:170-173`）不调用 `rebuild()`，binding 缓存的 `projectRevision` 保持旧值；最终门 `record` 捕获的 `projectRevision` 也因此可能滞后。实际安全由 `preferencesForScope` 实时读取兜底，但版本一致性的机制声明偏弱。
- **F-13**：`session-hooks.mjs:59` 的 admission request 不含 `inputDigest`；`host-grants.mjs:89-90` 只在 `receipt.inputDigest!==undefined` 时比较，所以生产路径恒跳过。`sourceVersion=fingerprint({originRef,contentHash})` 仍绑定消息内容，因此不是可利用漏洞，但机制/合同文字不准确。
- **F-14**：`m1-verification.json` 的 README/TODO/implementation-route artifacts 与当前文件不一致（09:14 证据、09:15 文档）；机制说明自身不在 artifacts。代码 artifacts 当前一致；发布前应重跑证据并冻结。
- **F-15**：`management.mjs:821-843` 的 `recovery.confirm` 只生成 `confirmationRef` 并返回，没有任何队列调用消费它；实际可用路径是 `task.confirmRemoteQuiescence`（`:806-818`）。`recovery.confirm` 是死操作，容易误导客户端。
- **F-16**：`index.mjs:260-279` `memory_remember` 由模型直接 `store.put(..., origin:'user')`，没有用户手势/审批；机制 §6.4-7 已承认。它不是提权（不跨 scope、不授予许可），但来源标注可被模型影响，且可作为持久化提示注入面。

---

## 2. 审查问题逐项回答

1. **信任边界**：未发现模型可绕过 `USER_ONLY_OPERATIONS`（独立探针：模型 `memory_delete` → `USER_ACTION_REQUIRED`；管理测试覆盖 project/report/task/recovery）；工具参数被逐字段挑选，未发现 `projectId`/`scopeRef` 注入导致的 scope 扩大（`modelOperation` 在 `index.mjs:135-140` 只补默认 projectId，工具调用点不 spread `args`）；准入回执由插件用 live session/agent 生成。例外/残余：F-03（路径泄漏）、F-05（配置冲突继续自动记忆）、F-16（模型可写 origin=user）、F-13（inputDigest 不生效，但内容仍被 sourceVersion 绑定）。
2. **最终请求门**：当前 `verify` 对已登记投影逐条复核正文摘要、会话、binding revision、project revision、召回偏好、授权版本、routeVersion、记录 scope/source/version/generation；删除/归档/替代/退休/撤权/换路由均 block（测试与真实探针 3/3）。1024 淘汰后零匹配现在 `projection_unrecorded` block（我的探针已确认），投影登记失败现在拒绝注入（session-hooks 09:12 修复）。**残余 F-02**：混合请求（≥1 已登记 + 未登记 own）仍 pass；`options` 缺 `sessionId` 或 `messages` 非法时按 `not_ours` 放行（设计 §8 的文档化 fallback，Host 实际会提供 sessionId）。深冻结请求不被改写；“只撤回本插件追加内容”通过 pre-step `stripOwned` + 整请求 block 实现，代价是新会话（README/机制已说明）。
3. **准入/执行**：回执绑定 scope/session/sourceVersion/authorizationVersion（inputDigest 见 F-13）；`authorizeExecution` 在 claim/dispatch/commit/commit-complete 复核 binding active、route、receipt、epoch、source blocked、lease signal；撤权 abort lease，queue 在 `claim` 前拒绝（测试 `execution-authorization`）；unknown 保持 quarantine，只有用户确认可释放，scheduler 不重发 unknown、每 scope 一个 queue（`tests/scheduler`/`jobs` 通过）。未发现“由另一个 scope 的 job 执行”的路径；项目更新移除 repo 后旧 scope 不再在 `scopes` 中，旧 job 会失败。残余小问题：入队后把项目 `extract` 偏好关掉，已排队的 job 仍会执行（`authorizeExecution` 不检查偏好，只检查 active/route/receipt）；这不违反当前“授权固定 job”的文字，但与“停用自动提炼”的用户预期有差距，建议明确。
4. **管理 API**：HTTP 只接受 POST、`application/json`、Origin 等于 `getOrigin()` 或缺失、body≤64KiB、`schemaVersion:1`、合法 `operationId`、operation/input 白名单；HTTP 固定 `actor:'user'`，请求体 actor 被忽略；错误只回固定 code/message；`operations` 表做 operationId 幂等/冲突；`memory.delete` 先校验 `expectedGeneration` 再 `store.forget`，返回 `irreversible`/`currentSqliteBodyAndIndexCleared`（注意：这是本地 SQLite 正文/索引，不承诺远端/备份）。HTTP 负向实测 403/415/400。任务状态无盲重试，unknown 只有用户确认入口。`task.cancel` 实为不可用（F-06）、`recovery.confirm` 为死操作（F-15）。`memory_status` 工具路径存在绝对路径泄漏（F-03），但 HTTP `status` 已净化。
5. **数据生命周期**：`forget` 递增 epoch、写 source block、账本 tombstone、删 `records` 行（FTS 删除触发器）/`job_inputs`；我的探针确认 FTS 0 命中、旧快照 `restoreSnapshot` 跳过、搜索为空；archive/restore 保留正文且恢复要求摘要/来源一致；retire 保留 store 且可读；catalog identity 缺失/不匹配会 `CatalogError` 失败关闭——但该失败会走 F-01 的崩溃路径。未发现“删除后旧快照/晚到结果复活”的可利用路径（测试 + 探针）。
6. **年度/报告**：模型输出 `basis:'inferred'`、`support:'missing'`、`confirmation:'pending'`；用户确认只改 confirmation，证据 review 才改 support；`report.draft/approve/export` 绑定 `reportDigest + sourceRevisions`，源变化 `REPORT_STALE`，未审定导出文件名/内容标 `draft`，默认不含绝对路径；我的检查与 `tests/reports` 一致。`work.evidence.review` 的默认 HTTP 不可用是 F-07 的已知限制；`evidenceRoots` 默认空，意味着默认只能登记 URL、不能登记本地证明，需配置。
7. **客户端**：`node --check` 通过；静态检查无 ESM import/export、无 `require('@deepseek-ai/...')`、无 `document.body`、无 Harness client 包导入；`visibilitychange` + `clearInterval`/`clearTimeout` 清理；`fetch` 用相对 `/dsh-local-memory/api` + `credentials:'same-origin'`；删除有二次确认与“不可恢复”文案；unknown 仅显示确认入口，无盲重试；locale 243 键与 `locale/{en,zh}.json` 完全对齐，`meta` 字段有效。视觉/真实页面未验证（§5）。
8. **测试**：最终 254/254 通过；测试大量使用真实 SQLite/store/queue/provider 假 adapter，并对授权失败、撤权、epoch、unknown、删除、报告源变化做负向断言；真实 Host 探针 3/3 且参数化 `profileLoaded:false`/`realProviderCalled:false` 诚实。弱点/缺口：没有 F-01（激活失败）测试、没有 F-02（混合 own 消息）测试、没有 F-03（工具路径）测试、F-05 被测试反向固化；真实 Host 只覆盖 `llm/stream`（设计 §14 还提到 webServer 注册，探针未覆盖）；`tests/fake-host.mjs` 是 FakeHost，不是真实 AgentLoop（README 已声明）。评审期间还观察到一次因并发编辑造成的单测失败（见 §0.1），最终快照通过。
9. **合同/一致性**：`package.json` 名称/版本/exports/main/engines 可用；`cordis.patch.yml` 结构合理；locale JSON 合法；`client.js` 无 ESM。偏差：`package.json` 的 `dsh.client.inject` 比设计 §1 多了 `@deepseek-ai/dsh-client-ui-settings`（合理但合同未写）；`files` 漏 `source-lock.json`（F-09）；`engines.dsh >=0.2.1-rc.2` 与 `compatibility 0.2.1-rc.5+` 宽窄不一致（Minor，未列入表）；设计 §14 的 `tools/probe-m1-host.mjs` 名称已由机制 §7 说明为 `tools/test-m1-host.mjs`。证据与代码 artifacts 当前一致（除文档漂移，F-14）。
10. **诚实性**：没有声称完整 MEM-1..5；M2/M3、MEM-405、MEM-501、MEM-502、MEM-503 均未勾选或明确“未实现”，README §8 限制与机制 §6.4 大部分诚实（包括 task.cancel、evidence review、1024/会话 fail-closed、memory_remember 信任面）。**但** MEM-504 在评审前勾选并声称“由独立评审核对”（F-04），机制文档 §389/§222/§200/§257 与当前代码不符；README §7 的客户端 slot active 声明未能由我实时复核（§5）。这些属于必须修正的过度声明。

---

## 3. §14 验收矩阵（对照 `docs/m1-plugin-design.md:284-294`）

| 验收 | 结论 | 观察与证据 |
|---|---|---|
| MEM-A01a 项目登记/绑定 | **通过（组件/安装级）** | `tests/projects.test.mjs`、`tests/project-registry.test.mjs`、`tests/plugin-entry.test.mjs`（unbound 用例）；live `project.register→retire→list` 与 `project.list` 的 retired `install-verification`；多仓 scope 不互相串由测试覆盖。 |
| MEM-A01b 真实准入/撤权 | **部分通过** | 准入回执、lease、撤权、route 变化、错 scope/source、unknown 不解锁均有真实 queue/store 测试（`tests/host-grants`、`tests/execution-authorization`）；但“真实”是插件从真实 session/agent 身份合成回执，Host 并不提供独立 grant 服务；真实 Host 探针只测 `llm/stream`，不覆盖 admission。 |
| MEM-A01c 最终请求门 | **通过（主路径）** | `tests/final-projection.test.mjs`（删除/归档/退休/开关/授权/route/binding/正文替换/重复复核）；真实安装库 `tools/host-api/m1.test.mjs` 3/3；我的 1030 投影探针确认淘汰后 `projection_unrecorded` block。残余 F-02（混合未登记 own 消息）未覆盖。 |
| MEM-A01d 闭环 | **部分通过（FakeHost 闭环）** | `tests/plugin-entry.test.mjs` 用 FakeHost + 真实 SQLite/queue；真实 Host 侧只有安装/状态路由和隔离 `llm/stream` 探针；没有真实 AgentLoop 的端到端提取→召回。README §7 已如实标注。 |
| MEM-A01e 管理/年度 | **通过（组件/HTTP）+ 已知 UI 缺口** | `tests/management.test.mjs`（HTTP、幂等、actor、无路径、任务状态）、`tests/work-management.test.mjs`、`tests/reports.test.mjs`；live status/route 可用；`work.evidence.review` 默认不可用（F-07），无视觉验收。 |

**测试形态核对**：`Node 26` 全量 254/254；真实安装库探针 3/3；证据 `m1-node26.tap` 哈希与 `m1-verification.json` 一致。**未覆盖**：真实业务 Provider、完整 profile AgentLoop、真实 webServer 注册探针（设计 §14 提到，实际 m1.test 未测）、OS 级出口、视觉。

---

## 4. 过度声明检查

**没有声称完成完整 MEM-1..5**：README 明确 M2/M3 未实现、M4 子集、维度模板待提供；TODO 的 MEM-202/203/204/301..304/405/501/502/503 未勾选。整体定位诚实。

需要修正的声明：

1. **TODO.md:92（MEM-504）**：`[x]` + “由独立评审核对”在评审未发生时写入；本报告发现 Critical/Important，故该勾选在发布前不成立。建议改为 `[ ]` 或在附注写“文档已交付、独立评审待完成”，评审通过后再勾。
2. **docs/mechanisms.md:389**：“`apply` 吞掉激活异常…不抛穿事件循环”与 F-01 矛盾；必须修正或修复 F-01。
3. **docs/mechanisms.md:222/383**：“未登记 own 消息一律 fail-closed 阻断”与 F-02 混合请求矛盾。
4. **docs/mechanisms.md:200/106**：`inputDigest` 匹配在生产路径不生效（F-13）；改为“sourceVersion=fingerprint(originRef,contentHash) 绑定内容；inputDigest 仅在调用方显式提供时校验”，或补传 `inputDigest`。
5. **docs/mechanisms.md:257（MEM-DATA-01）**：“`status` 不回显绝对路径”只对 HTTP 成立；`memory_status` 工具泄漏（F-03）。改为“HTTP status 不回显绝对路径；模型工具输出需净化”或修复工具。
6. **README.md:124**：客户端 `settings.section` active 由安装证据声明；我实时 `Slots` 查询 10s 超时，未能独立复现。发布前应在有页面的情况下复验或把措辞降为“安装证据中记录、本次未复验”。
7. **README.md:122 / TODO.md:40 / mechanisms.md:360**：254/254 与当前 tap 一致；注意 `evidence/m1-verification.json` 的文档 artifacts 仍漂移（F-14），发布前重跑。

---

## 5. 我无法独立验证 / 明确边界

- **真实业务 Provider 调用**：没有用真实 DeepSeek API 跑提炼/召回；测试/探针都是合成 adapter。提炼质量、费用、usage、限流行为未知。
- **真实 GUI/视觉**：没有截图或逐屏走查；`cordis_inspect_query platform=client provider=Slots method=listSubTree root=settings.section` 在 10s 内超时（无页面响应），未复现安装证据的 slot active；只验证了插件行、HTTP 路由与客户端静态结构。
- **OS 级出口/沙箱**：未验证网络、DNS、代理、子进程出口；`deny-network.cjs` 只覆盖 Node API sink（证据自身的 `networkGuard` 已说明）。
- **真实 Host AgentLoop / 真实 session admission**：真实探针使用真实 Cordis/LlmRuntime + 合成 TextAdapter，但 session/agent 对象是合成的；未加载用户 profile、未走完整 AgentLoop。
- **Host 崩溃行为**：F-01 基于 Node 默认 unhandled-rejection 行为与 app.asar 中 `installFailLoud` 代码推断；未在真实 Electron 进程里故意制造崩溃（避免破坏用户环境）。
- **多 profile 隔离、跨机器安装**：未在其他 profile/无 E: 的机器上实测；F-08/F-10 的后果是推断。
- **备份/远端撤回/SSD 擦除**：插件自身声明不承诺；拒绝重启/旧快照的复活只在 SQLite/快照层验证。
- **打包分发**：未执行 `npm pack`/安装 tarball；F-09 是静态+导入路径分析。
- **证据时点**：评审期间有并发写入；我的哈希/输出是固定时间点的快照，不能代表 Lead 之后的修改。

---

## 6. 发布前必须完成（阻断项）

1. **修复 F-01** 并加回归测试；确认在 dataRoot 不可用/`catalog.identity.json` 不匹配时 DSH 保持运行、插件进入 degraded，而不是 Host 退出。这是唯一需要“代码 + 失败路径实测”的阻断项。
2. **修复 F-02** 并加混合消息测试；同时修正 mechanisms §222/§383 的“全部阻断”措辞。若决定接受该残余风险，必须在设计/README/机制中明确写成“仅当请求中没有其他有效投影时才阻断”，不能声称 fail-closed。
3. **修复 F-03**（工具输出净化）并加测试；或明确把 `memory_status` 从模型工具中移除/改为仅用户 API。
4. **修正 F-04**：MEM-504 在评审通过前不勾选；修正 mechanisms §389/§222/§200/§257；等本报告问题修复后重新评审。
5. **对齐 F-05**：要么按设计在 `CONFIG_CONFLICT` 时停止自动记忆/进入 `config_conflict`，要么修改设计与 README 明确“单项目降级继续”，并让测试与文档一致。
6. **冻结最终树后重跑**：`node --test tests/*.test.mjs`（当前 254/254）、`tools/test-m1-host.mjs`（当前 3/3），重新生成 `m1-node26.tap`/`m1-verification.json`/`m1-host-probe.json`，并确认 README/TODO/mechanisms 的 254 计数与证据 artifacts 一致（F-14）。
7. 建议一并处理 F-06/F-07/F-08/F-09/F-10 的合同/文档/可移植性问题；它们不是安全阻断项，但会影响“可安装/可发布”的完整性。

**最终判定：阻断。** 在 F-01、F-02、F-03、F-04、F-05 修复或明确降级声明，且最终树重跑证据通过之前，不建议发布到 GitHub 或标记 M1 完成。

---

## 附录 A：探针关键输出

### A.1 F-01 激活失败

```text
apply() returned normally = true
tools registered: memory_status
routes registered: /dsh-local-memory/api
memory_status = {"ok":false,"error":{"code":"activation_failed","message":"Local memory is unavailable; fix the plugin configuration."}}
UNHANDLED REJECTION OBSERVED = ENOTDIR: ENOTDIR: not a directory, mkdir 'E:\...\data-root-file-...\probe'
HOST WOULD EXIT 1 UNDER installFailLoud
EXIT=1（无 handler 版本 probe-registry-init3.mjs）
```

### A.2 F-02 混合投影

```text
VERIFY MIXED REQUEST = {"action":"pass"}
NEXT CALLS = 1 CHUNKS = [{"marker":"DOWNSTREAM"}]
DIAGNOSTICS = []
```

### A.3 F-03 工具泄漏

```text
STATUS TOOL LEAKS ABSOLUTE DATA ROOT = true
["C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Temp\\\\mem-review-tool-...\\\\probe", ...]
REMEMBER AS MODEL = {"ok":true,...}
MODEL-WRITTEN ORIGIN = user
DELETE AS MODEL = {"ok":false,"error":{"code":"USER_ACTION_REQUIRED",...}}
```

### A.4 已修复项的正向验证

```text
BASELINE verify = {"action":"block","reason":"record_unavailable"}
AFTER 1030 projections verify = {"action":"block","reason":"projection_unrecorded"}
AFTER 1030 projections nextCalls = 0
```

### A.5 删除生命周期

```text
SEARCH BEFORE = ["mem-life-1"]
BODY ROWS AFTER = 0 FTS MATCHES AFTER = 0
SEARCH AFTER = []
LEDGER STATE AFTER = deleted
SNAPSHOT RESTORE = {"restored":0,"skipped":1,"authorityPreserved":true}
SEARCH AFTER SNAPSHOT RESTORE = []
BODY ROWS AFTER SNAPSHOT RESTORE = 0
```

## 附录 B：探针思路（临时脚本已删除）

- F-01：FakeHost + `apply(ctx, {dataRoot: <普通文件路径>, profile:'probe'})`；监听 `process.on('unhandledRejection')`，再观察 `memory_status` 与 Node 退出码。等价的无插件版本：`createProjectRegistry({config:{dataRoot:file}}).initialize()` 不 attach handler。
- F-02：真实 `openStore` + `createFinalProjection`；对一条消息 `record()`，另一条 own 消息只构造不 `record()`；`verify({sessionId, messages:[recorded, unrecorded]})` 并走一次 `listener`。
- F-03：FakeHost + 真实 `apply` + 真实 `memory_status` 工具；断言输出含 `[A-Za-z]:\\`。
- 淘汰：`record()` 1030 次后询问最早 own 消息；修复后应为 `projection_unrecorded` block。
- 删除：`store.search` → `forget` → `search`/FTS SQL/`restoreSnapshot`。

*本报告只新增 `docs/m1-independent-review.md`；临时脚本在 `scratch-review/`，评审结束删除；未修改源码、未安装/移除插件、未 commit。*

---

## 7. 复核（Lead 修复后，2026-11-07 09:24，Asia/Shanghai）

> 本节是最终复核，优先于 §1–§6 的初评。初评对应的旧快照（253/254 项、F-01/F-02/F-03/F-05 未修复）不再代表当前树。

### 7.1 复核快照与命令

复核时（约 09:22–09:24）的关键文件哈希（SHA-256 前 16 位）：

| 文件 | 哈希 | 说明 |
|---|---|---|
| `plugin/index.mjs` | `a68630a2656de962` | `automaticDisabled`、sanitized status、config conflict 分支 |
| `plugin/project-registry.mjs` | `4ea64737dae0e573` | 同步 `initialize()`、`setPreference` rebuild |
| `plugin/final-projection.mjs` | `7ef9cfa45590c730` | 混合 own 消息扫描 |
| `plugin/session-hooks.mjs` | `f8b10a15705708c5` | admission `inputDigest` |
| `plugin/host-grants.mjs` | `dfb159df845351f3` | 回执比较 `inputDigest` |
| `plugin/management.mjs` | `2fb786a558a43538` | 未改（已知限制） |
| `package.json` | `13e871507f1c6ce0` | `files` 含 `source-lock.json` |
| `tests/plugin-entry.test.mjs` | `f1cc1120a5dc0e56` | F-01/F-03/F-05 回归测试 |
| `tests/final-projection.test.mjs` | `ddde851773d5ec69` | F-02 混合请求测试 |
| `tests/project-registry.test.mjs` | `f3160b3c79dc4ef2` | F-12 测试 |
| `README.md` | `3f4d090d166d16ab` | 258/258、限制 F-08/F-10 |
| `TODO.md` | `8b1175d554afb0e9` | MEM-504 回到 `[ ]` |
| `docs/mechanisms.md` | `567f79eb6019860f` | MEM-MECH-3、修正后的限制 |
| `evidence/m1-verification.json` | `0e65a121f334e9c7` | **仍是 254/254（09:14）** |
| `evidence/m1-node26.tap` | `b39386670d3bd8aa` | **仍是 254 项** |
| `evidence/m1-host-probe.json` | `78cc0d122adeba09` | 3/3、drift 0（我 09:21:58 重跑） |

复核命令与结果：

- `.\runtime\node.exe --test tests/*.test.mjs` → `tests 258 / pass 258 / fail 0 / cancelled 0 / skipped 0 / todo 0`，exit 0。
- `.\runtime\node.exe tools\test-m1-host.mjs` → `tests 3 / pass 3 / fail 0`，`verified:true`，`profileLoaded:false`，`realProviderCalled:false`，exit 0（当前 `m1-host-probe.json` 的 artifacts drift 0）。
- F-01 复跑（`probe-plugin-activation-failure.mjs`，`dataRoot` 为普通文件）：`apply()` 正常返回、只注册 `memory_status`/错误路由、`memory_status` 返回 `activation_failed`，`UNHANDLED REJECTION OBSERVED = null`。
- F-02 复跑（`probe-mixed-projection.mjs`）：`VERIFY MIXED REQUEST = {"action":"block","reason":"projection_unrecorded"}`，`NEXT CALLS = 0`，单 chunk `memory_projection_stale`。
- F-03 复跑（`probe-tool-trust.mjs`）：`STATUS TOOL LEAKS ABSOLUTE DATA ROOT = false`；输出不再含 `dataRoot` 对象或盘符路径。
- F-05 复跑（`probe-config-conflict.mjs`）：预置冲突 catalog 后 HTTP `status` 返回 `automaticDisabled:"config_conflict"`，`config.extraction.enabled:false`、`recall.enabled:false`、`workSummary.enabled:false`，`degraded:[{project:"demo",code:"CONFIG_CONFLICT"}]`；同场景新测试断言没有自动 job。

### 7.2 逐项处置

| ID | 初评问题 | 复核证据 | 处置 |
|---|---|---|---|
| F-01 | async `initialize()` 的未处理拒绝导致 Host 退出 | `project-registry.mjs:116` 已改为同步 `initialize()`；`index.mjs:198` 在 try 内调用；`tests/plugin-entry.test.mjs:181` 回归测试通过；我的激活探针无 unhandled rejection | **已修复并复核通过** |
| F-02 | 混合请求中未登记 own 消息放行 | `final-projection.mjs:153-159` 在匹配后扫描所有 own 消息并 block；`tests/final-projection.test.mjs:158`；我的混合探针 `block/projection_unrecorded`、`nextCalls:0` | **已修复并复核通过** |
| F-03 | `memory_status` 工具泄漏绝对数据根 | `index.mjs:267-283` 只返回白名单字段；`tests/plugin-entry.test.mjs:196` 通过；我的工具探针无泄漏 | **已修复并复核通过** |
| F-04 | MEM-504 勾选过早、机制说明断言不实 | `TODO.md:92` 已回到 `[ ]` 并说明待独立评审；`docs/mechanisms.md:222/383` 已改为包含混合请求的 fail-closed；`MEM-MECH-3`（`docs/mechanisms.md:470`）记录了对 F-01..F-16 的响应；inputDigest 现在真实生效（见 F-13） | **大部分已修正；MEM-503/504 仍未勾选，符合评审中状态** |
| F-05 | `CONFIG_CONFLICT` 只降级、继续自动记忆 | `index.mjs:203-215` 命中后把 extraction/recall/workSummary 全部置 false 并设 `automaticDisabled`；`tests/plugin-entry.test.mjs:207`；我的冲突探针确认 | **已修复并复核通过** |
| F-06 | `task.cancel` 永远不可用 | 代码未改；`docs/mechanisms.md:384`、README 已列为已知限制 | **接受限制（不阻断）** |
| F-07 | `work.evidence.review` 经 HTTP 需预解析 approval | 代码未改；`docs/mechanisms.md:382`、README:134 已记录 | **接受限制（不阻断）** |
| F-08 | 安装进程 profile 解析为 `default` | 代码未改；`docs/mechanisms.md:395`、README:143 已记录多 profile 需显式配置 | **接受限制（不阻断）** |
| F-09 | `package.json.files` 漏 `source-lock.json` | `package.json` 的 `files` 已包含 `source-lock.json` | **已修复并复核** |
| F-10 | 卷白名单硬编码 C:/E:/H: | 代码未改；`docs/mechanisms.md:396`、README:144 已记录 | **接受限制（不阻断）** |
| F-11 | `memory.search` cursor 未绑定 query | 代码未改；`docs/mechanisms.md:397` 已记录 | **接受限制（不阻断）** |
| F-12 | `setPreference` 不 rebuild binding | `project-registry.mjs:170-173` 已 `rebuild()`；`tests/project-registry.test.mjs` 新断言通过 | **已修复并复核** |
| F-13 | 生产 admission 不发送 `inputDigest` | `session-hooks.mjs:56/59` 发送 `inputDigest=fingerprint(input)`；`host-grants.mjs:90` 比较；`src/jobs.mjs:40` 用同一 `fingerprint(payload.input)`；suite 通过 | **已修复并复核** |
| F-14 | 证据与当前代码/文档不一致 | 见 §7.3 R-01 | **仍开放（发布阻断项）** |
| F-15 | `recovery.confirm` 为死操作 | 代码未改；Lead 接受为限制；**但 `docs/mechanisms.md` §6.4 未列这一条** | 接受限制 + 建议补文档（不阻断） |
| F-16 | 模型可写 `origin:"user"` 的 `memory_remember` | 代码未改；`docs/mechanisms.md` §6.4-7 已承认 | 接受限制（不阻断） |

### 7.3 仍然阻断发布的唯一事项（R-01：证据快照未重生成）

**现象（可复现）**：

- `evidence/m1-verification.json`（mtime 09:14:15，`verified:true`）仍记录 `suite.summary.tests: 254`、`pass: 254`，`tapSha256: b3938666…`；`evidence/m1-node26.tap` 的 TAP 头仍是 `# tests 254 / # pass 254`。
- 当前实际全量测试是 **258/258**；`README.md:123`、`TODO.md:40`、`docs/mechanisms.md:360` 也都写 **258/258**。
- `m1-verification.json` 的 12 个 artifacts 与当前文件哈希不一致：`plugin/index.mjs`、`plugin/project-registry.mjs`、`plugin/final-projection.mjs`、`plugin/session-hooks.mjs`、`package.json`、`tests/plugin-entry.test.mjs`、`tests/final-projection.test.mjs`、`tests/project-registry.test.mjs`、`README.md`、`TODO.md`、`docs/mechanisms.md`、`docs/implementation-route.md`。原因是这些文件在 09:18–09:22 被修复，而证据生成于 09:14。
- `evidence/m1-host-probe.json` 是当前的：3/3、`verified:true`、artifacts drift 0（我在 09:21:58 重跑）；它不阻塞。

**为什么这仍是发布阻断**：交付/验收以证据身份为准；按当前 `evidence/` 发布时，仓库中的 `verified:true` 会指向 254 项旧代码哈希，而 README/TODO/mechanisms 声称 258 项——这属于“证据与最终树不一致”，不是代码缺陷，但会破坏可追溯性和验收声明。**只要重生成证据即可关闭，不需要改代码。**

**关闭方式**：在冻结的最终树上重跑并覆盖：

```text
.\runtime\node.exe --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=evidence/m1-node26.tap tests/*.test.mjs
```

然后用当前的 258/258 结果和当前 21 个测试文件的哈希更新 `evidence/m1-verification.json`（其 `commands.suite`/`suite.summary`/`artifacts`/`tapSha256` 全部按实际重写；`m1-host-probe.json` 已是当前的 3/3）。重生成后应再核一次 `README.md:123`、`TODO.md:40`、`docs/mechanisms.md:360` 与 tap 一致。

### 7.4 不阻断的观察

- **R-02（Minor，HTTP status 形状）**：`/dsh-local-memory/api` 的 `status` 中 `value.plugin` 是字符串 `"dsh-local-memory-linqu"`（`index.mjs:45`），而 `management.dispatchStatus` 的 `defaults.plugin` 是对象（`plugin/management.mjs:457-459`）；`automaticDisabled` 在 value 顶层，测试也已按顶层断言。当前客户端只读 `status.scheduler.state`（`client.js:1569`），未发现消费者因此损坏；建议统一形状或写入 API 合同，非阻断。
- **R-03（Minor，F-15 文档）**：`recovery.confirm` 死操作在机制 §6.4 未列为限制；Lead 已接受为限制，建议补一行。
- **R-04（重载提醒）**：已安装 DSH 进程仍加载修复前的旧模块代次；current source 的安装后行为需重启/重载插件后重新观测（不影响本报告的代码/测试结论，但做发布前安装验收时要重做）。
- F-06/F-07/F-08/F-10/F-11/F-15/F-16 都是接受限制；F-06/F-07/F-08/F-10/F-11 已在 README/mechanisms 有记录（F-15 见 R-03）。

### 7.5 最终判定

- **代码 / 安全 / 功能：不阻断。** 初评的 Critical/Important 代码问题（F-01/F-02/F-03/F-05）以及 F-09/F-12/F-13 均已由我独立复跑验证；258/258 全量测试通过，真实安装库探针 3/3，删除/FTS/快照、HTTP 负向、模型用户动作隔离等独立探针均保持通过。未发现其他可导致 scope 扩大、无授权删除、unknown 自动解除或最终门绕过的高危缺陷。
- **发布：当前阻断，且仅因 R-01（`evidence/m1-verification.json` 与 `evidence/m1-node26.tap` 仍是 254 项/旧 artifacts，和当前 258 项/最终代码不一致）。** 在重生成证据并确认 `README:123`/`TODO:40`/`mechanisms:360` 与 tap 一致后，本评审的最终判定为 **不阻断**。
- 一句话：**代码可以发布；带当前 evidence 不能发布；重生成 evidence 后即可发布。**

