# 05 本地长期记忆 M2（v0.3.0 增量）独立评审

评审日期：2026-11-08（Asia/Shanghai）
评审对象：`E:\dsh\plugin\05-local-memory` v0.3.0，M2 的 abstract、跨项目共享、退休适用性与 catalog v1→v2 增量
评审方式：只读源码、独立临时库/FakeHost 探针、真实安装态只读 HTTP/SQLite 查询、证据文件复核；未修改被评审源码、未安装/卸载插件、未提交。
作者未参与本评审；本文只对 2026-11-08 15:58 +08:00 的最终快照负责。

> 评审期间 Lead 于 15:34–15:51 应用了多轮修复（阈值配置、多仓适用性、模型 target、read 阈值一致、迁移 identity 顺序、适用性 fail-closed、自动 dirty 接线、resolve upToDate）。本文的验证在最终源码上重跑；临时探针均位于 `scratch-review/`，结果摘录于下，探针已清理。

## 1. 范围与快照

### 1.1 评审范围

- catalog v2：`src/projects.mjs` 的 v1→v2 迁移、schema 签名、identity/回滚/幂等。
- abstract：`src/abstracts.mjs`，catalog 表、basis 绑定、删除/纠正/归档即时失效、60 条上限、阈值、退休行为、路径/隐私。
- 共享：`src/sharing.mjs`，授权/撤销/自动跟随、`STALE_ABSTRACT`、`SHARE_DENIED`、不复制明细、审计字段、适用性。
- 适用性：`plugin/project-registry.mjs` 的 `applicabilityForScope/ForProject`。
- 管理 API：`plugin/m2-management.mjs` 的 7 个操作、信封/脱敏、用户动作与 model/host 边界。
- 接线：`plugin/index.mjs` 的 manager、extras 合并、`memory_abstracts`/`memory_shared_search`、自动 dirty（提取完成、tool remember、`/memory remember`）、维护 timer、状态投影；`plugin/scheduler.mjs` 的 `onJobSettled`。
- 客户端：`client.js` 第 4 tab（SharingTab）、`locale/en.json`/`zh.json`。
- 测试：`tests/abstracts.test.mjs`、`tests/sharing.test.mjs`、`tests/m2-management.test.mjs`、`tests/projects.test.mjs`、`tests/project-registry.test.mjs`、`tests/plugin-entry.test.mjs`。
- 声明：`TODO.md`、`README.md`、`docs/mechanisms.md`、`docs/m2-design.md`、`docs/implementation-route.md` 与 `evidence/m2-*`。

### 1.2 最终快照 SHA256（前 16 位，2026-11-08 15:52 +08:00）

| 文件 | SHA256 前缀 | 文件 | SHA256 前缀 |
|---|---|---|---|
| `src/projects.mjs` | `928f7150c29ccf96` | `src/abstracts.mjs` | `01f979c4cd2057fa` |
| `src/sharing.mjs` | `a3fef953995a33ad` | `plugin/m2-management.mjs` | `03e3df3ea9325aa6` |
| `plugin/project-registry.mjs` | `a01e203360abb476` | `plugin/index.mjs` | `ae91464dc9322a2a` |
| `plugin/management.mjs` | `bbd77d5dcf3e4de4` | `plugin/configuration.mjs` | `ce21bbca16603afa` |
| `plugin/scheduler.mjs` | `b288595558ee0c48` | `package.json` | `a0190c3061723814` |
| `client.js` | `5afd6dd796a461e2` | `locale/en.json` | `b9f4f98ceb65510b` |
| `locale/zh.json` | `fa3a1fb353044e87` | `tests/abstracts.test.mjs` | `655d138e6bfcc880` |
| `tests/sharing.test.mjs` | `5639f164394c53d7` | `tests/m2-management.test.mjs` | `c982ff36edba95f8` |
| `tests/projects.test.mjs` | `06f88c86faaa2d9d` | `tests/project-registry.test.mjs` | `791f2f56202d3893` |
| `tests/plugin-entry.test.mjs` | `1f811eb29eef3602` | `README.md` | `78f4bdc3ec67a32c` |
| `TODO.md` | `f0163b6d932cfb6d` | `docs/m2-design.md` | `eeac1a2834c5815a` |
| `docs/mechanisms.md` | `fe1cc076d136903b` | `docs/implementation-route.md` | `a924d53923e4af23` |
| `evidence/m2-verification.json` | `7324f90758e05df4` | `evidence/m2-install-verification.json` | `ea49d84f332fd289` |
| `evidence/m2-node26.tap` | `dfed7af9a27a39cc` | | |

证据时点说明：`evidence/m2-verification.json` 于 15:56:38 重生成，33 个 artifacts 与当时树 **0 mismatch**；它把 `docs/m2-independent-review.md` 也列入 artifacts，而本文件在证据生成后又被更新以写入最终结论，因此重跑 `verify-m2.mjs` 时该单文件哈希会变化；发布前应再跑一次（不改变其他 32 个物料的匹配结果）。`evidence/m2-install-verification.json` 的 8 个 `materialHashes` 当前 0 mismatch。

## 2. 验证命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `.\runtime\node.exe --test tests/*.test.mjs` | **318/318 通过**，fail 0、skipped 0；duration ≈ 7.1–9.3s（Node v26.13.0） |
| 2 | `.\runtime\node.exe --test tests/abstracts.test.mjs tests/sharing.test.mjs tests/m2-management.test.mjs tests/projects.test.mjs tests/project-registry.test.mjs tests/plugin-entry.test.mjs` | **84/84 通过**（abstracts 17、sharing 8、m2-management 26、projects 13、project-registry 9、plugin-entry 11） |
| 3 | 其余 18 个测试文件 | **234/234 通过** |
| 4 | M1 原有 21 个测试文件（现含新增 M2 用例） | **267/267 通过**；无旧行为回归 |
| 5 | `.\runtime\node.exe scratch-review\probe-migration-final.mjs`（临时库） | **4/4**：v1→v2 数据/identity、漂移拒绝、注入 DDL 失败回滚、identity 不一致在迁移前拒绝且保持 v1 |
| 6 | FakeHost 自动 dirty（`probe-plugin-auto-refresh.mjs`） | `memory_remember` 后 `dirtyCount=1`；`/memory remember` 后再增至 **2**；两条用户路径都会标记 dirty |
| 7 | FakeHost 提取完成（`probe-extraction-dirty.mjs`） | 自动提取完成后 `abstracts.dirtyProjects=1`；`onJobSettled` 接线生效 |
| 8 | `probe-read-threshold2.mjs`（仅 noteChange、store 无变化） | `first=1, shouldRefresh=true, read=2, stale=false, dirty=0`；read 与 shouldRefresh 已一致 |
| 9 | `probe-audit-final.mjs`（grant→revoke→re-grant） | `created_at` 保留；`revoked_at` 被清空；`decision_basis`/`permission_ref` 被第二次 grant 覆盖；旧值未保留 |
| 10 | `probe-path-final.mjs` | module abstract view 含 `C:\review-secret`；经 `abstract.list` 后 `sourceRef/sourceVersion/summary` 均为 `[redacted-path]` |
| 11 | `.\runtime\node.exe --check client.js` | exit 0 |
| 12 | locale/客户端静态检查 | en/zh 各 310 键，0 差异；客户端内联 en/zh 各 310 键，与 locale 双向 0 差异；无 Harness 客户端包导入、无 `document.body`、无原始颜色值；轮询/通知 timer 均有 cleanup |
| 13 | 真实安装态 `POST http://127.0.0.1:8656/dsh-local-memory/api`（`operation=status`） | HTTP 200，`state=ready`、`plugin=dsh-local-memory-linqu`、projects=1、activeProjectCount=0、scopes=1、abstracts 0/0/0、sharing 0/0/0、`cold.status=not_configured` |
| 14 | 真实 catalog 只读 SQLite（`E:/dsh-data/05-local-memory/default/catalog.sqlite`） | `user_version=2`；14 张表含 `abstract_revisions/abstract_state/share_relations/capability_*`；1 个项目（`install-verification`，retired）、1 repo、0 abstract、0 share；identity 锚一致 |
| 15 | Host `cordis_inspect_query platform=host provider=Tool method=listTools` | 运行中的模型工具含 `memory_abstracts`、`memory_shared_search`，schema 与当前源码一致 |
| 16 | `cordis_inspect_query platform=client provider=Slots method=listSubTree root=settings.section` | **10s 超时**（页面未连接）；客户端槽位/视觉本次无法独立复核 |
| 17 | 证据复核（SHA256/TAP/locale/控制字符） | `m2-verification` 318/318、TAP 哈希匹配、**33 artifacts 0 mismatch**（生成时）；install evidence materialHashes 0 mismatch；README 无控制字符 |

## 3. 发现（findings）

严重度定义：Critical = 数据/安全边界被突破或不可恢复；Important = 核心承诺/验收/证据不成立，发布前必须处理；Minor = 规格偏差、可解释限制或文档/证据小缺陷。

| ID | 严重度 | 位置 | 主张/问题 | 证据与命令 | 影响 | 建议修复 |
|---|---|---|---|---|---|---|
| **F-01** | Minor（审计限制） | `src/sharing.mjs:218-228`（grant upsert）、`:242-249`（revoke） | “关系 upsert 保留审计轨迹”只部分成立：`relationId`、`createdAt` 保留，但重新 grant 覆盖 `decisionBasis`、`permissionRef`，并把 `revokedAt` 清为 NULL；没有 append-only 的授权/撤销历史。 | `probe-audit-final.mjs` 输出：`created_at_preserved=true`；`prior_revoked_at` 有值，`current_revoked_at=null`；`current_decision='second decision'`；`current_permission='local-user-grant-v1:second'`；旧的 first decision/permission 丢失。 | 当前行只表达最新状态；无法审计“何时被谁撤销、为何重新授权”。本地单用户、用户主动重授权时影响有限；设计也明确 upsert 更新 basis/permission，因此这是审计口径限制，不是越权。 | 若需要历史：新增 append-only `share_relation_events`（grant/revoke/复授权），或在 `share_relations` 保留上一版字段；若接受“仅当前状态”，在 README/mechanisms 明确写“重授权清除 revoke 记录”。 |
| **F-02** | Minor（模块边界/隐私规格偏差） | `src/abstracts.mjs:208-226`（viewOf 的 summary/sourceRef）、`:249-269`（payload 解析） | 设计 §3.1 要求 abstract view/payload“无绝对路径”；模块 view 会原样带出用户记忆文本/sourceRef 中的路径式字符串。 | `probe-path-final.mjs`：写入 `C:\review-secret\...` 的 text/sourceRef 后，`abstracts.refresh` 的 view 含该路径；同一数据经 `abstract.list` 后 `sourceRef/sourceVersion/summary` 均变为 `[redacted-path]`，`apiContainsReviewSecret=false`。 | 只在绕过管理 API 直接使用 manager 时可见；模型/UI 路径已脱敏，当前无模型泄漏。但与“view 不含绝对路径”的合同不一致。 | 在 `viewOf`/`emptyView` 边界做路径/敏感文本脱敏，或把合同改成“模块保留原文，管理 API/工具边界脱敏”，并保留 mechanisms §6.3 的已知限制。 |

**未发现 Critical 或 Important。** 仅 2 个 Minor；另有 latent/未验证边界见 §6。

### 3.1 评审期间已修复并复核的项（不计 finding）

- 自动 dirty：提取任务 `onJobSettled`、`memory_remember`、`/memory remember` 均调用 `abstracts.noteChange`；FakeHost 验证 dirtyCount 从 0→1（tool）→2（command），提取完成 `dirtyProjects=1`。
- 阈值一致：`read` 在 revisionSummary 不变时也检查 dirty/age；仅 noteChange 时 `shouldRefresh=true` 会真正刷新（`read=2, dirty=0`）。
- 配置阈值：`abstracts.dirtyCountThreshold`/`ageHours` 传入 manager；默认与自定义 manager 独立。
- 多仓适用性：`applicabilityForProject` 取所有 enabled repo 的最差值；缺一个根即 `historical_unknown`。
- 模型 target：`projectIdOf` 对 model/host 显式 target 必须等于绑定 project；用户 HTTP 可显式指定。
- 迁移 identity：identity 校验移到 v1→v2 DDL 之前；identity 不一致时 catalog 保持 `user_version=1`（`probe-migration-final` 4/4）。
- 适用性 fail-closed：abstract 与 sharing 的 registry probe 抛异常时回退 `unavailable`，不再把 active 项目提升为 `current`。
- `resolve` 的 `upToDate` 现在由 `abstract.stale` 决定，与 `list()` 一致。

## 4. `docs/m2-design.md` §5 验收矩阵

| 验收 | 状态 | 证据/说明 |
|---|---|---|
| **MEM-M2-A1** 两个登记项目 A/B：A 有经验 → A abstract 可被发现；B 不能读 A 明细；用户 grant 后 B 可按查询读明细并带来源/适用性；revoke 后同查询立即 `SHARE_DENIED` | **通过** | 全量 318 与 M2 84/84；`tests/plugin-entry.test.mjs` M2 端到端、`tests/sharing.test.mjs`、`tests/m2-management.test.mjs`；独立 probe 中 discover 不含明细、grant 前 `SHARE_DENIED`、grant 后 items 带 `sourceRef/sourceVersion/verification='unverified'/applicability`、revoke 后 `SHARE_DENIED`。 |
| **MEM-M2-A2** A 删除被引用记忆 → abstract 立即刷新且不含该条；B 已建立共享的明细不再返回；晚到任务不能复活 | **通过** | `tests/abstracts.test.mjs` deletion/correction/archive 用例；`tests/plugin-entry.test.mjs` 删除后 shared search 为空；删除 id 再 `store.put` 抛 tombstone；`abstract_revisions` 追加不覆盖。 |
| **MEM-M2-A3** A 新增/纠正记忆使 abstract 变化：关系保持 active，读取自动使用最新有效 revision，`upToDate` 变 true | **通过（含合并延迟）** | 提取完成、tool remember、`/memory remember` 均标记 dirty（FakeHost dirtyCount 0→1→2；提取 `dirtyProjects=1`）；`read` 在 10 条/24h 阈值触发新 revision；`list`/`resolve` 在 source abstract stale 时 `upToDate=false`，刷新/跟随后为 true。低于阈值时按设计保持 stale，不立即重建。 |
| **MEM-M2-A4** A 退休：abstract/记忆仍可管理；applicability=`historical_unknown`；已有共享仍可读但标记 historical；不自动产生新共享 | **通过（组件级）** | `tests/abstracts.test.mjs` retired 用例、`tests/sharing.test.mjs` retired source/target 用例；独立 probe 中 retire 后 abstract view `projectState=retired`、`applicability=historical_unknown`，已有 resolve 仍返回 source 明细且标 historical，新 grant `PROJECT_RETIRED`。真实 profile 未做退休项目记忆管理写入。 |
| **MEM-M2-A5** 模型/工具不能 grant/revoke/refresh（`USER_ACTION_REQUIRED`）；共享明细不复制成 B 记录；异常/未知项目 fail closed | **通过** | `tests/m2-management.test.mjs` 25+1 项（用户动作、项目解析、模型 target 越权、脱敏、真实 managers）；M2 table 与 management dispatcher 两层拒 model；HTTP 固定 `actor:'user'`；shared resolve 不写 target store；未知项目/无 relation/无 abstract/store 异常均 fail closed。 |
| **MEM-M2-A6** catalog v1→v2 迁移幂等、失败回滚、旧数据与 identity 保持；v0.2.0 现有 258 项回归全绿 | **通过** | `probe-migration-final` 4/4（数据/identity、漂移拒绝、DDL 失败回滚、identity 不一致迁移前拒绝）；全量 318/318，M1 21 个文件 267/267；真实 catalog `user_version=2` 且 M2 表存在。历史 258 基线保留在 `evidence/m1-verification.json`，未在旧提交上重跑。 |

## 5. 声明/过度声明检查（TODO/README/mechanisms）

| 被检查声明 | 判定 | 说明 |
|---|---|---|
| M2 是否声称完整完成 / MEM-204、冷档、语义压缩已完成 | **未过度声明（通过）** | `TODO.md:3,73` 明确 MEM-201/202/203 已实现、MEM-204 未实现；`README.md:5`、`docs/mechanisms.md:12` 明确 MEM-204/M3/MEM-405 未实现；abstract 明确是 `local-extractive-v1`，不是模型语义压缩（`README.md:156`、`mechanisms.md:265`、`m2-design.md:138`）。 |
| 客户端视觉是否被冒充为已验证 | **未过度声明（通过）** | `README.md:138,156`、`mechanisms.md:398`、`m2-install-verification.json` limitations 均写“第 4 tab 未做浏览器视觉验收、需页面重载”；本次 client Slots inspect 超时，无法复核。 |
| “新增变动按 10 条/24h 合并刷新” | **成立（通过）** | 提取 `onJobSettled`、`memory_remember`、`/memory remember` 均 dirty；`read` 阈值一致；FakeHost/probe 已验证。直接 `store.put` 的 manager API 仍要求调用方 `noteChange`，这是模块合同，不是插件主路径。 |
| `m2-verification.json` 的 `verified:true` 与 artifacts | **成立（生成时）** | 15:56:38 重生成：318/318、33 artifacts 0 mismatch、TAP 哈希匹配、install materialHashes 0 mismatch。评审文件本身在证据后被更新，发布前重跑一次即可。 |
| `TODO.md:105`“共享与冷档（对应 M2/M3 未实现）” | **已修正** | 当前行已改为 M2 剩余（MEM-204）与 M3，避免与已交付 M2 共享矛盾。 |
| `mechanisms.md:505`“M2 独立评审发现的阈值/绑定/适用性问题已修复” | **成立** | 阈值、模型绑定、多仓/探测适用性已在最终树修复并复核；本评审剩余仅审计/路径/文档 Minor。 |

## 6. 明确未验证边界

1. **真实数据根的 M2 写入旅程未验证**：真实 desktop profile 只有 1 个 retired 项目（`install-verification`），0 abstract、0 share；按评审约束未创建项目、未写记忆、未 grant/revoke/refresh、未做 shared read。A1–A6 的行为证据来自临时库/FakeHost/真实 manager，不是真实数据根。
2. **客户端视觉与当前 slot 未验证**：`client.js` 语法/字典/静态检查通过，但 `cordis_inspect_query`（client/Slots `settings.section`）本次两次 10s 超时；`m2-install-verification.json` 的 slot active 是更早的观测，不能替代当前浏览器视觉/交互验收。第 4 tab 需页面重载更新 bundle 后才可见。
3. **安装态代码代次未完全证明**：live status 为 `state=ready` 且 `cold.detail` 是当前源码字符串；install evidence 的 materialHashes 与当前树一致。但没有在真实 profile 做 M2 行为写入，无法用行为证明运行进程加载的是最终源码代次；需重启/重载后复核。
4. **真实 Provider / OS 出口未验证**：所有 M2 路径为本地确定性逻辑；没有真实 deepseek Provider、真实费用/质量、OS 级出口/子进程/DNS/代理证据。
5. **HTTP 用户动作边界是 M1 基线语义**：同源 `POST /dsh-local-memory/api` 固定 `actor:'user'`，没有额外 token/OS 级认证；本地非浏览器进程可伪造无 Origin 请求。本评审未做该威胁的现场测试；M1 已接受该本地路由模型，M2 未新增认证。不要把它说成“用户身份认证”。
6. **latent（未从当前工具可达）**：`plugin/m2-management.mjs:315-329` 的 `share.list` 不经过 `projectIdOf`，若未来有 model/host 调用方直接调用额外操作表，可在不传过滤条件时列出所有 relation 的 decisionBasis/permissionRef。当前模型工具只暴露 `memory_abstracts`/`memory_shared_search`，未发现可达路径，故列为 latent，不计入 findings。
7. **路径脱敏只覆盖 Windows 盘符/UNC**：`m2-management`/`management` 的 `ABSOLUTE_PATH` 对 POSIX 风格绝对路径不脱敏；产品当前是 Windows 本地路径模型，未做跨平台验证。
8. **`test-m1-host.mjs` 旧探针未重跑**：为不写 `evidence/m1-host-probe.json`（评审约束），本次只复核其历史证据与 318 全量回归；真实安装库最终门 3/3 是 Lead 证据声明，不是本次独立执行。

## 7. 最终结论

**不阻断。** 本次 **0 Critical、0 Important、2 Minor**（审计历史、abstract 模块 view 路径）。代码与证据在最终快照上自洽：318/318、M2 84/84、迁移 4/4、真实 catalog v2、模型/用户边界与自动 dirty 路径均复核通过；未发现 M2 完成度、冷档或模型语义压缩的过度声明。

发布前/发布时建议一并完成：
1. F-01：若产品需要共享授权历史，增加 append-only `share_relation_events`；若接受当前状态，仅在文档明确“重授权清除 revoke 记录”。
2. F-02：把“abstract view 无绝对路径”改为“模块保留原文，管理 API/工具边界脱敏”，或在 view 边界脱敏。
3. **证据收尾**：`docs/mechanisms.md` 与本评审文件在 `m2-verification` 生成后被更新；发布前重跑 `.\runtime\node.exe tools\verify-m2.mjs`，并确认 33 个 artifacts（含本文件最终哈希）全部匹配。其余 32 个物料当前已匹配。

Lead 在 15:55 将 `mechanisms.md:265` 的测试计数由 15 修正为 17，F-03 关闭；因此最终为 2 个 Minor。

以上 Minor 不构成发布阻断；真实 Provider、真实 profile M2 写入旅程、浏览器视觉和 OS 级出口仍是明确未验证边界，不应在发布说明中声称已完成。

