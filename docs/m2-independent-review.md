# 05 本地长期记忆 M2（v0.3.0 增量）独立评审

- 评审角色：独立评审员（未参与本增量实现；只读源码、独立临时库/FakeHost 探针、真实安装态只读 HTTP/SQLite 查询与证据重算；未安装/卸载插件、未提交、未修改被评审源码；本文件是本次唯一写入）。
- 评审日期：2026-11-08（Asia/Shanghai）。
- 评审对象：`E:\dsh\plugin\05-local-memory` v0.3.0 的 M2 增量：catalog v1→v2、项目 abstract、用户授权跨项目共享、退休适用性、管理 API/模型工具、记忆中心第 4 个 tab。
- 提交状态：**工作树未提交**。`HEAD` 仍为 `3dc60e6`（v0.2.0）；M2 相关文件处于 `M`/`A`/`AM` 状态（`git status --porcelain` 共 34 项，含已暂存项），没有新的 M2 提交。
- 快照：最终源码/测试/文档在 **2026-11-08 15:52 +08:00** 前后冻结；证据 `evidence/m2-verification.json` 于 15:58:35 由 Lead 重新生成。评审期间（15:34–15:57）Lead 多轮修改过代码、测试、文档与本文件，因此本文所有命令均在 **最后一次代码/测试修改之后** 重跑；`docs/m2-independent-review.md` 自身的写入会改变证据中该单文件的 artifact 哈希（见 N1）。
- 方法边界：真实安装态只读（`operation=status`、catalog `PRAGMA user_version`/表清单/identity 锚），未创建项目、未写记忆、未 grant/revoke/refresh；`tools/verify-m2.mjs` **未执行**（它会重写证据文件），改为只读重算 SHA256 并对照。

## 0. 关键文件 SHA256（实际校验的当前字节）

| 文件 | SHA256（完整） |
|---|---|
| `src/projects.mjs` | `928f7150c29ccf9610deb7876e149b83b2ebe96b96f5b54b830f6ef53b0ab0c4` |
| `src/abstracts.mjs` | `01f979c4cd2057fa0ee2729348978762255ac17ac0b3f4daf01979dce16ab093` |
| `src/sharing.mjs` | `a3fef953995a33adf27682736b54b1a6231c71e36f4c7fc30f74fdf6d6762b91` |
| `plugin/m2-management.mjs` | `03e3df3ea9325aa6aacbd3a46ac81e5d239a37624008c6136989a8d8628603ac` |
| `plugin/project-registry.mjs` | `a01e203360abb476e7394b8fc28e62956dd80b24fe59edf04328b117844276f8` |
| `plugin/management.mjs` | `bbd77d5dcf3e4de4320268418d4f64566635b45d5f9aa2367c3620b3a08790b4` |
| `plugin/index.mjs` | `ae91464dc9322a2a2b834bddf935011fac03811d7f0cdfd37952845fb5a49a47` |
| `client.js` | `5afd6dd796a461e2e564f50bd9e51612ec35ac2df20e2e5760ba62ab39dfcb6e` |
| `evidence/m2-verification.json` | `8434caf4e56f7d4c9dbf0473a2eec5934cd71403c83728f155e019276f845da4` |
| `evidence/m2-install-verification.json` | `ea49d84f332fd28903c862084ae840a740dc7cb22752e43c444cc0bf61172104` |

证据时点说明：`evidence/m2-verification.json` 生成时（15:58:35）为 **318/318、33 个 artifacts、TAP 哈希匹配、probe 3/3**；写作时重算为 **32/33 匹配**，唯一不匹配的是 `docs/m2-independent-review.md` 本身（证据生成后本文件又被写入）。`evidence/m2-install-verification.json` 的 10 个 `materialHashes` 当前全部匹配。发布前需在本文冻结后最后重跑一次 `tools/verify-m2.mjs`，届时证据文件的 SHA256 会变为新值；上表为评审时快照。

## 1. 验证命令与结果

| # | 命令/探针 | 结果 |
|---|---|---|
| 1 | `.\runtime\node.exe --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs` | **318/318 通过**，fail 0、cancelled 0、skipped 0；exit 0；Node v26.13.0；duration ≈ 28.0s（我本人在最终树上重跑） |
| 2 | 单独运行 M2 相关文件：`tests/abstracts.test.mjs tests/sharing.test.mjs tests/m2-management.test.mjs tests/projects.test.mjs tests/project-registry.test.mjs tests/plugin-entry.test.mjs` | **84/84 通过**：abstracts 17、sharing 8、m2-management 26、projects 13、project-registry 9、plugin-entry 11 |
| 3 | `tests/scheduler.test.mjs`（含 `onJobSettled` 新用例） | **10/10 通过** |
| 4 | `.\runtime\node.exe scratch-review\final-review-probe.mjs`（我自建的独立临时库探针） | **11/11 通过**：配置阈值、模型/宿主显式 target、多仓适用性、A1/A2/A3/A4/A5、`noteChange`-only 阈值、stale 时 `list`/`resolve` 的 `upToDate=false`、路径脱敏、用户动作边界 |
| 5 | `scratch-review\probe-extraction-dirty.mjs`（真实 `apply` + FakeHost，自动提取） | 提取完成后 `abstracts.dirtyProjects=1`；`onJobSettled` 接线生效 |
| 6 | `scratch-review\probe-plugin-auto-refresh.mjs`（真实 `apply` + FakeHost，`memory_remember` 与 `/memory remember`） | `dirtyCount`：初始 0 → tool 后 1 → command 后 2；两条用户路径都标记 dirty |
| 7 | `scratch-review\probe-read-threshold2.mjs`（仅 `noteChange`、store 无变化） | `first=1, shouldRefresh=true, read=2, stale=false, dirty=0`；`read` 与 `shouldRefresh` 一致 |
| 8 | `.\runtime\node.exe --test --test-name-pattern="identity mismatch\|drift is refused\|migrates additively" tests\projects.test.mjs` | **3/3 通过**：v1→v2 数据/identity、漂移拒绝、identity 不一致在迁移前拒绝并保持 `user_version=1` |
| 9 | 只读证据重算（Node `crypto`，不写文件） | `m2-verification`：318/318、TAP 哈希匹配、probe 3/3、33 artifacts 中 32 匹配；install materialHashes 10/10 匹配；`README` 无控制字符 |
| 10 | `.\runtime\node.exe --check client.js`；locale/客户端静态检查 | exit 0；en/zh 各 310 keys、0 差异；第 4 tab 标签存在；客户端仅 `POST /dsh-local-memory/api`；`shared.search` 调用带 `targetProjectId` |
| 11 | 真实安装态只读 `POST http://127.0.0.1:8656/dsh-local-memory/api`，`operation=status` | HTTP 200：`state=ready`、`plugin=dsh-local-memory-linqu`、projects=1、activeProjectCount=0、abstracts 0/0/0、sharing 0/0/0、`cold.status=not_configured` |
| 12 | 真实 catalog 只读 SQLite：`E:/dsh-data/05-local-memory/default/catalog.sqlite` | `user_version=2`；M2 表 `abstract_revisions/abstract_state/share_relations/capability_*` 齐全；1 个 retired 项目、0 abstract、0 share；identity 锚与 `meta.identity` 一致 |
| 13 | `cordis_inspect_query platform=client provider=Slots method=listSubTree root=settings.section` | **10s 超时**（页面未连接）；本次无法独立复核当前客户端 slot/视觉 |
| 14 | `tools/test-m1-host.mjs` 真实安装库最终门探针 | **未重跑**（会重写 `evidence/m1-host-probe.json`）；只核验其证据 JSON/TAP 哈希与 318 全量回归。3/3 是证据声明，不是本次独立执行 |

## 2. 发现

### 2.1 上一轮 interim findings F1–F6 的当前状态

| ID | 上一轮问题 | 当前状态 | 证据 |
|---|---|---|---|
| **F1** | `abstracts.dirtyCountThreshold`/`ageHours` 配置未从 `index` 接到 manager | **已修复/已复核** | `plugin/index.mjs:232-236` 把 `config.abstracts.*` 作为 `thresholds` 传入；`tests/abstracts.test.mjs` 的 “configured coalescing thresholds…” 通过；我的 `final-review-probe` #F1 以 `dirtyCountThreshold=2` 验证 `noteChange` 两次后 `shouldRefresh=true` 且 `read` 刷新、`dirtyCount=0` |
| **F2** | model/host 可用显式 `projectId`/`targetProjectId` 越过可信会话绑定 | **已修复/已复核** | `plugin/m2-management.mjs:271-284` 的 `projectIdOf`：非 user 的显式值必须等于 `boundProjectId(context)`，否则 `USER_ACTION_REQUIRED`；user/HTTP 例外保留。`tests/m2-management.test.mjs:228,749` 覆盖 model/host 三个读操作；我的 `final-review-probe` #F2 对 `abstract.list`/`share.discover`/`shared.search` 三操作、model+host 均验证拒绝，user 显式 target 保留 |
| **F3** | `applicabilityForProject` 未取所有 enabled repo 的最差值 | **已修复/已复核** | `plugin/project-registry.mjs:214-229` 遍历全部 enabled repository，任一 `canonicalRoot` 不存在即 `sourceAvailable=false`、`historical_unknown`；`tests/project-registry.test.mjs:206` 覆盖；我的 `final-review-probe` #F3 在删除两个 repo 中的一个根后验证 project 级 `historical_unknown` |
| **F4** | `evidence/m2-verification.json` 的 artifact 哈希/计数过期 | **已修复（32/33；本评审文件待最后重跑）** | 15:58:35 重生成：318/318、33 artifacts、0 mismatch（当时）；写作时重算 32/33；唯一不匹配是 `docs/m2-independent-review.md`（本文件在证据后被写入），TAP 哈希匹配、probe 3/3、install materialHashes 10/10 匹配；“47”旧计数声明已不存在。发布前最后重跑 `tools/verify-m2.mjs` 即可使 33/33，见 N1 |
| **F5** | 旧的 “47 artifacts” 类计数声明 | **已修复/已复核** | `grep` 全树无 “47 项/47 artifacts/47” 类声明；`docs/mechanisms.md:382` 改为“项数见该证据文件的 artifacts”；当前为 33 个 artifacts |
| **F6** | 文档残留/测试计数/cold.status 等陈旧声明 | **已修复/已复核** | `README.md:131` 为 318/318（abstract 17、sharing 8、m2-management 26）；`docs/mechanisms.md:382/388` 为 318/17/26/projects 13/scheduler 10；`docs/mechanisms.md:265` 为 abstract 17 项；`TODO.md:54` 为全量 318；`docs/m2-design.md:122` 为 318；README 的 U+0007 控制字符已为 0；`cold.status=not_configured` 与代码/live status 一致；`TODO.md`/README/mechanisms 均明确 MEM-204/M3/MEM-405 未实现 |

### 2.2 本次新发现（独立复现）

| ID | 严重度 | 位置 | 主张 | 证据/命令 | 影响 | 建议修复 |
|---|---|---|---|---|---|---|
| **N1** | Minor（证据顺序） | `tools/verify-m2.mjs:29-40,49-52`；`evidence/m2-verification.json` 的 artifacts | `verify-m2` 把 `docs/m2-independent-review.md` 本身列入 artifacts；证据一旦生成，之后写入/更新评审文件就会使该单文件哈希失效，而 `verified` 仍可能为 true（它现在会检查 artifacts，但只能在同一次运行内自洽） | 15:58:35 证据记录的是写入前的评审哈希 `029b474d…`；本文写入后重算仍只这一项不匹配（32/33）。 | 发布用的 `verified:true` 无法同时覆盖“最终评审文件”和“已冻结证据”；外部复核会看到 1 个 artifact 不匹配。不是代码/安全缺陷。 | 二选一：把评审文件从 artifacts 排除（它属于交付说明，不是被验证物料）；或在评审文件冻结后最后跑一次 `tools/verify-m2.mjs`，并以重跑后的证据为准、在发布说明中注明证据快照时间 |
| **N2** | Minor（发现提示） | `src/sharing.mjs:158-186`（discover 返回字段）；`src/abstracts.mjs:318-333`（stale 语义） | `sharing.discover` 的 source 摘要条目只含 `abstractRevision/abstractDigest/generatedAt/counts/applicability`，**不含 `stale`**；当 source abstract 已 stale（新增变动未达 10 条/24h 合并阈值）时，发现页仍会展示旧摘要且没有“已过期/待刷新”提示。用户只能刷新“本项目”的 abstract，不能从共享页刷新 source 的摘要。 | 我的 `scratch-review/probe-discover-stale.mjs`：source 的 `abstracts.read` 返回 `stale:true, dirty:1`，`sharing.discover` 的条目 key 集合不含 `stale`，`abstractRevision` 与旧 revision 相同。 | 用户/Agent 可能基于过期摘要决定建立共享；不会绕过授权（grant 仍要求当前 revision），明细检索仍读 live 记录，因此不是数据泄漏或越权。 | 在 `discover` 条目增加 `stale`（和/或 `generatedAt` 已有）并在客户端显示“来源摘要已过期”；或允许用户对 source 项目执行一次显式 `abstract.refresh` |

**没有发现新的 Critical 或 Important 缺陷。** 以上两项均为 Minor；另有已记录的规格限制（审计历史、模块级 view 路径、`share.list` latent、Windows-only 脱敏）见 §5。

### 2.3 已记录/接受的限制（不作为新 finding）

- **共享审计不是 append-only**：同一 source→target 重新 grant 会覆盖 `decision_basis`/`permission_ref` 并清空 `revoked_at`，只保留 `relation_id`/`created_at`；README 限制 18、mechanisms §6.4-24 已明确“当前状态模型”。不是越权。
- **manager 级 view 保留原文路径式文本**：`abstracts.refresh` 的模块 view 可含记忆文本/sourceRef 中的 `C:\...`；`abstract.list`/`shared.search` 的管理 API/工具边界会脱敏为 `[redacted-path]`。README 限制 19、mechanisms §6.4-25 与 m2-design §7 已记录；`m2-design` §3.1 “view 无绝对路径”应理解为“外部边界”或后续改为“模块保留原文、边界脱敏”。
- **`share.list` latent**：`plugin/m2-management.mjs:315-329` 的 `share.list` 不经过 `projectIdOf`；若未来有 model/host 调用方直接调用额外操作表，可在不传过滤条件时列出所有 relation 的 `decisionBasis`/`permissionRef`。当前模型工具只暴露 `memory_abstracts`/`memory_shared_search`，未发现可达路径，故列为 latent，不计 finding。
- **路径脱敏只覆盖 Windows 盘符/UNC**：产品当前是 Windows 本地路径模型；POSIX 绝对路径未纳入 `ABSOLUTE_PATH`，未做跨平台验证。

## 3. `docs/m2-design.md` §5 验收矩阵（A1–A6）

| 验收 | 状态 | 使用的测试/探针 |
|---|---|---|
| **A1** 两个登记项目 A/B：A 有经验 → A abstract 可被发现；B 不能读 A 明细；用户 grant 后 B 可按查询读 A 明细并带来源/适用性；revoke 后同查询立即 `SHARE_DENIED` | **通过** | `tests/plugin-entry.test.mjs` M2 端到端；`tests/sharing.test.mjs`；`tests/m2-management.test.mjs`；我的 `final-review-probe` #A1/A5：discover 不含明细、grant 前 `SHARE_DENIED`、grant 后 items 带 `sourceRef/sourceVersion/verification='unverified'/applicability`、revoke 后同查询 `SHARE_DENIED` |
| **A2** A 删除被引用记忆 → A abstract 读取立即刷新且不含该条；B 已建立共享的明细不再返回；晚到任务不能复活 | **通过** | `tests/abstracts.test.mjs` 删除/纠正/归档用例；`tests/plugin-entry.test.mjs` 删除后 shared search 为空；我的 `final-review-probe` #A2 验证 revision 前进且 basis/明细均无该 id，`store.put` 同 id 被 tombstone 拒绝 |
| **A3** A 新增/纠正记忆使 abstract 变化：关系保持 active，读取自动使用最新有效 revision（无需重新决策）；`upToDate` 变 true | **通过（含设计内 10 条/24h 合并延迟）** | 自动提取完成 `onJobSettled`、`memory_remember`、`/memory remember` 均标记 dirty（`probe-extraction-dirty`：`dirtyProjects=1`；`probe-plugin-auto-refresh`：0→1→2）；`probe-read-threshold2`：`read=2, dirty=0`；我的 `final-review-probe` #A3 在 dirty 达阈值后 revision 前进、`resolve` 自动跟随、审计字段保持；`tests/sharing.test.mjs:259` 验证 stale 时 `resolve.relation.upToDate=false`。低于阈值时保持 stale 是设计行为，不是不刷新 |
| **A4** A 退休：abstract/记忆仍可管理；applicability=`historical_unknown`；已有共享仍可读但标记 historical；不自动产生新共享 | **通过（组件级；真实 profile 未做写入）** | `tests/abstracts.test.mjs` retired 用例；`tests/sharing.test.mjs` retired source/target 用例；`tests/project-registry.test.mjs` applicability；我的 `final-review-probe` #A4：retire 后 view `projectState=retired`、`applicability=historical_unknown`，已有 resolve 返回 historical 明细，新 grant `PROJECT_RETIRED`，自动 refresh `PROJECT_RETIRED` |
| **A5** 模型/工具不能 grant/revoke/refresh（`USER_ACTION_REQUIRED`）；共享明细不复制成 B 记录；异常/未知项目 fail closed | **通过** | `tests/m2-management.test.mjs`（26 项：用户动作、项目解析、模型 target 越权、脱敏、真实 managers）；`tests/management.test.mjs` 的 M2 用户动作用例；我的 `final-review-probe` #A5/#boundary：M2 table 对 model/host/无 actor 均 `USER_ACTION_REQUIRED`，user 可 refresh；shared resolve 前后 target store 条数不变；未知项目/无 relation/无 abstract/store 异常均 fail closed |
| **A6** catalog v1→v2 迁移幂等、失败回滚、旧数据与 identity 保持；v0.3.0 全量 318 项测试全绿（含 M1 回归） | **通过** | 定向迁移测试 3/3：`migrates additively`、`drift is refused`、`identity mismatch is refused before migration`（identity 不一致时保持 `user_version=1`）；全量 318/318；真实 catalog `user_version=2` 且 M2 表存在。历史 258 基线保留在 `evidence/m1-verification.json`，未在旧提交上重跑 |

## 4. 声明/过度声明检查（TODO M2、README、mechanisms）

| 被检查声明 | 判定 | 依据 |
|---|---|---|
| TODO M2：MEM-201/202/203 已实现，MEM-204 未实现 | **准确** | `TODO.md:3,73,78`；`README.md:5,142`；`docs/mechanisms.md:12,438`；`plugin/capability-events.mjs` 不存在；catalog 仅预留 `capability_*` 表 |
| “abstract 是本地提取式，不是模型语义压缩” | **准确** | `generationRoute='local-extractive-v1'`（`src/abstracts.mjs:29`）；`src/abstracts.mjs`/`src/sharing.mjs` 无 `llm`/`provider`/`ctx` 调用；`README.md:156`、`docs/mechanisms.md:399`、`docs/m2-design.md:138` |
| “未做真实 profile 的 M2 写入旅程” | **准确** | `README.md:138`、`docs/mechanisms.md:397`、`evidence/m2-install-verification.json` limitations #1；live status `abstracts 0/0/0`、`sharing 0/0/0`；真实 catalog 0 abstract、0 share、1 个 retired 项目 |
| “客户端第 4 个 tab 未做浏览器视觉验收、需页面重载” | **准确** | `README.md:138,157`、`docs/mechanisms.md:398`、install evidence limitations #2；本次 client Slots inspect 10s 超时，无法独立复核当前页面 |
| “M3 非 C 盘冷档未实现” | **准确** | `README.md:143`、`TODO.md` M3 全部未勾选；`src/cold-archive.mjs`/`src/storage-layout.mjs` 不存在；live `cold.status='not_configured'` |
| “新增变动按 10 条/24h 合并刷新” | **成立（产品路径）** | 自动提取 `onJobSettled`、`memory_remember`、`/memory remember` 均 `noteChange`；`read` 阈值一致（`probe-read-threshold2`）；直接 `store.put` 的内部/测试路径不标记 dirty，但 README 限制 20、mechanisms §6.4-26、m2-design §7-8 已明确这是调用方合同，不是插件主路径 |
| 测试计数 318/318、M2 17/8/26 | **准确** | 本次全量 318/318；分文件 17/8/26/projects 13/registry 9/plugin-entry 11/scheduler 10；README:131、mechanisms:382/388、TODO:54、m2-design:122 一致；旧 315 已无残留 |
| `m2-verification` 的 `verified:true` 与 artifacts | **成立（生成时；有一条评审文件 artifact 待最后重跑）** | 15:58:35 生成时 318/318、33 artifacts、TAP 匹配、probe 3/3、install materialHashes 10/10 匹配；写作时 32/33，唯一不匹配是本评审文件（N1） |
| “模型不能 grant/revoke/refresh” | **成立（显式动作）** | M2 table 与 management dispatcher 双层拒绝 model/host；HTTP 固定 `actor:'user'`；`abstract.refresh`/`share.grant`/`share.revoke` 均用户动作。细微之处：模型的 `memory_abstracts` 读取可在 basis 失效或 dirty 阈值达到时触发 `read` 的自动重建（不是显式 `abstract.refresh`，内容仅来自本地有效记录，不改变授权）；README 的“不能刷新摘要”应理解为不能发起显式用户刷新 |
| `docs/m2-design.md` §3.1 “view 无绝对路径” | **需按“外部边界”理解** | manager view 可保留原文路径式文本；API/工具边界脱敏。README 限制 19/mechanisms §6.4-25 已记录；建议设计文字改成“模块保留原文，管理 API/工具边界脱敏” |

## 5. 明确未验证边界

1. **真实数据根的 M2 写入旅程未验证**：真实 desktop profile 只有 1 个 retired 项目（`install-verification`）、0 abstract、0 share；按评审约束未创建项目、未写记忆、未 grant/revoke/refresh、未做 shared read。A1–A6 的行为证据来自临时库/FakeHost/真实 manager，不是真实数据根。
2. **客户端视觉与当前 slot 未验证**：`client.js` 语法、locale 字典、静态与渲染冒烟通过，但 `cordis_inspect_query`（client/Slots `settings.section`）本次两次 10s 超时；`m2-install-verification.json` 的 slot active 是 Lead 的更早观测。第 4 个 tab 需页面重载更新 bundle 后才可见；没有浏览器截图或交互验收。
3. **安装态代码代次未完全证明**：live status 为 `state=ready` 且 `cold.detail` 与当前源码字符串一致；install evidence 的 materialHashes 与当前树一致。但没有在真实 profile 做 M2 行为写入，也没有重启后行为复验，无法用行为证明运行进程加载的是最终源码代次。
4. **真实 Provider / OS 出口未验证**：所有 M2 路径为本地确定性逻辑；没有真实 deepseek Provider、费用/质量，也没有 OS 级出口/子进程/DNS/代理证据。
5. **`test-m1-host.mjs` 未重跑**：为不写 `evidence/m1-host-probe.json`，本次只核验其历史 JSON/TAP 哈希与 318 全量回归；真实安装库最终门 3/3 是证据声明，不是本次独立执行。
6. **`share.list` latent**：见 §2.3；当前模型工具不可达，未做现场利用测试。
7. **路径脱敏只覆盖 Windows**：POSIX 绝对路径不在当前 `ABSOLUTE_PATH` 覆盖内；未做跨平台验证。
8. **HTTP 用户动作是 M1 基线本地路由语义**：同源 `POST /dsh-local-memory/api` 固定 `actor:'user'`，没有额外 token/OS 级认证；无 Origin 的本地非浏览器进程可伪造请求。M1 已接受该本地路由模型，M2 未新增认证；不能把它说成“用户身份认证”。
9. **退休项目真实数据**：真实 catalog 的 retired 项目没有 abstract/share，A4 只有组件级证据。
10. **证据与评审文件的先后顺序**：见 N1；发布前需最后重跑 `tools/verify-m2.mjs`，否则 `verified:true` 与 33 个 artifacts 不能同时成立。

## 6. 最终结论

**不阻断 GitHub 发布。** 本次评审 **0 Critical、0 Important**；上一轮 F1–F6 全部在最终树修复并复核；新增 **2 个 Minor**（N1 证据/评审文件顺序、N2 discover 缺 `stale` 提示）与若干已记录限制（共享审计非 append-only、manager 级 view 路径、`share.list` latent、Windows-only 脱敏）。

发布前必须完成的两步（不改变本结论，但不做则证据不自洽）：
1. **冻结本文后最后重跑 `.\runtime\node.exe tools\verify-m2.mjs`**，确认 33 个 artifacts（含本文最终哈希）全部匹配；或把 `docs/m2-independent-review.md` 从 artifacts 排除。重跑后 `evidence/m2-verification.json` 的 SHA256 会变化，应以发布时的新证据为准。
2. 不再修改代码/测试/文档；若必须修改，按同一流程重跑测试与证据。

发布说明中不要声称：真实 profile M2 写入旅程、浏览器视觉/GUI 走查、真实 Provider 质量、OS 级出口、MEM-204/M3/MEM-405 已完成。以上均为明确未验证或未实现边界。

## 7. Lead 发布附录（2026-11-08 16:05，非评审者结论）

本评审编写时 `HEAD` 为 `3dc60e6`、M2 变更尚未提交（见开头快照说明）；评审冻结后，Lead 已将包含本文件与重新生成证据的最终树提交为 `08d9d3f` 并推送远端。按 §6 第 1 步，在本文件冻结后最后重跑了 `.\runtime\node.exe tools\verify-m2.mjs`：318/318、probe 3/3、**33/33 artifacts 匹配、drift 0**，证据重新锚定本文件最终哈希（N1 关闭）。N2（`sharing.discover` 缺 `stale` 提示）保持为已接受的 Minor，本增量不改代码，留待后续增量。除本附录外，评审冻结后未修改任何代码/测试/文档；本附录的写入也已在最后一次证据重跑前完成。
