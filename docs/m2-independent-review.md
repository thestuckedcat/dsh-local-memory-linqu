# 05 本地长期记忆 M2（v0.3.0 增量）最终独立评审

评审日期：2026-11-08（Asia/Shanghai）

评审对象：`E:\dsh\plugin\05-local-memory`，冻结树（frozen tree）v0.3.0（M2 增量：catalog v2、项目 abstract、用户授权跨项目共享、退休适用性、管理 API/模型工具/客户端第 4 tab）。

评审方式：独立只读源码、真实 Node 26 全量回归、临时数据根/FakeHost 探针、真实安装态只读 HTTP/SQLite、真实 catalog 只读查询、证据哈希独立复算；未修改被评审源码/测试/文档，未安装或卸载插件，未提交。本评审只对下表哈希对应的最终快照负责。

> 本评审期间 Lead 对 `docs/mechanisms.md` 做了最后一轮措辞更新，并多次重跑 `tools/verify-m2.mjs`（15:58、16:01、16:03）。下表 `evidence/m2-verification.json` 与 TAP 的哈希是**本评审实际独立复算过的 16:01:49 快照**；之后 Lead 又重封过一次，因此它们不是最终发布证据的哈希。`docs/m2-independent-review.md` 本身也被 `verify-m2.mjs` 列入 artifacts，任何一次本文件写入都会改变该单文件哈希；发布前必须在本文件最终写入后由 Lead 再跑一次 `verify-m2.mjs` 封存（见 §2.2）。

## 1. 快照与范围

### 1.1 实际验证文件的 SHA256（全量）

| 文件 | SHA256 |
|---|---|
| `src/projects.mjs` | `928f7150c29ccf9610deb7876e149b83b2ebe96b96f5b54b830f6ef53b0ab0c4` |
| `src/abstracts.mjs` | `01f979c4cd2057fa0ee2729348978762255ac17ac0b3f4daf01979dce16ab093` |
| `src/sharing.mjs` | `a3fef953995a33adf27682736b54b1a6231c71e36f4c7fc30f74fdf6d6762b91` |
| `plugin/scheduler.mjs` | `b288595558ee0c484452c43ae67daa0c6e9769b8792825f75a1c72bb1b5d7e54` |
| `plugin/index.mjs` | `ae91464dc9322a2a2b834bddf935011fac03811d7f0cdfd37952845fb5a49a47` |
| `plugin/m2-management.mjs` | `03e3df3ea9325aa6aacbd3a46ac81e5d239a37624008c6136989a8d8628603ac` |
| `plugin/project-registry.mjs` | `a01e203360abb476e7394b8fc28e62956dd80b24fe59edf04328b117844276f8` |
| `client.js` | `5afd6dd796a461e2e564f50bd9e51612ec35ac2df20e2e5760ba62ab39dfcb6e` |
| `evidence/m2-verification.json` | `2a45711a555c1d5af7547de070397bf1cce67b5bc422f03693f1828201f59547`（16:01:49 快照；重封后值见 §2.2） |

补充核对的物料：

| 文件 | SHA256 |
|---|---|
| `README.md` | `78f4bdc3ec67a32cc367871d90575f8b3f54f8c43e7b0f674fc5c03184997f93` |
| `TODO.md` | `f0163b6d932cfb6dbccd617e015ce88f039cf3abaa7f8905d8a377d977451aa7` |
| `docs/mechanisms.md` | `fe1cc076d136903bd22b59ee012537b2f9f4ff5761b5efae69c3a9758697d193` |
| `docs/m2-design.md` | `eeac1a2834c5815ad3d969e858c5ac34235431f9609b74cd18bdb7fa706c6580` |
| `evidence/m2-install-verification.json` | `ea49d84f332fd28903c862084ae840a740dc7cb22752e43c444cc0bf61172104` |
| `evidence/m2-node26.tap` | `1ed93ec4f321c868bc9ab1f5f45c35c1d0035c2cde3e1443c42a16e44771c61b`（16:01:49 快照；重封后值见 §2.2） |

范围：`src/projects.mjs`（v1→v2 迁移/identity）、`src/abstracts.mjs`（basis、阈值、退休、适用性、dirty）、`src/sharing.mjs`（授权/撤销/自动跟随/`upToDate`/明细不复制）、`plugin/scheduler.mjs` 的 `onJobSettled`、`plugin/index.mjs` 的接线、`plugin/m2-management.mjs` 的 7 个操作与 actor 边界、`plugin/project-registry.mjs` 的适用性、`client.js` 第 4 tab；以及 `TODO.md`/`README.md`/`docs/mechanisms.md`/`docs/m2-design.md` 的声明。

### 1.2 先前评审 F-01..F-08 的编号沿用

本表按**先前评审文件**的 F-01..F-08 编号复核，不采用评审期间出现的另一份重编号草稿：

- F-01 = 自动 dirty/自动刷新主路径；F-02 = 证据 artifacts 完整性；
- F-03 = 共享审计非 append-only；F-04 = abstract 模块 view 含原文/路径；
- F-05 = 迁移 identity 校验顺序；F-06 = `read` 阈值早返回；
- F-07 = applicability 探测抛异常回退；F-08 = 文档计数/控制字符/措辞漂移。

## 2. 独立验证命令与结果

### 2.1 测试与探针

| # | 命令 | 结果 |
|---|---|---|
| 1 | `.\runtime\node.exe --test tests/*.test.mjs` | **318/318 通过**，fail 0、cancelled 0、skipped 0；duration 7727.7 ms；Node **v26.13.0**；exit 0 |
| 2 | 逐个运行 7 个 M2 测试文件 | **94/94**：abstracts 17/17、sharing 8/8、m2-management 26/26、projects 13/13、project-registry 9/9、plugin-entry 11/11、scheduler 10/10；全部 exit 0 |
| 3 | 9 个定点 `--test-name-pattern` 重跑 | 9/9 通过（scheduler 的 settled dirty；plugin-entry 的 `/memory register` dirty 与 M2 端到端；m2-management 的 model target；abstracts 的阈值与 probe-throw；sharing 的自动跟随与 retired；projects 的 migration identity） |
| 4 | `.\runtime\node.exe scratch-review\probe-auto-dirty.mjs`（FakeHost + 真实 plugin entry，临时数据根） | **5/5**：自动提取后 **229 ms** 时 catalog `dirty_count=1, current_revision=0`（`first_dirty_at` 已写）；1.3 s 后维护/读取消费 dirty：`revision=1, dirty_count=0`；basis 含该提取记录 |
| 5 | `.\runtime\node.exe scratch-review\probe-m2-review.mjs`（真实 catalog v2 + 真实 SQLite store + 真实 manager） | **26/26**：A1 discover/deny/grant/不复制、A2 删除即时断开、A3 阈值刷新+自动跟随+`upToDate`、A4 retired、A5 model 边界、A6 迁移、F-03/F-04/F-05/F-06/F-07 与 N-01 |
| 6 | `.\runtime\node.exe scratch-review\probe-idempotent-dirty.mjs` | **3/3**：重复 `memory_remember` 返回同一 id、store 只有 1 条记录；但 `dirty_count=2`（N-02） |
| 7 | 真实安装态 `POST http://127.0.0.1:8656/dsh-local-memory/api`，`operation=status`，只读 | HTTP 200：`state=ready`、`plugin=dsh-local-memory-linqu`、projects=1、activeProjectCount=0、scopes=1、abstracts `{0,0,0}`、sharing `{0,0,0}`、`cold.status=not_configured` |
| 8 | 真实 catalog 只读查询 `E:/dsh-data/05-local-memory/default/catalog.sqlite` | `user_version=2`；14 张表含 `abstract_revisions/abstract_state/share_relations/capability_*`；1 个项目（`install-verification`，retired）、1 repo、0 abstract、0 revision、0 share；identity 锚 `96bf5dde-…` 与 meta 一致 |
| 9 | Host `cordis_inspect_query` provider=Tool method=listTools | 运行中的工具含 `memory_abstracts`、`memory_shared_search`（schema 可见） |
| 10 | 客户端 `cordis_inspect_query` provider=Slots method=listSubTree root=settings.section | **10 s 超时**（页面未连接）；客户端槽位/视觉本次仍无法独立复核 |
| 11 | `.\runtime\node.exe --check client.js`；locale 键检查 | exit 0；en/zh 各 **312** 个叶子键，双向 0 差异 |
| 12 | 证据独立复算：`m2-verification.json` 的 33 个 artifacts 逐个 SHA256；TAP 摘要；install evidence 的 10 个 materialHashes | **16:01:49 快照：33/33 匹配、0 drift**；`verified:true`、`artifactsStable:true`、suite 318/318、probe 3/3；TAP 哈希 `1ed9…61b` 匹配；10 个 materialHashes **0 不匹配**。本文件写入后该单文件 artifact 会变化，最终以最后一次重跑为准（§2.2） |
| 13 | 文档检查：README/TODO/mechanisms/m2-design/evidence 的控制字符与计数 | 控制字符 **0**；README:131、TODO:54、mechanisms:382/388 均为 318 与 17/8/26；TODO:78 `MEM-204` 仍为 `- [ ]`；无 `315` 旧计数残留 |

### 2.2 证据时点与“重封存”说明

评审期间 Lead 至少三次重封证据（15:58、16:01、16:03）：本评审独立复算的是 **16:01:49 快照**（`2a457…9547`），当时 33 个 artifacts **0 mismatch**、`verified:true`、`artifactsStable:true`、`artifactDrift:[]`、TAP 318/318（`1ed9…c61b`）、probe 3/3。16:03:29 的重封（`0e674…d25b1`）曾包含本文件 16:02:54 版本并同样 33/33，但本段更新又会改变本文件哈希。

**因此**：`docs/m2-independent-review.md` 是 33 个 artifacts 之一，本文件的任何一次写入都会让该单文件哈希变化；这是自引用 artifact 的固有性质，不是 F-02 复发。发布前必须在**本文件最终写入之后**最后执行一次：

```
.\runtime\node.exe tools\verify-m2.mjs
```

并以该次输出为最终证据：预期 `verified:true`、`artifacts:33`、`artifactDrift:[]`、suite 318/318、probe 3/3。不要把 `2a457…` 或 `0e674…` 当作发布证据的最终哈希。若最后一次重跑仍出现除本评审文件之外的 mismatch，则按 F-02 未关闭处理。

## 3. 发现（findings）

严重度：Critical = 数据/安全边界被突破或不可恢复；Important = 核心承诺/验收/证据不成立，发布前必须处理；Minor = 规格偏差、可解释限制或文档/措辞/可用性小缺陷。

| ID | 严重度 | 当前状态 | 位置 | 复核证据（本次实际执行） | 影响/结论 |
|---|---|---|---|---|---|
| **F-01** 自动 dirty/自动刷新主路径 | Important（旧） | **已修复（verified）** | `plugin/scheduler.mjs:52-54`；`plugin/index.mjs:273-281,347-366,423-430`；`plugin/index.mjs:247-253`；`src/abstracts.mjs:320-333,364-397` | 代码路径：`onJobSettled` 在 job 完成时被调用（scheduler:52-54）；index 仅对 `state='completed' && purpose='memory_extract' && result.ids.length>0` 调 `abstracts.noteChange(projectId,{count:ids.length})`（273-281）；`memory_remember`（365）与 `/memory remember`（429）成功后均调 `noteChange`；管理 mutation 经 `onMemoryChange`（247-253）。回归：scheduler 单元测试（`tests/scheduler.test.mjs:173-198`）1/1；plugin-entry 的 `/memory register` dirty 断言（`:146-153`）与 M2 tool remember dirty 断言（`:270-276`）随 M2 用例通过；独立 FakeHost 探针 `probe-auto-dirty.mjs` **5/5**：自动提取后 229 ms `dirty_count=1, current_revision=0`，1.3 s 后 `revision=1, dirty_count=0`，basis 含该记录 | 主路径新增（自动提炼、手动 remember、CLI remember）现在会累计 dirty；10 条/24 h 合并语义与维护 timer 真正对主路径生效。旧“abstract 永远 stale / `upToDate` 假 true”的 Important 关闭 |
| **F-02** 证据 artifacts 完整性 | Important（旧） | **已修复（verified）；待发布前重封存** | `tools/verify-m2.mjs:47-52`；`evidence/m2-verification.json` | 本评审独立复算的 16:01:49 快照 33/33 匹配、`artifactDrift:[]`、`artifactsStable:true`；TAP 318/318 哈希匹配；probe 3/3；install evidence 的 10 个 materialHashes 0 不匹配。`verify-m2.mjs` 现在把 `artifactDrift` 非空即 `verified:false`。本文件写入会改变自己在 artifacts 中的哈希，最终以最后一次重跑为准（§2.2） | 旧 F-02 的两个 mismatch（README、install evidence）已消失；只要最后一次重跑为 33/33 与 0 drift，即完成封存 |
| **F-03** 共享审计非 append-only | Minor（旧，已接受） | **accepted Minor（文档化限制）** | `src/sharing.mjs:218-229`；`README.md:159`；`docs/mechanisms.md:427`；`docs/m2-design.md:140` | `probe-m2-review.mjs`：revoke 后再 grant，`relationId`/`created_at` 保留，`revokedAt` 被清为 `undefined`，`decisionBasis` 变为第二次 grant 值；旧 decision/permission 不保留。README 第 18 条与 mechanisms §6.4-24 已明确“只保留当前状态、重授权覆盖 basis/permission 并清空 revoked_at” | 本地单用户、用户主动重授权场景影响有限；作为审计口径限制接受，不阻断发布。若要审计历史需新增 append-only 事件表 |
| **F-04** abstract 模块 view 含原文/路径 | Minor（旧，已接受） | **accepted Minor（文档化限制）** | `src/abstracts.mjs:208-231`；`plugin/m2-management.mjs:130-163`；`README.md:160`；`docs/mechanisms.md:399,428` | `probe-m2-review.mjs`：写入 `C:\review-secret\…` 的 text 后，`abstracts.refresh` 的模块 view basis.summary 原样含 `C:\review-secret`；同一数据经 `abstract.list`（actor user）返回时被 `sanitizeValue` 脱敏为 `[redacted-path]`，响应不含 `review-secret` | 直接使用 manager 的内部调用者可见原文；模型/UI 边界已脱敏，无模型泄漏。合同“view 无绝对路径”按“外部边界”解释已在 README/mechanisms 记录；接受为 Minor |
| **F-05** 迁移 identity 校验顺序 | Minor（旧） | **已修复（verified）** | `src/projects.mjs:227-239`；`tests/projects.test.mjs:228-238` | 代码：`readIdentity(anchor)` 与 meta identity 比较（227-231）前置于 `PRAGMA user_version` 分支与 v1→v2 DDL（232-239）。测试：identity mismatch 在迁移前拒绝；独立探针构造 v1 catalog + 不匹配 anchor：抛 `CATALOG_IDENTITY_MISMATCH`，随后只读 `PRAGMA user_version=1` 且无 `abstract_revisions` 表（`probe-m2-review.mjs` 通过） | identity 不一致不再推进 schema；旧 F-05 的“失败打开已把 catalog 推到 v2”关闭 |
| **F-06** `read` 阈值早返回 | Minor（旧） | **已修复（verified）** | `src/abstracts.mjs:321-327`；`tests/abstracts.test.mjs:321-334,336-353` | 代码：`live && !changed` 分支内仍检查 `active && needsRefresh(...)`，满足即 `refreshProject`（321-327）；`tests/abstracts.test.mjs:321-334` 的 noteChange-only 10 次后 `read.revision=first+1, dirtyCount=0` 随全量通过。独立探针：只 `noteChange`、store 无变化，`shouldRefresh=true` 时 `read` 新 revision +1、dirty 归零，basis 与刷新前一致 | `read` 与 `shouldRefresh` 对阈值语义一致；旧 F-06 关闭 |
| **F-07** applicability 探测抛异常回退 | Minor（旧） | **已修复（verified）** | `src/abstracts.mjs:101-111`；`src/sharing.mjs:98-109`；`tests/abstracts.test.mjs:507-518` | 代码：两处 probe 抛异常均返回 `'unavailable'`，不再把 active 推断为 `current`。`tests/abstracts.test.mjs:507-518` 随全量通过。独立探针：`applicabilityForProject/ForScope` 均抛错时，`sharing.resolve` 的 items 全部 `applicability='unavailable'`（`probe-m2-review.mjs` F-07 通过） | 探测失败不会伪装 current；旧 F-07 关闭。共享侧没有专门单测，但本次独立探针覆盖了该路径 |
| **F-08** 文档计数/控制字符/措辞漂移 | Minor（旧） | **open Minor（仅余措辞）** | `docs/mechanisms.md:393,491`；对照 `README.md:131`、`TODO.md:54,105`、`docs/mechanisms.md:265-266,382,388,505` | 已修：README:131 为 318/318 且 abstract 17、sharing 8、m2-management 26；README 控制字符 0；TODO:105 改为“M2 剩余 MEM-204 与 M3”；mechanisms:265 已为 17 项；mechanisms:266 已写“read 与 shouldRefresh 一致”；mechanisms:505 改为“最终结论见评审文件与最新证据”。残留：mechanisms:393 与 :491 仍写“三标签布局/三标签切换”，当前客户端为四标签（README/mechanisms:258,436 已写四标签） | 只是文档措辞不一致，不影响代码/证据/验收；建议打 tag 前改成“四标签”。不构成发布阻断 |

### 3.1 新发现（本次独立复现）

| ID | 严重度 | 位置 | 复现命令与结果 | 影响 | 建议 |
|---|---|---|---|---|---|
| **N-01** `discover` 缺少按 source 的故障隔离 | Minor（可用性，fail-closed） | `src/sharing.mjs:93-97,171-185`；对照 `src/abstracts.mjs:349-355` 的 per-project catch | `probe-m2-review.mjs` N-01：让 alpha 的 `storeFor` 抛错后，`sharing.discover({targetProjectId: gamma})` 直接抛出；同一 registry 下 `abstracts.list()` 仍返回 alpha/beta/gamma 三个项目（alpha 标 stale）。输出含 `discoveryError` 与 `listProjects` | 一个项目的 store/abstract 不可读会让模型 `memory_abstracts` 的 discover 整体失败，其他健康项目的 abstract 无法被发现。行为仍是 fail-closed，不泄漏/不越权 | 对单个 source 的 `readAbstract` 加 try/catch，跳过并标记 `unavailable`/诊断，而不是中止整个发现；或明确文档化“一个损坏 source 使 discover 整体不可用” |
| **N-02** 幂等重复 `memory_remember` 仍累计 dirty | Minor（阈值噪声） | `plugin/index.mjs:347-366`（`store.put` 后无条件 `noteChange`） | `probe-idempotent-dirty.mjs` **3/3**：同一 text 调用两次，两次返回同一 record id、store 仅 1 条记录，但 catalog `abstract_state.dirty_count=2` | 数据写入是幂等的，dirty 计数不是；重复 remember 10 次可无变化地触发一次 abstract 重建，浪费本地计算但不影响正确性/权限 | `noteChange` 仅在 `store.put` 实际新建/推进 generation 时调用（比较返回记录 generation 或仅首次写入）；或在文档中明确 dirty 计数按调用次数而非记录变化计数 |

**结论：0 Critical、0 Important；旧 F-01/F-02/F-05/F-06/F-07 已验证修复；F-03/F-04 为已文档化并接受的 Minor；F-08 余 1 处措辞；新增 N-01、N-02 两个 Minor。**

## 4. `docs/m2-design.md` §5 验收矩阵

| 验收 | 状态 | 证据/说明 |
|---|---|---|
| **MEM-M2-A1** 两个登记项目 A/B：A 有经验 → A abstract 可被发现；B 不能读 A 明细；用户 grant 后 B 可按查询读明细并带来源/适用性；revoke 后同查询立即 `SHARE_DENIED` | **通过** | `probe-m2-review.mjs`：discover 含 A 的 revision/digest/counts 且不含明细；grant 前 `SHARE_DENIED`；user grant 后 resolve 返回 `sourceRef/sourceVersion/verification='unverified'/projectId/applicability='current'`，target store 记录数不变（不复制）；revoke 后同查询 `SHARE_DENIED`。`tests/plugin-entry.test.mjs:246-321` M2 端到端与 `tests/sharing.test.mjs` 同步通过 |
| **MEM-M2-A2** A 删除被引用记忆 → abstract 立即刷新且不含该条；B 已建立共享的明细不再返回；晚到任务不能复活 | **通过** | `probe-m2-review.mjs`：删除前 abstract revision=r，`store.forget('alpha-1')` 后 `abstracts.read` 立即 revision>r 且 basis 不含该条；`sharing.resolve` 不再返回该条；`tests/plugin-entry.test.mjs:307-314` 删除后 shared search 为空。旧 revision 只追加不覆盖；store 的 tombstone/删除权威由 M1 回归覆盖 |
| **MEM-M2-A3** A 新增/纠正记忆使 abstract 变化：关系保持 active，读取自动使用最新有效 revision，`upToDate` 变 true | **通过（按 10 条/24 h 合并语义）** | `probe-m2-review.mjs`：新增后 source abstract 未刷新时 `list.upToDate=false`；`noteChange` 达阈值后 `read` 生成新 revision、`dirtyCount=0`；`resolve` 自动跟随并记录新 revision，`relation.state='active'`、audit 字段不变、`upToDate=true`。独立 FakeHost 探针证明自动提取与两种手动 remember 都会累计 dirty。注意：单条新增在阈值前按设计保持 stale 且 `upToDate=false`，不是立即重建；这与 mechanisms/README 的合并刷新说明一致 |
| **MEM-M2-A4** A 退休：abstract/记忆仍可管理；applicability=`historical_unknown`；已有共享仍可读但标记 historical；不自动产生新共享 | **通过（组件级）** | `probe-m2-review.mjs`：retire 后 `abstracts.read` 仍可读、`projectState='retired'`、`applicability='historical_unknown'`；已有 relation 的 resolve 返回明细且 items 标 historical；对 retired source 的新 grant 抛 `PROJECT_RETIRED`。`tests/abstracts.test.mjs` retired 用例、`tests/sharing.test.mjs:323-356` 通过。真实 profile 未做退休项目的写入/管理操作 |
| **MEM-M2-A5** 模型/工具不能 grant/revoke/refresh（`USER_ACTION_REQUIRED`）；共享明细不复制成 B 记录；异常/未知项目 fail closed | **通过** | `probe-m2-review.mjs`：`abstract.refresh`、`share.grant` 的 model context 均 `USER_ACTION_REQUIRED`；model 显式命名非绑定 project 也 `USER_ACTION_REQUIRED`；resolve 不写 target store；未知项目/无 relation/无 abstract/store 错误均 fail closed。`tests/m2-management.test.mjs` 26/26、`tests/plugin-entry.test.mjs` M2 用例通过；HTTP 路由固定 `actor:'user'` |
| **MEM-M2-A6** catalog v1→v2 迁移幂等、失败回滚、旧数据与 identity 保持；v0.3.0 全量 318 项测试全绿（含 M1 回归） | **通过** | `probe-m2-review.mjs`：v1 迁移到 v2 保留 identity/旧项目，关闭后重开成功；`tests/projects.test.mjs` 的漂移拒绝、DDL 失败回滚、identity 先行拒绝用例通过；全量 **318/318**。真实 catalog `user_version=2` 且 M2 表存在。历史 258 项基线保留在 `evidence/m1-verification.json`，未在旧提交上重跑（见 §6 边界 10） |

## 5. 过度声明检查（TODO/README/mechanisms 对照代码）

| 被检查声明 | 判定 | 说明 |
|---|---|---|
| MEM-201/202/203 已实现，MEM-204 未实现 | **一致（通过）** | `TODO.md:3,73,78`；`README.md:5`；`mechanisms.md:12,435,441` 都明确 MEM-201/202/203 已交付、`MEM-204` 未接线；`TODO.md:78` 仍为 `- [ ]`；代码中无 `plugin/capability-events.mjs`，catalog 仅预留 `capability_*` 表 |
| abstract 是本地抽取式，不是模型语义压缩 | **一致（通过）** | `src/abstracts.mjs:29` 固定 `generationRoute='local-extractive-v1'`；`README.md:156`、`TODO.md:49,76`、`mechanisms.md:265,399`、`m2-design.md:138` 均写“原文前缀/不做跨记录语义合并、不调模型” |
| 没有真实 profile 的 M2 写入旅程 | **一致（通过）** | `README.md:138`、`TODO.md:54`、`mechanisms.md:397`、`m2-install-verification.json` 的 limitations 均承认未在真实数据根执行 grant/revoke/refresh/共享检索；本次真实 catalog 只有 1 个 retired 项目、0 abstract、0 share，与该声明一致 |
| 客户端第 4 tab 视觉未验证 | **一致（通过）** | `README.md:157`、`mechanisms.md:398`、install evidence limitations 明确未做截图/交互验收；本次 Slots inspect 仍 10 s 超时，不能补证 |
| 318/318 与 17/8/26 计数 | **一致（通过）** | README:131、TODO:54、mechanisms:382/388 均写 318 与 abstract 17/sharing 8/m2-management 26；实测全量与逐文件计数一致；文档无旧 `315` 残留、控制字符 0 |
| TODO:105“共享与冷档（对应 M2/M3 未实现）” | **已修正（通过）** | 当前为“M2 剩余（MEM-204）与冷档（M3 未实现）”，不再与已交付 M2 共享矛盾 |
| mechanisms:505“M2 独立评审发现的阈值/绑定/适用性问题已修复” | **成立（通过）** | 本评审确认阈值、模型 target、多仓/探测适用性均已在最终树修复；最终结论以本文件为准 |
| mechanisms:393/491“三标签” | **轻微文档漂移（Minor）** | 产品为四标签（README:157、mechanisms:258,436）；仅这两处仍是“三标签”措辞，不影响行为/证据，列入 F-08 残余 |

## 6. 明确未验证边界

1. **真实数据根的 M2 写入旅程未验证**：真实 desktop profile 只有 1 个 retired 项目（`install-verification`），0 abstract、0 share；按评审约束未在真实根创建项目、写记忆、grant/revoke/refresh 或做 shared read。A1–A6 的行为证据来自临时数据根/FakeHost/真实 manager，不是真实 profile。
2. **客户端视觉与实时 slot 未验证**：`client.js` 仅通过语法、locale（en/zh 各 312 键）与静态检查；`cordis_inspect_query`（client/Slots `settings.section`）本次仍 10 s 超时；install evidence 的 slot active 是更早观测，不能替代当前浏览器视觉/交互验收。第 4 tab 需页面重载更新 bundle 后才可见。
3. **运行进程的代码代次未用行为证明**：live `status` 为 ready，Host 工具列表含 `memory_abstracts`/`memory_shared_search`，install evidence 的 materialHashes 与当前树一致；但未在真实 profile 执行 M2 写入，无法用 M2 行为证明运行进程加载的正是最终源码模块，需重启/重载后复核。
4. **真实 Provider / OS 出口未验证**：所有 M2 路径是本地确定性逻辑；没有真实 deepseek Provider、真实费用/质量、OS 级出口/子进程/DNS/代理证据。
5. **HTTP 用户动作边界是 M1 基线语义**：同源 `POST /dsh-local-memory/api` 固定 `actor:'user'`，没有额外 token/OS 级认证；本地非浏览器进程可伪造无 Origin 请求。本评审未做该威胁的现场测试；M1 已接受该本地路由模型，M2 未新增认证，不应在发布说明中称为“用户身份认证”。
6. **latent（当前工具不可达）**：`plugin/m2-management.mjs:315-329` 的 `share.list` 不经过 `projectIdOf`，若未来有 model/host 调用方直接调用额外操作表，可在不传过滤条件时列出所有 relation 的 `decisionBasis/permissionRef`。当前模型工具只暴露 `memory_abstracts`/`memory_shared_search`，未发现可达路径，故仍列为 latent，不计入本次 findings。
7. **路径脱敏只覆盖 Windows 盘符/UNC**：`m2-management`/`management` 的 `ABSOLUTE_PATH` 不覆盖 POSIX 绝对路径；产品当前是 Windows 本地路径模型，未做跨平台验证。
8. **真实安装库最终门 3/3 未由本评审独立执行**：为不写 `evidence/m1-host-probe.json`（评审约束），本次只复核其 `verified:true`、3/3 summary、TAP 哈希和 318 全量回归；3/3 是 Lead 证据声明，不是本评审现场执行。
9. **证据自引用重封存**：本文件是 33 个 artifacts 之一；写入后其哈希会变化，发布前必须重跑 `verify-m2.mjs`。这是流程边界，不是代码/行为缺陷。
10. **M1 历史 258 项基线未在旧提交上重跑**：`evidence/m1-verification.json` 保留 v0.2.0 的历史基线；本次 318 全量包含扩展后的 M1 用例，不等于在 258 项旧提交上复跑。

## 7. 最终结论

**不阻断**（GitHub 发布 v0.3.0）。

- **0 Critical、0 Important**。
- 先前 F-01/F-02/F-05/F-06/F-07 **已验证修复**；F-03/F-04 为**已文档化并接受的 Minor**；F-08 **仅余 1 处“三标签”措辞**；新增 **N-01/N-02 两个 Minor**。合计 5 个 Minor，均不触及数据、安全、权限或核心验收。
- 代码/测试/证据在最终快照上自洽：318/318、7 个 M2 文件 94/94、迁移与 identity、真实 catalog v2、模型/用户边界、自动 dirty 主路径、阈值一致性、适用性 fail-closed 均复核通过；未发现 MEM-204/冷档/模型语义压缩/真实 profile M2 写入/客户端视觉的过度声明。

发布前必须完成（流程项，不是阻塞缺陷）：

1. 在写入本评审文件后由 Lead 运行 `.\runtime\node.exe tools\verify-m2.mjs`，确认 `verified:true`、`artifacts:33`、`artifactDrift:[]`，并保留新的证据文件哈希。
2. 建议同时修正 `docs/mechanisms.md:393,491` 的“三标签”为“四标签”（F-08 残余）；N-01/N-02 可修复，也可作为已知 Minor 记录到 README/mechanisms 的限制中。修复 N-01/N-02 后需重跑对应探针并重封证据。

以上 Minor 不构成 GitHub 发布阻断；但真实 Provider、真实 profile 的 M2 写入旅程、浏览器视觉和 OS 级出口仍是明确未验证边界，发布说明不应声称这些已完成。
