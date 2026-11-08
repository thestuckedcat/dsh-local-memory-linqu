# 受控跨会话记忆整理软件设计

> **历史技术参考，不能直接执行**：2026-11-08用户要求日常记忆自动管理、仅小bar提示、结论角标与≤100字归因、对话纠正和后台反思。现行体验与增量待办见[MEM-EXP-1](memory-experience-contract.md)。下文手工批次、显式发布、失效后新聊天等默认路径已被取代；自动调度、引用和Host连续性尚待实施适配，旧评审不覆盖新行为。原R2逐字物料保留于[历史副本](history/2026-11-08-manual-memory/memory-consolidation-design-r2.md)，旧摘要/评审对应该副本。

设计编号：**MC-DESIGN-1**。修订：2，2026-11-08。状态：**设计稿；独立首读意见已纳入，待复核；全部新增实现与验收待执行**。

## 1. 基线、来源与边界

本设计基于 `dsh-local-memory-linqu@0.3.0`，本地仓库提交 `d75472f30aea5c7842143497637c4363e2a26d15`。本轮只新增本文及[增量实施计划](superpowers/plans/2026-11-08-memory-consolidation.md)，不修改代码、根状态、原 TODO、实现路线、机制说明或封存证据；不调用模型、不启动真实 Host、不安装、不同步。正式实现前更新 `docs/implementation-route.md` 并说明开工范围，不能把本设计视为已开工或已验收。

已读取根 `AGENTS.md`、`SKILL.md`、`docs/software-design-contract.md`、`docs/design-change-policy.md`、共同开发合同，以及 `C:/Users/admin/.codex/行为守则.md`。这是 K1/F 的工程方案应用；不安排额外学习考核，预测、实验及运行结论仍为待完成。

### 1.1 逐来源采用表

| 来源及固定身份 | 借鉴/复用什么 | 采用方式与限制 |
|---|---|---|
| 当前 05 v0.3.0，提交见上 | authority/内容分离、同步事务、版本与来源检查、批准 Provider 的 prepare/stream 检查、管理入口 | 直接复用本项目代码并增量适配；不是新引入上游源码。原输入、删除、共享合同保持其含义 |
| [Anthropic 研究，2026-11-06](https://www.anthropic.com/research/components-of-agent-memory)，2026-11-08读取 | 即时记录之外，独立任务回看已有材料，核对错误并整理表示 | **只借鉴机制**；本地实现受控批次。论文示例不证明本项目模型质量，不照搬实验规模或收益 |
| [Managed Agents Dreams 文档](https://platform.claude.com/docs/en/managed-agents/dreams)，2026-11-08读取的动态文档 | 输入与候选输出分开，输出可审阅/弃用 | **仅作独立输出机制参考**；不调用其 API，不建立 Anthropic 托管 memory store，不使用其会话资源、认证、预算或生命周期保证 |
| [Claude Code auto-memory 文档](https://code.claude.com/docs/en/memory)，2026-11-08读取的动态文档 | 小索引、明细按需读取 | **只借鉴组织方式**；本项目自己的容量见 §4，不复制 Code 的文件路径、阈值或跨 worktree scope 规则 |
| 本地 `source-lock.json` 的 Host 基线 | Harness `0.2.1-rc.5`，build `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`；Node 24.21.0/26.13.0 | 使用已封存源码形状定义本地适配，未来必须重核实际安装物料；本轮没有运行接缝 |
| 现有 `vendor/kovey/cjk.js`，上游 `73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c`，SHA256 `95d0db52226fa4719d679a4a4cc2ed0de7f232cf8e2e0d304c9d752af2b6c8cb` | 已有中文词法机制 | 沿用既有复用及许可边界；整理首版在有界视图上本地匹配，不新增第三方依赖 |

网页没有本项目固定发布字节或源码锁，故只能标读取时间，不能冒称可复现的部署依赖。“AutoDream”在本文是思路来源名；原生 Claude Code 的灰度/内部触发与托管 Dreams 是不同产品面。没有核实的 CLI 开关、冷却时间、会话数等不作为设计依据，也不声称 Code 提供托管 API 的相同保证。

封存 Host 的工具形状还核对了 `evidence/host-api/dsh-tools/lib/index.js`（manifest SHA256 `1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a`）的 `exec.callId`/`exec.parent`，以及 `dsh-llm/lib/index.js`（`d18d8ae4c8d961e628708c1e4698e09716a0ebb80e55a672e0bde1029bec1155`）的工具结果 `role:'tool'`、`toolCallId`、`source:{kind:'tool',callId}`。这些是静态源码依据，不是新增工具投影已通过 Host 的证明。

### 1.2 真实代码约束，不能只加第四种旧作业

| 当前模块 | 已核行为 | 本增量必须适配的地方 |
|---|---|---|
| `src/jobs.mjs`、`src/provider.mjs` | 3 个 purpose；单来源/会话输入；总输入至多 8000 字符；最多 2048 输出 token；成功清 `job_inputs`；队列无 `cancel()` | 新建整理队列/manifest/授权；旧队列显式保留 3 用途，Provider 才增加受限整理用途 |
| `src/schema.mjs`、`src/store-internals.mjs`、`src/backend.mjs` | content v2、authority v1；精确 schema signature；`write` 是同步 `BEGIN IMMEDIATE`；DELETE journal/FULL；generation() 是 epoch，revision() 是内容修订 | 明确双库升级与 signature 迁移；不可默默接受新表；候选和发布不得混用 epoch/record generation |
| `src/lifecycle.mjs` | 删除/更正/来源事件推进 epoch；旧输入仅清旧 epoch；恢复依赖当前 authority | 对新输入、摘录、候选及所有派生版本增加实质正文清除；仅打 stale 标签不够 |
| `src/abstracts.mjs`、`src/sharing.mjs` | 本地抽取式项目摘要；共享指向原 scope 的活记忆；用户才可 grant/revoke | 不将整理视图混入 abstract basis、`records` 或 share.resolve；不复制/扩张共享授权 |
| `plugin/host-grants.mjs` | 当前消息 receipt、24h 过期、单 purpose 消费；执行 lease 同 signal 重核 | 独立批次授权，不能假冒消息 receipt 或拼出 session/source 来越权 |
| `plugin/project-registry.mjs`、`configuration.mjs` | 具体 repo/worktree/revision/buildVariant 决定 scope；CONFIG_CONFLICT 关闭旧自动行为 | 整理只选一个具体 enabled binding；漂移同样停整理发送/发布；unknown build 不提升适用性 |
| `plugin/scheduler.mjs`、`index.mjs` | 一个 scheduler；scope busy；默认并发1；stop 整体本地 abort，远端未确认 | 一个调度器仲裁两类队列；再加 profile 级持久 dispatch 门，覆盖不同 scope 与所有用途 |
| `plugin/harness-provider.mjs` | prompt 与输入一起计费；批准路由固定；prepare/stream/完成检查；非确认完成保留 unknown | 保持 8000 上界，新增整理 JSON prompt 和精确计量；无 CLI/key/fallback |
| `plugin/management.mjs`、`m2-management.mjs` | extras 必须同步；HTTP 固定 actor=user；catalog.operations 重放会保存返回值 | request 只入队不等待模型；整理写操作绕过通用结果缓存，自己原子记录**无正文**结果 |
| `plugin/final-projection.mjs` | 原投影只接受 id/sourceRef/sourceVersion/generation，以 store.get 校验 | 新建派生/tool-result 投影分支，不能塞入旧 RECORD_FIELDS 后宣称受保护 |

## 2. 产品旅程与稳定需求

用户已允许批准的 DSH 模型 API，其他存储/索引/管理留本地，仅登记可信目标。已有 PF-03b 的普通经验“校验后自动保存并可召回”保持不变。**新增整理的手动批次触发、显式发布是本增量的 rollout 设计默认，不记成用户已确认，也不把旧经验流改成人工逐条审批。** 后续如果改为自动发布，按 §12 局部重核受影响的产品选择。

正常旅程：在记忆中心“整理”页选择项目中的一个 repo/binding → 勾选 2..16 条活记忆 → 可选登记本地摘录 → “生成候选” → 本地来源/预算/授权预检 → 受控模型一次调用 → 严格 JSON 和来源校验 → 显示重复组、未解决冲突、时效提醒、适用性和覆盖清单 → “发布本批次” → 原子产生独立版本 → UI 本地检索及 Agent **手动 native 工具**按需取用、引用原记忆/摘录。原记忆不被覆盖、归档或删除。

“发布本批次”只表示对**所选集合**生成最新整理视图，界面必须显示“覆盖 N 条所选记忆；不是项目全部记忆”。后续发布另一批次会切换该 scope 的最新视图指针，历史有效版本可查；不声称已经合并全项目知识。未选记忆继续走现有召回；遗漏项不等于删除。首版不把派生版本自动加入普通召回，也不把它再当整理输入。

| 需求 | 确定行为/完成标准 |
|---|---|
| MC-001 | 独立跨会话整理队列；同一具体 scope 可包含不同历史 session 的活普通记忆；不需要这些 session 仍活着 |
| MC-002 | 每份输入固定 record generation/body digest、全部来源、binding、epoch、权限和路由；缺失/unknown 不推断允许 |
| MC-003 | 没有原片段就 `memory_only`，可提示聚类/潜在冲突，不能认定原文纠错或证明运行结论 |
| MC-004 | 候选严格 JSON、完整覆盖所选集合、逐陈述来源引用；结构合法不等于语义支持充分；原陈述完整可比较，一律 unverified |
| MC-005 | 候选独立于原记录；发布同步事务、CAS、幂等；任何前置变化拒绝发布而不局部写回 |
| MC-006 | 删除、归档、纠正、来源失效及撤销摘录使用许可传播到输入/候选/已发布版本；清当前正文并阻止备份或晚到结果复活 |
| MC-007 | 与现有 3 用途共享 profile 预算与持久 dispatch 门；超时/崩溃未知不自动重发、不借新队列绕开 |
| MC-008 | UI 看状态/成本/原因/来源/停止/弃用/发布/恢复说明；Agent 可通过受最终投影保护的手动本地工具引用发布结果 |
| MC-009 | 多仓和 CONFIG 保留；不同 build/worktree/revision 不混合；只允许批准 Provider；无其他外发/安装动作 |
| MC-010 | 年度 `work_summaries` 的本人贡献、结果、时间、claim/evidence 引用/确认不可被整理压缩；首增量不读写该 collection |
| MC-011 | 小索引与明细分开；索引仍继承活性与授权；共享 Agent 索引/权限解耦单独后置，现 user-only grant 不放开 |
| MC-012 | 有界、可中断、可恢复；设计与替身、真实 Host、真实 Provider、OS 出口验证分别标记 |

## 3. 架构、模块与信任边界

```text
本地同源 UI(user) ── request/register/revoke/publish/cancel ── 同步管理表
                                                          │
         registry 单具体binding + store当前authority ──────┤
                                                          ▼
  consolidation-inputs ── 固定manifest/本地摘录 ── consolidation-jobs
                                                    │ 唯一scheduler仲裁
                                                    ▼
  profile model-dispatch-control ← 包装所有purpose的受控provider
       │ 持久总预算/dispatch quarantine              │
       │                                             ▼
       └────────── 批准DSH route ─────── prepare/stream模型API
                                                    │ 只回JSON
                                                    ▼
  strict validator → 候选正文(main)/无正文authority → CAS发布 → 派生版本
                                                           │
                     UI本地明细 ← 活性/来源重核 → native手动工具
                                                           │
                                  tool-result投影 → llm/stream最终门
```

新建文件职责固定如下，均为本项目实现，无新 npm 包：

| 文件 | 单一职责 |
|---|---|
| `src/consolidation-schema.mjs` | 新增 schema SQL、内容/authority 版本迁移与 signatures |
| `src/consolidation-inputs.mjs` | 单 scope 输入收集、摘录登记/撤权、manifest/budget 精确序列化与活性重核 |
| `src/consolidation-validation.mjs`、`schemas/consolidation-output.schema.json` | 模型结构、引用、覆盖、上界与语义状态的本地校验；同一权威 schema |
| `src/consolidation-jobs.mjs` | 独立整理队列、一次调用、状态/取消/恢复、候选落库 |
| `src/consolidation-versions.mjs` | 候选读取、发布事务、head CAS、本地搜索/历史读取/弃用 |
| `src/consolidation-lifecycle.mjs` | 来源依赖失效、实质清理、reconcile/restore 门禁；不含网络 |
| `src/model-dispatch-control.mjs` | profile 级持久总预算、唯一 dispatch 门及恢复 journal |
| `plugin/model-dispatch.mjs` | 把原受控 provider 包装成所有用途共用的 broker；捕获同步上下文，不让 caller 伪造 scope |
| `plugin/consolidation-grants.mjs` | user request 的批次许可、同 lease 重核/撤权、恢复凭据；不借用旧 admission receipt |
| `plugin/consolidation-management.mjs` | 同步 extras、actor/scope/CAS/分页/无正文幂等输出 |
| `plugin/consolidation-projection.mjs` | native 工具结果与派生版本投影；最终模型请求前重核 |

需要薄适配的原文件：`src/schema.mjs`、`store-internals.mjs`、`backend.mjs`、`lifecycle.mjs`、`provider.mjs`、`jobs.mjs`；`plugin/configuration.mjs`、`project-registry.mjs`、`host-grants.mjs`（仅恢复联动）、`harness-provider.mjs`、`scheduler.mjs`、`management.mjs`、`final-projection.mjs`、`index.mjs`、`client.js`、`locale/*.json`。`src/projects.mjs` 的 catalog v2 无需新增表；不把派生正文放 catalog。

一个 Host activation 持有 registry、各 scope store、broker、整理 manager 和投影 map。通过原 `OWNER_KEY` 保持单实例。启动顺序：config → registry/catalog → 迁移/核 authority → profile broker恢复 → bridge → 包装 provider → 原/新 grants → 两类 queue → 管理/工具/最终门 → scheduler。卸载先停止入队、撤销 lease/投影，再 abort scheduler/bridge，最多等待1000ms本地结束；仍持有异步调用的资源在 cleanup 到达后关闭。不得先 close store 再由晚到 callback 写入；超时保留 unknown 门，状态页不得宣称远端已停止。

## 4. 输入、配置与适用性

### 4.1 固定 DTO（MC-API-01）

以下类型是本地定义的合同，不是声称 Host 已有同名 API。所有对象 plain、无额外字段；文本经现有 `checkedText`/secret 检查，JSON 规范化使用现有 `canonical`/`fingerprint`（SHA256）。`bodyDigest` 使用 authority 已核 digest；不得拿摘要生成时间代替源版本。

```ts
type SourceIdentity = {sourceRef:string;sourceVersion:string;fragmentRef:string};
type MemoryBasis = {
  ref: string;                 // 本批次 m0..m15，模型只见这个别名
  id: string; recordGeneration: number; bodyDigest: string;
  kind: 'fact'|'lesson'|'preference'|'decision';
  sourceRef: string; sourceVersion: string; fragmentRef: string;
  rootSources: SourceIdentity[];
  sourceAssurance: 'memory_only'; verification: 'unverified';
};
type ExcerptBasis = {
  ref: string;                 // f0..f7
  fragmentId: string; bodyDigest: string; permissionId: string;
  memoryRef: string; sourceRef: string; sourceVersion: string; fragmentRef: string;
  sourceAssurance: 'user_attested_excerpt'; expiresAt: string;
};
type ConsolidationManifest = {
  schemaVersion: 1; jobId: string; scopeRef: string; projectId: string; repoId: string;
  authorityId: string; epoch: number; scopeRevision: number;
  projectRevision: number; bindingRevision: number; bindingDigest: string;
  applicability: 'current'|'historical_unknown';
  buildVerification: 'unknown';
  inputDigest: string;          // fingerprint(完整InputSnapshot)，不是memory id集合的digest
  memories: MemoryBasis[]; excerpts: ExcerptBasis[];
  mode: 'memory_only'|'with_excerpts'; manifestDigest: string;
  baseHeadRevision: number; route: {routeRef:string;provider:string;model:string;routeVersion:string};
  configDigest: string; policyRevision: number; permissionId: string;
};
```

`bindingDigest` 覆盖 projectId/repoId/scopeRef/bindingRevision 及本地 `canonicalRoot/worktreeRoot/revision/buildVariant`；模型只收不透明 digest 与可读 repoId/buildVariant，**不收绝对路径**。内部 manifest 的每个 `MemoryBasis.rootSources` 从 `ledger.entry_sources` 收集全部来源，按sourceRef/sourceVersion/fragmentRef排序后入digest；整个批次去重来源最多64，单项界限同现有sourceIdentity。不能只继承 `records` 第一来源。每条原记忆文本只在 `consolidation_inputs.payload` 中出现；manifest/authority 元数据不存正文。jobId和permissionId先分配，再计算规范input与inputDigest；`manifestDigest=fingerprint(manifest去掉manifestDigest字段)`，其余字段包括permissionId均参与，避免自引用或授权后输入改变。

范围条件：只允许 `memories`，同一次请求所有 id 必须由同一个 `store.get` 活性/完整性校验；禁止候选/派生版本/年度记录/跨 share 输入。2..16 条，不通过重新命名 scope 混合不同 build；`buildVariant='unknown'` 或 `revision='workspace'` 可以整理，但不得把它解释成已验证构建：适用性加 `buildVerification:'unknown'`，结论仍是当前记忆中的陈述。registry 的 `current` 仅说明项目 active 且根可用，不证明源码提交/工具链/实验结果正确。每次检查必须再读catalog当前project.repositories的enabled项核repoId/scopeRef/bindingRevision，不能仅依赖可能保留旧scope的registry缓存。缺失 binding、禁用 repo、退休、CONFIG_CONFLICT 或 `unavailable` 拒绝新请求/发送/发布；已发布历史视图本地 user 可查并标 `historical_unknown`，模型工具不输出历史/unknown applicability 的正文。

### 4.2 原片段的可用与不可用路径（MC-API-02）

当前旧 queue 会清成功输入；`sourceRef/sourceVersion` 只是引用，不保证原文存在。本版**不扫描历史 transcript、不遍历源文件、不从旧模型总结还原原文**。

* 默认 `memory_only`：只把当前活记忆当“先前记下的未验证陈述”。允许重复候选、潜在矛盾及来源/时效不足提醒。任何 `source_correction` 必须有可读摘录支持，否则整份输出 `MC_SOURCE_SUPPORT_REQUIRED`；不静默接受纠错再标完成。
* 用户有原片段时，在本地页选择一条活记忆并粘贴一个摘录，通过 `registerExcerpt({requestId,memoryId,expectedRecordGeneration,sourceVersion,fragmentRef,text})` 形成新 fragmentId。`sourceVersion` 必须等于当前记忆版本，sourceRef 从记忆派生，用户不能指定另一个 scope/任意路径；不得为被 source_blocks 禁止的源登记新 ID。normalized text 的 `digest`、原记忆 generation、全部 rootSources、登记时间、24h expiry 和 user permission 入 ledger。原文若实际无法对应来源，UI 让用户取消；本地只证明“用户明确提供此摘录”，不认证它是 Host transcript 或运行证据。
* `readExcerpt(fragmentId)` 每次核正文 digest、permission active/未过期、同 scope、依赖记忆与 rootSources 全部活着、sourceVersion 未变。新 `request` 需显式列 excerptIds，user request 再产生针对**精确 manifest/route**的批次许可。旧消息 receipt、旧请求许可或过期摘录不能隐式续期；重新登记/授权使用新 ID。删除/屏蔽源不可重新授权复活。
* expiry/撤权后，当前 fragment 正文、包含它的 input/candidate/version 正文在同 scope 清除；其元数据/tombstone 保留。已经送给批准 API 的文本无法从远端撤回，不声称已撤回。
* 真正 Host 原文适配器后置：只有核验 Host 可读取接缝、准入 anchor、事件内容 digest 和来源版本的实现才可新增 `host_fragment` assurance，须单独 schema/验收；本版没有该枚举。摘录只能支持“摘录写了什么”，绝不把 Agent 旧总结升级成测试、贡献或事实认证。

### 4.3 配置默认值

`normalizeConfig` 兼容旧 schemaVersion=1，新增可选 `consolidation` 对象；省略则关闭。未知字段拒绝；以下均为设计默认，不是上游阈值。`routeRefFor` 对新 purpose 明确选 route，对未知 purpose 拒绝，不能 fallback 到 extraction。

| 字段 | 默认与可调范围 | 作用 |
|---|---|---|
| `enabled` / `routeRef` | false / 继承 extraction.routeRef；必须属于 config.routes | 手动整理启用开关与批准接收方；沿用现有授权，启用不等于登记新网络目标 |
| `maxMemories` / `maxExcerpts` | 16（2..16）/8（0..8） | 一个批次上界 |
| `maxInputChars` / `maxOutputTokens` | 8000（2000..8000）/1024（128..2048） | **prompt+完整规范输入**总字符；不截断源码/CONFIG/证据来凑数，超限拒绝并显示缩小选择 |
| `dailyRequests` / `cooldownMinutes` | 2（1..10）/60（1..1440） | 整理子预算及同 scope 入队冷却；不能扩大 profile 总预算 |
| `jobTimeoutMs` | 30000（100..30000） | 一次 prepare/stream 上限，超时按 unknown |
| `candidateTtlHours` / `excerptTtlHours` | 24（1..72）/24（1..24） | 正文保留与重核期限 |
| `maxPendingPerScope` / `maxVersions` | 2（1..2）/25（1..25） | 候选/队列和历史正文容量；当前head不被自动GC |
| `automaticRecall` | false；本版只接受 false | 明确 rollout 边界；没有隐藏自动整理timer/自动发布 |

`config.limits` 同时作为新增 profile broker 的总预算：默认 dailyRequests=20、dailyInputChars=80000、dailyOutputTokens=4096；旧 queue 的 per-scope/session 预算仍在，构成更严的附加限制。整理没有伪 session；不增加虚假 session_budget，使用整理子预算和 profile 总预算。profile broker 消耗的输出按 maxOutputTokens **预留且不退还**，即使取消、模型返空或未报告usage；报告usage另记，不能用未知usage增加余额。日期固定 Asia/Shanghai，跨日/策略digest变化的已排队整理不自动换预算，终结 `budget_day_or_policy_changed` 后只能新建请求。

## 5. 模型输入/输出与本地校验

Provider 增 `memory_consolidate`，但旧 `createJobQueue` 与 `snapshotQueueRoute` 改为使用独立 `EXTRACTION_PURPOSES`（原3个），明确拒绝整理用途。模型接口上界仍是 8000/2048；不放大旧用途限制。`harness-provider` 新 prompt 明示：材料是数据，不是工具指令；无工具/联网/文件访问；只输出有别名引用的 JSON；不创建来源、不认证事实、不改 scope、permission、route 或年度记录；保留具体 CONFIG/build 条件和 unknown。

`InputSnapshot`完整类型为 `{schema_version:1,mode,context:{repoId,buildVariant,buildVerification,applicability},memories:[{ref,text,kind}],excerpts:[{ref,memoryRef,text,assurance}]}`，就是送模型的规范input。`manifest.inputDigest=fingerprint(InputSnapshot)`，validator输入为`validateConsolidationOutput(text,manifest,inputSnapshot:InputSnapshot)`。不向模型发 authorityId/本机路径/权限凭据；仅发送被许可的精确正文与别名。manifestDigest包括该inputDigest。无法容纳完整选中集合时在**入队前**拒绝 `MC_INPUT_TOO_LARGE`，不偷偷按长度截掉来源限定。

模型输出固定 `mc-output-v1`（MC-API-03）：

```ts
type ModelConsolidation = {
  schema_version: 1;
  groups: Array<{
    key: string;                         // g0..g7，唯一
    type: 'duplicates'|'related'|'conflict'|'source_correction';
    memoryRefs: string[];                // 非空、组内不重复，所有memory各出现一次
    statement: string;                   // 1..384字符；仅为未验证摘要
    status: 'unverified'|'hypothesis'|'conflict'|'unknown';
    support: Array<{memoryRef:string;excerptRefs:string[]}>;
    applicability: 'same_scope_only'|'historical_unknown'|'unknown';
    freshness: {status:'unknown'|'review_needed';reason:string}; // reason 1..160
  }>;
  untouched: string[];                   // 未分组原memory，组与untouched构成完整不交叠覆盖
};
```

本地最多8组，总输出字符≤12000、UTF-8≤48000；groups 可空，此时 untouched 必须覆盖全部输入。support 必须精确覆盖该组 memoryRefs；excerptRefs 只能指该 memory 已许可的片段。`duplicates`只允许组内原text经**仅首尾去空白**后逐字相等；含不同CONFIG/数字或不同措辞的组只能作为related/conflict候选，不能自动认证语义重复。validator除manifest还接完整已核InputSnapshot，核其inputDigest与manifest相同，不能拿只有ID的manifest判断text是否相等。

结构校验不能证明模型判断正确或识别全部语义矛盾：related的statement可能错误压缩条件，即使引用覆盖也不代表支持充分。故UI始终完整展示该组原记忆text（不只放可忽略的链接）及CONFIG/build上下文；发布含`semanticValidation:'not_performed'`，不会把statement变成可独立使用的已验证规则。工具get同样同时返回完整原陈述与该statement，超限只返索引不返无条件摘要。`source_correction`只允许每个受纠正memory有摘录，状态只能hypothesis/conflict；这只校验引用存在，不认证摘录支持纠错，发布仍不更正原记录。不能按“最新时间戳”擅自裁决冲突。

prompt禁止编造新时间、实验数字或证明，但本地不声称能从自然语言自动识别一切编造。可执行的拒绝项为verified枚举/显式evidenceProof字段、跨scope额外字段、指令字段、漏覆盖/重用引用/陌生ID、已识别secret-like模式、非法原型和容量超限；均整份拒绝。scope/build不兼容在入队前按身份隔离，同scope中CONFIG条件的语义丢失属于**尚未自动验证的模型质量风险**，由原文对照+显式批次发布暴露，不以带引用掩盖。freshness不能给“已过期”的强结论；没有明确时效证据就是unknown。未知秘密无法仅凭通用正则识别，不能把clean通过当完整DLP证明。

本地 canonical candidate 额外附 `manifestDigest`、全 basis、model route snapshot、generator='memory_consolidate-v1'、`verification:'unverified'`、`semanticValidation:'not_performed'`、`coverage:{selected: N,completeForSelection:true,completeForScope:false}`、warnings。允许的 warning 为 `original_source_unavailable`、`user_excerpt_not_host_proof`、`build_unverified`、`conflict_unresolved`、`freshness_unknown`、`semantic_support_unverified`；最后一项所有非逐字重复组必须有。这些字段由本地计算，模型无权提供。

## 6. SQLite 数据、迁移与备份

### 6.1 版本与精确表合同

内容库 `scope-<digest>.sqlite` 从 **v2→v3**，authority.sqlite 从 **v1→v2**。独立 profile 控制库 `<config.dataRoot>/model-control.sqlite` 初始 **v1**，配套 `model-control.identity.json`；所有路径经现有 checkedPath，固定本地盘，DELETE journal/FULL/secure_delete。catalog 保持 v2。迁移 SQL/签名在 `src/consolidation-schema.mjs`，`schema.mjs` 导出历史签名与当前签名，禁止运行中接受 schema变化。

新增内容表（正文仅在内容库，不写 authority/catalog/audit）：

```sql
CREATE TABLE consolidation_inputs(job_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE consolidation_excerpts(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,text TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE consolidation_bodies(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,
 body_kind TEXT NOT NULL CHECK(body_kind IN('candidate','version')),payload TEXT NOT NULL,digest TEXT NOT NULL);
```

新增 authority 表（以下为完整字段约定；时间 TEXT 用 ISO8601，digest/ID 值校验在代码；SQL中列出的 UNIQUE/PK/CHECK 必须落地）：

```sql
CREATE TABLE consolidation_jobs(
 id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('queued','running','ready','published','discarded','cancelled','failed','stale','outcome_unknown')),
 epoch INTEGER NOT NULL,scope_revision INTEGER NOT NULL,base_head_revision INTEGER NOT NULL,
 manifest_digest TEXT NOT NULL,manifest_json TEXT NOT NULL,route_json TEXT NOT NULL,
 policy_digest TEXT NOT NULL,policy_revision INTEGER NOT NULL,permission_id TEXT NOT NULL,
 budget_day TEXT NOT NULL,input_chars INTEGER NOT NULL,max_tokens INTEGER NOT NULL,
 run_token TEXT,cost_status TEXT NOT NULL CHECK(cost_status IN('not_dispatched','reported','unknown')),
 candidate_id TEXT,reason TEXT,invalidated_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(scope_ref,request_id));
CREATE TABLE consolidation_permissions(
 id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('batch','excerpt','publication')),
 state TEXT NOT NULL CHECK(state IN('active','revoked','expired')),
 subject_id TEXT NOT NULL,subject_digest TEXT NOT NULL,route_digest TEXT,
 epoch INTEGER NOT NULL,policy_revision INTEGER NOT NULL,expires_at TEXT,created_at TEXT NOT NULL,
 CHECK((kind='publication' AND expires_at IS NULL) OR (kind IN('batch','excerpt') AND expires_at IS NOT NULL)));
CREATE TABLE consolidation_dependencies(
 scope_ref TEXT NOT NULL,owner_kind TEXT NOT NULL CHECK(owner_kind IN('job','excerpt','candidate','version')),
 owner_id TEXT NOT NULL,base_kind TEXT NOT NULL CHECK(base_kind IN('memory','excerpt')),
 base_id TEXT NOT NULL,base_generation INTEGER NOT NULL,base_digest TEXT NOT NULL,
 PRIMARY KEY(scope_ref,owner_kind,owner_id,base_kind,base_id));
CREATE INDEX consolidation_dep_base ON consolidation_dependencies(scope_ref,base_kind,base_id);
CREATE TABLE consolidation_head(scope_ref TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),version_id TEXT);
CREATE TABLE consolidation_versions(
 id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,revision INTEGER NOT NULL,candidate_id TEXT NOT NULL UNIQUE,
 digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(scope_ref,revision));
CREATE TABLE consolidation_policy(scope_ref TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=1));
CREATE TABLE consolidation_operations(scope_ref TEXT NOT NULL,request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(scope_ref,request_id));
CREATE TABLE consolidation_audit(seq INTEGER PRIMARY KEY,scope_ref TEXT NOT NULL,operation_id TEXT NOT NULL,
 kind TEXT NOT NULL,object_id TEXT,reason TEXT,occurred_at TEXT NOT NULL);
```

复用 `ledger.entries` 的新 collection 值为 `consolidation_excerpts`、`consolidation_candidates`、`consolidation_versions`，状态仍为原5种；`body_digest` 核正文，generation 为插入时 revision，`entry_sources` 登记**全部根来源**。`consolidation_dependencies` 另绑定原记忆id/版本，弥补单凭 sourceRef 不能传播 archive 的缺口。数据依赖深度固定：memory → excerpt → candidate/version（version还直接绑定memory）；不允许 version 再作为输入，避免无限派生。

profile 控制库：

```sql
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE daily_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL,input_chars INTEGER NOT NULL,output_tokens INTEGER NOT NULL);
CREATE TABLE dispatches(request_id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,owner_kind TEXT NOT NULL,
 fingerprint TEXT NOT NULL,token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN('reserved','in_flight','unknown','settled')),
 cost_status TEXT NOT NULL,budget_day TEXT NOT NULL,policy_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,reason TEXT);
CREATE UNIQUE INDEX one_live_dispatch ON dispatches((1)) WHERE phase IN('reserved','in_flight');
CREATE TABLE recovery_journal(request_id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,confirmation_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('local_released','complete')),created_at TEXT NOT NULL);
CREATE TABLE legacy_budget_imports(authority_id TEXT NOT NULL,day TEXT NOT NULL,
 requests INTEGER NOT NULL,input_chars INTEGER NOT NULL,output_tokens INTEGER NOT NULL,imported_at TEXT NOT NULL,
 PRIMARY KEY(authority_id,day));
PRAGMA user_version=1;
```

没有正文/credential/模型回答进入 control；`fingerprint` 包括 route、用途、输入digest/精确字符与maxTokens。事务先检查任意 reserved/in_flight/**unknown**，有任意一个即阻断新派发；unique index 只是附加保护。整理每日次数/冷却通过本 scope `consolidation_jobs` 的时间、budget_day与状态计数，reserved请求不退款。

### 6.2 升级与兼容

1. 所有 worker/Host写入口停下，验证现有 authority identity、authority v1 signature、content v2 signature 与 owner/scope；未知/修改过 schema 拒绝，不通过删除库“修复”。现有 content v1 显式legacy路径先走原 v1→v2，再迁移。
2. scope 内容连接 attach 该 scope authority 后，在一个 DELETE journal/FULL 的 `BEGIN IMMEDIATE` 内添加两边表并设置版本；提交失败回滚两边，完整性校验失败不启用。只有已核 `OLD_CONTENT_SIGNATURE`/`OLD_AUTHORITY_SIGNATURE`可迁；当前 signature变为v3/v2，`assertAuthority` 同时核新版。原 `initializeAuthority` 的旧version检查先改成识别合法v1/v2，仍验证 anchor，不在身份不明时迁移。迁移使用专用同步事务函数，**在普通write/assertAuthority要求v2之前**执行；不能先调用只认新signature的write再企图迁移旧库。新root直接创建v3/v2，混合已迁/未迁合法库按各自已核signature推进，未知组合拒绝。
3. 本地 catalog v2 不变。独立 control DB 新建必须 file/anchor成对；任一缺失、identity/signature不符则禁所有模型发送，保留可安全读取的本地管理。新建中断的孤立文件不自动丢弃/重建，诊断 `MC_CONTROL_IDENTITY_UNAVAILABLE`。
4. 第一次 broker启用前枚举 registry **全部已登记scope**，检查旧 `ledger.jobs/dispatch_lock` 与新整理作业。旧 running先按原 recoverInterrupted定为unknown；每个旧unknown锁在control导入一个unknown dispatch，记录owner_kind='legacy'。bootstrap还按不同authority identity汇总当日旧ledger.daily_budget的requests/input_chars/output_tokens，单次写入control总预算及legacy_budget_imports，再设metadata.bootstrap_complete；同authority不重复计，若总数已超新总cap当日拒绝发送。旧queued已预留但尚未发的量保守纳入，之后派发再次预留可更严格，不能以升级清零额度。任一扫描失败/超256scope/发现未完成迁移，门状态unavailable，不能假设没有在途调用。bootstrap未完成的重启按imports幂等继续，完成后不重复导入旧计数；后续启动仍重核并导入未settled旧/新unknown锁。已完成旧作业不能重发。未知队列是运行门禁，不是已批准Provider可用的证明。
5. 旧二进制会拒绝v3/v2 schema，故不承诺直接回退运行。停用新功能可继续用新版二进制的旧功能；降级必须使用**同一停机时点**的内容+authority备份和当前删除权威审计，不能把旧正文覆盖到新tombstone之上。

### 6.3 恢复、保留与清理

`exportSnapshot` 新增schema_version=3：旧records/workSummaries语义不变，可选导出**已发布活版本**及其来源引用；不导出job输入、候选、摘录正文或permission。`restoreSnapshot` 接受旧v2与新v3，任何派生版本只有当前authority对应entry仍active、digest/generation一致、全部依赖/许可仍活才可还原；缺摘录不降级恢复旧summary，直接跳过。重建索引/reconcile不从候选或备份推导authority。第一次打开旧content v2备份时先合法迁移再reconcile。

候选/摘录过期清正文，保留tombstone和元数据；历史版本正文只保留最近25份，当前head除外，GC以 `entries.state='stale'` 和reason='retention_expired'记录；不得自动恢复。audit保留最近1000个无正文事件；操作幂等行与删除tombstone不随正文GC删除（避免旧requestId再执行）。版本“不可变”指逻辑身份/修订不变，不阻止隐私清除物理正文。SQLite secure_delete/FTS原门继续；本版派生搜索不建FTS。

备份恢复支持“旧内容 + **当前**权威账本/control”，不支持自动回滚authority/control。无法证明权威是当前副本时停模型发送、派生读取/恢复，标 `authority_freshness_unknown`；同UUID不代表最新。离线旧备份、OS快照及批准API已接收副本不在本地清除保证内。若连同所有账本/anchor一起回滚到一致旧快照，本地不能凭同一快照识别时间倒退；不能宣称已解决这个限制，正式备份流程必须保留不回退的当前权威副本。

## 7. 队列、授权、预算与调度

### 7.1 本地接口（MC-API-04..07）

| 稳定接口ID | 具体模块/合同 |
|---|---|
| MC-API-04 | `createConsolidationInputs`：输入/摘录快照与读时重核 |
| MC-API-05 | `createConsolidationQueue`：持久整理作业、取消和恢复 |
| MC-API-06 | `createConsolidationVersions`：候选读取、发布及版本检索 |
| MC-API-07 | `createConsolidationGrants`：§7.2的batch/execution/publication/revoke接口 |

```ts
createConsolidationInputs(store, {registry, config, now}): {
  registerExcerpt(args): ExcerptRef;
  revokeExcerpt({requestId,fragmentId,expectedPolicyRevision}): MutationRef;
  snapshot({jobId,permissionId,memoryIds,excerptIds,mode,route,baseHeadRevision}): {manifest,input,inputChars};
  assertCurrent(manifest, {phase:'enqueue'|'claim'|'dispatch'|'candidate'|'publish'|'read'}): void;
};
createConsolidationQueue(store, {provider,inputs,grants,config,now}): {
  enqueue({requestId,selection,expectedEpoch,expectedScopeRevision,expectedHeadRevision}): JobRef;
  pending({limit?:number}): JobRef[];
  get(jobId:string): JobRef|undefined;
  list({state?:string,limit?:number,cursor?:string}): JobPage;
  runJob(jobId:string,{timeoutMs,signal}): Promise<JobRef>;
  cancel({requestId,jobId,expectedEpoch}): MutationRef;
  discard({requestId,candidateId,expectedDigest}): MutationRef;
  recoverInterrupted(): number;
  confirmRemoteQuiescence({jobId,status,confirmationRef}): MutationRef;
};
createConsolidationVersions(store,{inputs,grants,config,now}): {
  getCandidate(candidateId:string): CandidateView;
  publish({requestId,candidateId,expectedDigest,expectedEpoch,expectedScopeRevision,expectedHeadRevision}): PublicationRef;
  getVersion(versionId:string,{actor,allowHistorical?:boolean}): VersionView;
  search({query,limit?:number,cursor?:string},{actor}): VersionPage;
};
```

`selection={memoryIds:string[],excerptIds:string[],mode:'memory_only'|'with_excerpts'}`，没有任意 input/scope/route 文本；route/config/manifest由可信deps生成。User管理请求的 scope 来自 projectId+repoId 的当前binding。`JobRef={jobId,state,reason?,candidateId?,candidateDigest?,costStatus,expectedEpoch,expectedScopeRevision,headRevision}`；`ExcerptRef={fragmentId,digest,permissionId,policyRevision,expiresAt,state}`；整理status含`{policyRevision,epoch,scopeRevision,headRevision,dispatchState}`供撤权/CAS读取。MutationRef/PublicationRef只包含ID、state、revision/digest/清理计数、不含正文。`CandidateView`/`VersionView` 是§5规范对象及状态/全basis，读时重核。cursor为 `{revisionDigest,offset}` 的base64url canonical JSON，revisionDigest涵盖当前store.revision/headRevision；limit默认10、1..25，offset0..500；版本变化报 `MC_STALE_CURSOR`，不混页。

enqueue先在同scope事务查`consolidation_operations`的caller requestId与**用户操作payload**指纹（operation kind/selection/显式expected版本/actor，不含新UUID、时钟或当前route）。相同请求返回当前JobRef而不再分配ID、授权或预留；不同payload报冲突。新请求才预分配jobId/permissionId，调用内部snapshot，再authorizeBatch并落job/input/无正文operation结果。`consolidation_jobs.fingerprint`另固定完整manifest/input/route，不能与caller操作指纹混为一谈；动态route变更不会让重放旧操作重新发送。

### 7.2 状态与 lease

允许转换：queued→running/cancelled/stale/failed；running→ready/failed/stale/outcome_unknown；ready→published/discarded/stale；published/discarded/cancelled/failed/stale/outcome_unknown为作业终态。已发布版本的entry状态另遵从active/archived/stale/deleted；unknown永不直接变ready/published/queued。`recoverInterrupted` 将running→outcome_unknown，清输入/候选正文，保留本scope dispatch_lock 与profile unknown；queued必须重新核全部前置才可运行，旧activation授权不可复用。

`createConsolidationGrants({config,registry,now})` 定义：

* `authorizeBatch({store,manifest,requestId,actor:'user'}): PermissionRef`：只有同源/用户手势的管理handler可调用，metadata绑定manifest/route/config/policy revision和24h有效期，写在同scope enqueue事务内。现有 API 授权足够，不再弹一串参数许可；这是具体运行输入的校验与范围固定。
* `authorizeExecution({jobId,scopeRef,manifestDigest,inputDigest,permissionId,route,epoch,phase}): {authorizationVersion,signal}`，phase为claim/dispatch/candidate/publish；同步fail-closed。同一次lease必须是同version/同signal，source/policy/config/route/binding变化或插件撤销abort。发布即使模型已完成也重新核批次permission/expiry。
* `authorizePublication({store,manifest,versionId,versionDigest,permissionId,actor:'user'}): PermissionRef` 在publish同事务创建kind=publication、expires_at=NULL的独立读取许可，subject_id/versionDigest绑定该版本；permissionId先分配并入version payload再算digest。**batch的24h只约束执行/候选/发布前，不限制已发布memory_only版本的长期读取**。发布后读核publication许可和全部根依赖，不再核batch TTL或要求历史执行lease仍活着；重启可从当前authority重读publication许可。模型取用还需当前会话scope/recall/批准route及最终投影。
* 摘录是单独有时效的数据源：其过期/撤权仍清所有依赖该摘录的version正文；publication许可不延长摘录TTL，也不让新的摘录许可复活旧version。memory_only版本在来源有效且未撤销/GC时无固定TTL。局部policyRevision改变使旧执行lease无效，但不自动撤销无关publication；读取看具体publication状态，不能只因revision数字不同把全部长期版本过期。
* `revokeScope(scopeRef,reason)` 推进 `consolidation_policy.revision`、撤销批次/摘录/**publication** permission、abort在途lease；清候选/输入/摘录及其派生版本正文，不删除原记忆。重启后未完成job的旧permission不得自动重建，queued转stale，用户需新request；不需要伪造活session。

用户关闭consolidation、项目退休/配置冲突都停止新工作；关闭开关仅停整理发送/发布，不等于永久删除已发布版本。显式 `consolidation.revoke` 才撤销已有批次/摘录使用并清派生。读权限源于原记忆活性和版本，模型读还需当前recall开关/偏好/已批准route；不能靠关闭后重开开关恢复已撤销对象。

### 7.3 profile共享 dispatch（MC-API-08）

`createModelDispatchControl({root,limits,now})` 提供同步 `reserve(meta): Slot`、`markInFlight(slot)`、`settle(slot,{outcome:'completed'|'not_dispatched'|'unknown',costStatus})`、`recoverInterrupted()`、`importLegacyUnknown(meta)`、`confirmQuiescence(args)`、`status()`、`close()`。Slot含requestId/token/activation，不含正文。`createProfileControlledProvider({inner,control,resolveOwner})` 保持bind/approved/measureInput/execute接口。`resolveOwner(requestId)` 从已登记旧/新queue的当前running row读scope和指纹，禁止 caller 自报scope。

**ID映射固定**：HTTP operationId→enqueue caller requestId→旧`ledger.jobs.request_id`/新`consolidation_jobs.request_id`只做用户操作幂等。Provider的`execute(...,{requestId})`使用**作业实体id，即旧row.id/新row.id（jobId）**；它同时是`dispatches.request_id`、`resolveOwner`参数、旧/新scope dispatch_lock.job_id、legacy unknown导入键和recovery_journal.request_id。不得把旧row.request_id错当provider requestId导入/释放，否则门无法匹配。

broker在实际execute前以事务reserve：核总预算、当天policy、既有requestId fingerprint、任何未settled门；然后durable markInFlight，才进入inner.execute。原3用途与新purpose都走**同一个wrapper**，不能有第二个未包装bridge.provider交给队列。重用同requestId若已settled/unknown也不再次execute；scope不同同ID报冲突。先reserve而未invoke的崩溃仍保守unknown，不借此绕过旧queue恢复规则。

wrapper在调用inner前的所有拒绝（owner/计量/route/预算/控制库身份不可用、reserve事务失败、其他scope门已占用）统一抛 `DispatchPreflightUnavailable extends RouteUnavailable`，附安全reason；它们**确定未发送**，不得被旧jobs的generic catch误记成unknown。reserve失败时不创建本请求unknown row，也不动既有owner门；旧queue直接run被拒的终态failed/costStatus=not_dispatched，新queue已知门占用时保持queued。markInFlight提交成功后调用inner：inner明确证明prepare前RouteUnavailable仍可settle not_dispatched；已确认完成的ProviderResponseError或stop响应→completed（即使本地JSON不合法）；其余throw/abort/timeout→unknown。unknown保留profile门，所有scope/用途停止发送。broker负责远端派发状态，scope queue负责本地候选状态，两者不是跨库原子事务：启动重核若一方running/unknown或broker缺失owner，按更保守unknown收敛；broker已完成而job崩溃不重发，job仍unknown待人工处置。任何scope不能释放另一个scope门。

markInFlight本身失败且inner尚未调用也属于确定未发送；尝试只settle自己已预留的token为not_dispatched。若控制库损坏/COMMIT结果不明使此清理无法确认，scope job仍不得冒称远端unknown，profile控制门保持unavailable/隔离（reason='preflight_control_state_unknown'）并阻止所有发送，等待明确本地恢复；不能删除控制库重置门。故障验收分别断言“inner调用0”与“控制库门未被误放开”。

本地恢复确认沿用“用户声明远端结束/取消已确认”的语义，不声称远端API证实：先释放匹配本scope旧/新queue锁并写profile recovery_journal local_released，再释放匹配token的profile门/记complete。中间崩溃仍保留profile门；幂等续做只释放同一requestId/token，不重跑模型。旧 `task.confirmRemoteQuiescence` 和新整理恢复操作都必须接此协调器，否则不能报告全局released。无scope锁但profile unknown的孤儿也需明确user恢复记录；不自动清除。补充profile预算可能比升级前更严格，UI明确“总预算另有一层；升级当天已计旧预留量”。

### 7.4 调度与停止

修改唯一 `createScheduler` 增可选 `consolidationQueueFor(scopeRef)`、`canDispatch():boolean`；每scope同一busy标记，全局实际模型并发固定1（新启用整理时拒绝config.scheduler.concurrency>1，旧不开整理的配置仍兼容）。tick与每次launch前都核profile门，held/unavailable时不claim任何旧/新job、保持queued，status报阻塞owner/安全reason；不得让轮询消耗一批旧任务的receipt再制造假unknown。旧任务优先，但每完成3个旧任务若有整理候选就调度一个整理任务，避免持续消息使整理饥饿；只运行已入队任务，没有后台扫描/自动生成。profile broker是第二道硬门，即使测试/未来代码绕过scheduler也不能并行或越过unknown。stop同时abort两类queue；新增单job cancel只属于整理，不冒称旧queue已有cancel。

queued取消：同步终态cancelled、清输入，不发送、不退预算。running取消：abort lease；若桥已确认未发送则failed/cancelled说明，未确认远端终止则outcome_unknown、清输入并保留双门。已ready弃用清候选正文；发布后“弃用”是使该版本entry archived并清head指针/推进head revision，不改变原记忆，正文保留至GC；“清除整理版本”则清正文+tombstone。重复取消/弃用同payload返回同结果，改payload报冲突。

## 8. 候选保存、发布CAS与生命周期

### 8.1 候选落库与发布事务（MC-API-09）

runJob不调用`store.put`。模型返回后先严格验证，再在同scope `write(ctx)` 中复核job running/run_token、批次permission、input/manifest digest、epoch/scopeRevision、binding/route/config及全部依赖；生成确定ID `mc-candidate:<jobId>`，写candidate正文、entry/entry_sources/dependencies，作业ready，清consolidation_inputs；同步post-check后提交。任一失败回滚候选写入并终态stale/failed；晚到callback找不到同run_token直接丢弃，不能覆盖终态。**保存候选不advance store.revision**，否则会把自己的scopeRevision快照作废；候选元数据不影响旧memory revision缓存，独立job状态更新即可。

publish按以下次序，在一个同步scope内容+authority事务完成，不调模型/Host异步API：

1. 查 `consolidation_operations`；同requestId+fingerprint返回同PublicationRef，改payload报 `MC_OPERATION_CONFLICT`。返回前仍校验对象当前可用性，已被清除则只返回tombstone元数据，绝不缓存/回放旧正文。
2. 候选必须ready、未过期且正文digest等expectedDigest；epoch与scopeRevision都必须等请求/manifest当前值，headRevision等expectedHeadRevision/baseHeadRevision；binding、route/config、permission、roots逐一重核。并发普通新增记忆也使scopeRevision改变，拒绝并提示重新生成候选，不自动rebase。
3. `versionId='mc-version:'+candidateId`；newRevision=headRevision+1，复制规范payload并附publishedAt/versionId/revision和预分配publicationPermissionId，计算新digest；同事务authorizePublication写无TTL版本读许可，再写正文、entry/根来源与依赖；`UPDATE consolidation_head SET revision=?,version_id=? WHERE scope_ref=? AND revision=?`必须影响1行（首次head在enqueue前初始化revision0）。在同事务将job→published、保存无正文PublicationRef、audit。
4. `advance(ctx)`只推进scope revision、不推进epoch，使已登记普通召回cache失效；同事务发布后核version和全部依赖，才commit。candidate正文删除、entry→superseded，候选ID不复用。缺任何一步回滚；“head已切而body缺失”不能成为可见状态。

没有把模型text直接覆盖原memory、纠正confirmed claim、改共享关系或自动归档“重复”源记录的入口。重复发布同candidate不同operationId返回已有publication metadata（若内容已清除返已失效状态），不能产生第二version。两个candidate竞争同head只有一个CAS成功，另一个`MC_STALE_HEAD`；不得在UI“重试”里隐藏再生成/再发送。

### 8.2 删除/归档/撤权继承（MC-API-10）

`invalidateConsolidation(ctx,{memoryIds,rootSources,excerptIds,reason,mode})` 必须从 `forget/archive/correctMemory/consumeCapabilityEvent` 的原事务内调用；`advance(...lifecycle:true)` 同时把所有旧epoch的整理input/candidate标失效并实质清正文。原源变化再依赖表定位所有历史version、excerpt及candidate，清相关 `consolidation_bodies`、`consolidation_excerpts`、`consolidation_inputs`；entry置deleted（明确清除）或stale（归档/纠正/失效），无正文元数据、source_blocks/tombstone/ops保留。相关head置NULL并revision+1。**归档源的派生正文同样清除**，恢复原记忆不恢复旧派生版本。

running作业保持run_token供结束分类，写invalidated_at并abort同lease；不因清输入而释放dispatch门或冒称未发送。回包即使结构有效也不能写ready；未确认远端结束归outcome_unknown。内存已交给Provider的数据只能尽力停止和释放引用，不能证明远端或OS已抹除。

`reconcileConsolidation`在open/restore/每次读前核authority、body digest、全部依赖和对应permission（候选用batch TTL、版本用publication无TTL+各excerpt TTL）；遇到缺失/非法数据先拒绝正文，再在同步事务清除，不把sourceRef失效解释成“没有这条记忆”。**Version read不比较历史执行epoch/scopeRevision/configDigest/桥activation routeVersion**：普通新增记忆或Host重启不使持久版本过期；执行manifest中的route仅作溯源。读检查原basis具体generation/digest、当前来源/许可及scope适用性；模型工具另外核当前已批准的读取route，而不是要求历史bridge routeVersion复活。读取时的projection.headRevision取当时当前head修订（不是该version出生revision），后续head变化仍按§9.2保守阻断该聊天。输出零正文与具体状态。主库与authority异步外部变化不被支持；assertAuthority发现signature/identity变更整体停止。

## 9. 管理、工具、最终投影与审计

### 9.1 同步管理API（MC-API-11）

沿用 `/dsh-local-memory/api` schemaVersion=1、operationId、固定user actor、同源校验和64KiB body界限。外部输入无scopeRef、route或credential；projectId+repoId解析一个当前binding。所有mutations在handler和dispatcher两层user-only，不向模型注册写工具。

| operation | input（共有projectId、repoId） | 返回 |
|---|---|---|
| `consolidation.request` | memoryIds、excerptIds=[]、mode、expectedEpoch、expectedScopeRevision、expectedHeadRevision | JobRef；只入队，HTTP不等待Provider |
| `consolidation.source.register` | memoryId、expectedRecordGeneration、sourceVersion、fragmentRef、text≤1500字符 | fragmentId/digest/permissionId/expiresAt；总摘录不超过8 |
| `consolidation.source.revoke` | fragmentId、expectedPolicyRevision | 无正文MutationRef |
| `consolidation.list` / `inspect` | state?/limit?/cursor?；inspect另jobId | 分页JobRefs；inspect可含当前可读candidate，由独立读API实时提供 |
| `consolidation.candidate` | candidateId | 实时CandidateView |
| `consolidation.publish` | candidateId、expectedDigest、expectedEpoch、expectedScopeRevision、expectedHeadRevision | 无正文PublicationRef |
| `consolidation.cancel` / `discard` | jobId+expectedEpoch；candidateId+expectedDigest | MutationRef，remoteStopConfirmed=false |
| `consolidation.search` / `get` | query≤2000/limit?/cursor?；get另versionId | VersionPage/VersionView；默认只活版本 |
| `consolidation.version.archive` / `delete` | versionId、expectedDigest、expectedHeadRevision | MutationRef；原memory不变 |
| `consolidation.revoke` | expectedPolicyRevision、reason≤160 | 撤销本scope已有许可并清派生，返回清理计数 |
| `consolidation.confirmRemoteQuiescence` | jobId、status=remote_finished或remote_cancel_confirmed | 本地恢复receipt、originalJobRetried=false、remoteStopVerified=false |

`requestId`由可信handler使用HTTP operationId传给manager；extras上下文扩展**仅内部分发**的operationId（不能从input伪造）。`management.replayOrRecord`对全部 `consolidation.*` 跳过catalog/fallback结果存储；业务幂等由scope authority事务完成。read-only名单增加对应读取操作。错误统一 `MC_INVALID_INPUT / MC_SCOPE_MISMATCH / MC_BINDING_CHANGED / MC_PERMISSION_DENIED / MC_SOURCE_STALE / MC_SOURCE_UNAVAILABLE / MC_SOURCE_SUPPORT_REQUIRED / MC_INPUT_TOO_LARGE / MC_INVALID_MODEL_OUTPUT / MC_STALE_EPOCH / MC_STALE_REVISION / MC_STALE_HEAD / MC_STALE_CURSOR / MC_OPERATION_CONFLICT / MC_BUDGET_EXHAUSTED / MC_DISPATCH_HELD / MC_OUTCOME_UNKNOWN / MC_CONTROL_IDENTITY_UNAVAILABLE / MC_UNAVAILABLE`，脱敏信息不回传本机路径/正文/route秘密。

### 9.2 native手动工具与最终门（MC-API-12）

首版必须含 `memory_consolidation_search({query,limit?:1..3})`、`memory_consolidation_get({versionId})`，仅当前session绑定具体scope、有效已发布版本；**不支持PTC嵌套/exec.parent**，检测到立即返回无正文`MC_UNAVAILABLE`。工具只手动按需调用，不自动塞入普通召回。搜索先返回最多3个本地固定title（例如“相关候选·3条原记忆·语义未验证”，不把model statement截成无条件规则）/group索引、来源ref、versionId；get最多4000字符，**每个返回group必须含完整原陈述及其CONFIG/build上下文、statement和semanticValidation**，否则只返回索引+需缩小groupIds，不输出缺原文的摘要。get可选 `groupIds:string[]`（最多3；缺省全版本在≤4000时返回），未知group拒绝。索引也是派生输出，必须同样投影保护。

若缩到单个group后完整内容仍>4000字符，固定返回`MC_INPUT_TOO_LARGE`及受投影保护的安全索引，恢复动作是“在本地记忆中心查看完整比较”；不再提示无限缩小groupIds，不分段截掉CONFIG/原文，不假设存在分页读取Host接口。普通原记忆读取仍沿既有功能，不把新工具超限转为隐藏自动模型调用。

`plugin/consolidation-projection.mjs` 定义 `recordToolResult({sessionId,callId,toolName,resultDigest,versionRefs,authorizationVersion,bindingDigest})`。versionRefs为 `{scopeRef,versionId,versionDigest,headRevision,groupIds}`，全部根依赖从version manager重读，不能让工具参数自报。tool execute在返回前以本插件固定 `output.render` 生成文本块并记录canonical content digest；工具结果识别以实际Host形状 `role:'tool'` + `toolCallId===source.callId`，对应assistant的tool-call name为上述两名。`exec.callId`缺失或无法关联live session则拒绝输出正文。

最终 `llm/stream` waterfall 组合原投影门与新门，二者都pass/not_ours才next，深冻结请求不改写。新门每次检查历史中自有工具结果：callId/session/result digest、活binding/config/recall偏好/route/grants version，以及版本body digest/entry/所有依赖/publication许可与摘录permission。删除、归档、撤权、head变化或任何unknown均零next并返回现有 `memory_projection_stale`错误。新门读结果不能复制到未登记的“普通工具结果”逃避投影。

重启/投影map被清：扫描请求内assistant tool-call块识别本插件两个工具名，若相应tool结果没有可信projection，一律block；未知message/找不到对应assistant调用但携带本插件结果schema标记 `local-memory-consolidation-result-v1`亦block。不把“map中无记录”当not_ours。PTC聚合无法稳健识别子调用故首版拒绝嵌套；未来要开放需专门聚合投影合同，不能靠prompt。Host最终结果重写或render不一致也block；真实Host必须验证后才能启用这两个工具，失败时UI整理仍可用、工具明确unavailable，不绕过最终门。

无正文拒绝有一个严格例外，避免“工具被拒绝”也把聊天锁住：固定`local-memory-consolidation-refusal-v1` envelope仅含`{schema,ok:false,error:{code,message}}`，code/message必须是本插件有限字面量表、无额外键/引用/索引/派生文本；最终门可按逐字规范内容认证它不携带记忆，无须旧projection即可pass。任何包含索引或动态错误详情的输出不适用此例外；不得给成功或未知旧结果换标签。PTC在读取任何memory前返回这种固定拒绝。

**首版恢复代价必须可见**：目前没有核实能从deep-frozen历史撤回/替换既有tool-result的Host接缝。一个聊天含上述失效结果时，继续发送会持续被门拦住，不能让模型先调用新search来自愈。projection把安全诊断 `{sessionId,reason,recovery:'new_chat_and_query_again'}`交本地状态页；页中提示“此聊天含已失效整理结果，请新建聊天后重新检索；旧聊天保留本地历史”。用户使用现有Host新建聊天入口，在新聊天重新search/get即可继续；不调用猜测的createSession/删除历史API，不自动复制旧含敏感正文历史。这是新增native工具rollout的明确限制，**不是透明恢复或已获用户确认的体验**；用户仅看UI候选/发布时不受此聊天限制。自动修复历史需后置Host能力核验/产品评估。

### 9.3 UI与审计

复用当前记忆中心路由/locale/theme，新增“整理”子页：scope/repo/build badge、范围选择与预算预估、原文不可用提示、摘录登记、作业状态/原因、candidate diff（完整原陈述、整理statement、支持引用和untouched列表）、发布/弃用/停止、版本历史/本地搜索、unknown恢复说明和受阻聊天的新聊天恢复入口说明。ready时无“已验证事实”徽标；历史版本正文清除后只显示来源tombstone与原因，不回显旧卡片缓存。查询/候选展开不触发模型；一次请求一次模型，没有“自动修复JSON”重发。UI polling只读，组件卸载取消poll。

供简洁UI/前后比较原型使用的DTO（由读时重建，不另存正文副本）：`ComparisonRow={groupId,type,statement,status,semanticValidation:'not_performed',warnings,originals:[{memoryId,text,kind,recordGeneration,sourceRef,sourceVersion,buildVariant}],excerptRefs,untouched:boolean}`；`CandidateReview={job:JobRef,candidateId,digest,scopeLabel,coverage,rows:ComparisonRow[],publishPreconditions:{expectedEpoch,expectedScopeRevision,expectedHeadRevision},actions}`。任何原记录已失效则整份review不返旧text，改返无正文stale状态。A/B布局是独立设计产物，本轮不修改client代码。

审计只记录operationId、scopeRef、job/version/permissionRef、route/config digest、状态转换、错误reason、输入字符/预留token/usage计数、时间；无prompt、raw输出、statement、fragment正文、credential或本机绝对路径。`catalog.operations`、诊断数组、console与测试证据同样不能变成隐藏正文副本。

## 10. 本地与出口硬边界

唯一外发是批准DSH route接收本批次规范input+固定prompt。Provider地址/协议/端口/用途沿用已登记可信目标，凭据由Host消费，本文API只持credentialRef的Host内部路径而不接触明文；config.routes的provider/model登记不是任意新URL许可。无Anthropic托管memory/Dreams请求、embedding/rerank远端、网络索引、遥测、下载、更新、shell/CLI、git同步、子进程或浏览器资源。

硬边界由provider wrapper、scope权限、schema校验、最终投影与Host/OS出口策略执行；skill只能调选择建议/说明，不得放宽来源、deleted/unknown、授权、网络或CAS。本地无fetch不等于OS出口已验证：未来负向测试必须覆盖Host provider、重定向/DNS/代理和子进程边界；本轮只读公开文档，未执行这些测试。

## 11. 最小验收矩阵与实施增量

所有下述为**未来预期，待执行**。稳定用例ID对应计划任务；不能用M2 318/318历史记录当本功能通过。

| 验收ID | 需求/触发 | 可观察预期 | 层级 |
|---|---|---|---|
| MC-AT-01 | MC-001/005，同scope两个历史session记忆→生成候选→发布→搜索 | 一次受控调用；原records/年度payload不变；新version带全来源且unverified | 本地合成闭环 |
| MC-AT-02 | MC-002/009，混repo/build/scope、禁用binding、CONFIG_CONFLICT | 入队或发送前拒绝，模型调用0；不升global | 合同 |
| MC-AT-03 | MC-003，旧成功job无输入；model声称源文纠错 | memory_only带警告；无excerpt的source_correction整份拒绝 | 模型输出fixture |
| MC-AT-04 | MC-002/003，摘录篡改digest/过期/撤权/来源version变 | 读/发送/发布拒绝；相关body实际清除；旧ID不可续权复活 | 本地故障 |
| MC-AT-05 | MC-004，漏coverage/陌生ref/跨组重复/已识别secret/verified/指令字段；不同CONFIG的伪duplicates | ready数0、原库不变、无自动重发；不相等原文不能标duplicates；related的语义错误未被自动证明，必须带全原文及语义未验提示 | 结构/质量边界 |
| MC-AT-06 | MC-005，并发新增memory、双候选竞争head、重复发布/异payload重用ID | 分别STALE_REVISION/STALE_HEAD/同ref/OPERATION_CONFLICT；无半发布 | CAS/幂等 |
| MC-AT-07 | MC-006，源delete/archive/correct/event在queued/running/ready/published各点 | 当前新正文/索引/ops缓存无残留；晚到0写；archive恢复不复活旧派生 | 故障/隐私 |
| MC-AT-08 | MC-007，旧提炼/年度与新整理、不同scope直接并发run、reserve预算/gate拒绝 | profile同时最多1派发；共享总预算；scheduler保持queued；直接旧run拒绝为failed/not_dispatched，不污染新unknown | 交叉队列 |
| MC-AT-09 | MC-007，prepare后超时/崩溃；启动有旧unknown/无法枚举scope | 双门unknown，零重发；scope扫描失败则broker不可用；恢复确认不重试 | 崩溃/恢复 |
| MC-AT-10 | MC-005/006，发布每个SQL点抛错；旧内容备份恢复/ledger缺失 | 一致head/body/entry；不复活删除；身份/新旧sig不符保持原库且拒绝 | 迁移/事务 |
| MC-AT-11 | MC-008/011，native手动search/get后删源、改head、history replay、PTC嵌套 | 合成最终门零next；UI明确新聊天恢复；新聊天重查有效版本后可继续dispatch；PTC无正文；真实Host单独待验 | 工具/投影/恢复旅程 |
| MC-AT-12 | MC-009，未批准route/route漂移/fallback尝试/恶意来源prompt | 不发送未知目标；固定route；来源指令不变工具动作；无额外出口 | 静态/负向出口 |
| MC-AT-13 | MC-010/011，共享已撤销；整理后年度与原共享查询 | 不获取跨share输入；user-only grant继续拒绝model；原年度证据/贡献逐字节不变 | 回归 |
| MC-AT-14 | MC-012，queued取消/running停止/卸载/候选过期/重复安装；发布后重启和越过24h | 有界stop，unknown不释放；无遗留timer；memory_only发布仍可读，batch TTL不清长期版本；excerpt expiry只清依赖版本 | 资源/管理 |

增量依赖顺序：I1 schema/依赖与生命周期+离线候选发布闭环 → I2 profile broker+新队列/Provider/grants（仍用fixture）→ I3 UI+native手动投影/真实Host合成合同 → I4批准Provider合成业务与OS出口、独立评审后release。每增量必须有可观察用户行为；不得只搭底座而永久不交入口。详细分派、签名、失败测试和命令见实施计划。

## 12. 局部修订映射、后置与当前未验证

| 变更范围 | 必须联动 |
|---|---|
| MC-001/002/003 输入/片段来源 | inputs DTO/schema、grants、entry_sources/dependencies、迁移、AT-02/03/04/07 |
| MC-004 输出字段/校验 | mc-output版本、validator/prompt、candidate digest、工具render、AT-05/11；不兼容加v2，不改旧输出解释 |
| MC-005/006 发布与删除 | authority/content签名、CAS、reconcile/backup、幂等表、AT-06/07/10 |
| MC-007/009 route/预算/派发 | broker policy digest、旧queue wrapper、grants、scheduler、恢复journal、AT-08/09/12 |
| MC-008/011 自动召回或PTC | 产品边界、session-hooks、最终投影、Host证据与AT-11；不能仅打开配置 |

后置项各自另立需求，不混入首版实现：

* **MC-F01 自动加入普通召回**：扩展 `session-hooks.mjs` 的 recall provider，使原记录Ref与 `ConsolidationVersionRef` 为可区分union；新增`recordDerived`投影，按source.kind匹配派生消息并核head/全部依赖；预算共享现有recall字符/token上界。有效性、旧历史、删除后零dispatch经真实Host验证前automaticRecall仅允许false。自动发布是额外产品取舍，不由F01推导获准。
* **MC-F02 年度记录整理**：独立collection/claim/evidence/时间/贡献保持合同，先设计无损引用和确认继承；本版不选中、不重写、不汇总年度记录，也不猜《年终总结维度.md》评分。
* **MC-F03 共享Agent索引与授权解耦**：索引可见性、detail读取、模型外发与用户grant分别授权；所有跨项目派生必须回查source/target/permission，不能复制到目标后失去撤权链。本版不合并跨share，不给Agent grant能力，不改M2 user-only边界。
* **MC-F04 Host原片段/自动整理/PTC聚合**：各自固定Host实际接缝、隐私保留和投影协议再新增，不根据Code灰度行为实现猜测API。

修订记录：R1（2026-11-08）新增MC-001..012、MC-API-01..12、MC-AT-01..14。R2（同日）响应独立首读MC-R01..04：分离永久publication读权与执行TTL；精确broker预派发错误/调度阻塞/旧ID映射与升级预算；补工具历史新聊天恢复；收窄语义校验保证，固定原文比较与人审边界。另补合法迁移次序和当前enabled binding复核。产品既有决定保留；所有新增默认标设计决定。后续局部微调只改受影响ID/模块/用例；scope/权限/数据/外发或语义变化按根局部修订规则升级，不整份重做、不重写旧证据。

当前只确认上述源码与公开来源已经阅读。未实现任何新模块；未执行新增测试、模型质量评估、迁移实验、真实Host工具最终门、真实API、OS出口或安装验收。本文不是完整交付机制说明，正式实现后以运行证据更新 `docs/mechanisms.md`。

**接下来该怎么做：** 先用约15分钟审阅 MC-AT-07/08/11 与计划任务的对应关系；完成标准是每个“删除后仍持有正文、unknown跨队列、旧工具历史”反例都有确定拒绝/清理位置，再进入实施阶段。
