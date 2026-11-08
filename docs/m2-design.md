# M2 项目摘要（abstract）与跨项目共享 设计合同（v0.3.0 增量）

版本 `MEM-M2-1`，2026-11-08。范围：实现统一待办 **MEM-202（abstract 与共享关系）** 与 **MEM-203（项目退休后的适用性标记/共享保留）** 的 v0.3.0 增量；**MEM-204（能力事件代次消费）仍为下一增量**，本文件只固定其后续接口位置，不在本版声称完成。M2 完成判定仍以 `TODO.md` M2 退出条件为准，本版不整项勾选。

## 1. 产品与边界

- 项目内普通经验（`memories`，**不含**年度工作记录与证明正文）经**本地确定性抽取式二次压缩**形成项目 abstract：引用有效记忆及其版本/来源、适用条件、摘要与生成 route。
- abstract 在本地跨项目可见（同一 DSH profile 内）；**Agent 可发现**其他项目的 abstract，但**建立/撤销共享是用户动作**（管理 API/记忆中心），模型不能授权。
- 用户建立 source→target 共享后，Agent 才能在 target 项目下检索 source 的**明细**；读取时二次核：关系 active、source abstract 仍有效、原 scope/记忆状态、target 许可与来源适用性。明细不复制成 target 项目的新事实，只返回带来源的引用。
- 共享**自动跟随** source 最新有效 abstract revision，不要求每次重新决策；撤权/删除/退休立即生效，不等待摘要刷新。
- 项目退休：保留记忆、abstract 与已授予共享的可读性；源码不可核时 applicability=`historical_unknown`，不得当 current 事实。退休不自动获得新共享。
- 不做：向量检索、跨 Agent MCP、模型提炼 abstract（本地抽取即可满足首版；后续语义压缩属 M3/M4 增强）、远端同步。

## 2. catalog v2（已由 Lead 实现于 `src/projects.mjs`）

`openProjectCatalog` 现在把 v1 库**事务性、校验后**迁移到 v2；新增表：

```sql
abstract_revisions(project_id, revision, digest, payload, created_at, PRIMARY KEY(project_id,revision));
abstract_state(project_id PK, current_revision, dirty_count, first_dirty_at, last_change_at, last_generated_at, generation_route, revision_summary);
share_relations(relation_id PK, source_project_id, target_project_id, state IN('active','revoked'),
  decision_basis, permission_ref, abstract_revision, source_project_revision, created_at, updated_at, revoked_at,
  UNIQUE(source_project_id,target_project_id));
capability_cursors(...); capability_holds(...); capability_events(...); -- MEM-204 预留，本版不写
```

- 所有新模块只通过 `catalog.read(fn)`/`catalog.write(fn)` 访问 catalog（单 writer、同步回调），不得自行打开第二个 `DatabaseSync`。
- 旧库迁移测试：`tests/projects.test.mjs` 的 v1→v2 用例（Lead）。

## 3. 模块与接口

### 3.1 `src/abstracts.mjs`（A 所有）

`createAbstractManager({catalog, registry, now=()=>new Date()})` → frozen API：

- `read({projectId, forceRefresh=false})` → abstract view | `undefined`：
  1. 取 `abstract_state` 与最新 revision；无则 refresh。
  2. 用登记项目的 enabled repo scopes 逐 scope 复核 basis 每条 `store.get(id)` 且 generation/scope/source 匹配；任一失效（删除/纠正/归档/失效）→ **立即 refresh**（删除即时断开）。
  3. 计算当前 revisionSummary（各 scope `store.revision()` 的排序对 digest）；与生成时不同 → `stale=true`；若 `forceRefresh` 或 `dirty_count>=10` 或 `now-first_dirty_at>=24h` → refresh，否则返回带 `stale/dirty` 的旧视图。
  4. 项目必须已登记；retired 项目允许读取（applicability=historical_unknown），但不自动 refresh。
- `refresh({projectId, reason='manual'|'auto'|'coalesced'})` → view：
  - 仅 active 项目允许 auto；retired 仅 manual。
  - 逐 enabled scope：`store.list({limit:200})`，对每条 `store.get` 复核 live，取 `generation` 降序前 60 条作为 basis；summary=text 截断 240 字符；counts 按 kind。
  - payload（canonical JSON）`{schemaVersion:'memory-abstract-v1', projectId, projectName, projectState, revision, generatedAt, generationRoute:'local-extractive-v1', basis:[{id,recordGeneration,kind,sourceRef,sourceVersion,summary}], counts:{memories,byKind}, revisionSummary}`；`digest=fingerprint(payload)`。
  - `catalog.write` 内插入 `abstract_revisions`（revision=previous.current_revision+1）并 upsert `abstract_state`（current_revision、dirty_count=0、first_dirty_at=NULL、last_generated_at、generation_route、revision_summary）。
  - 返回视图（不含绝对路径）。
- `list({includeRetired=false})` → 各项目当前 abstract 视图 + `projectState/applicability`；无 abstract 的项目可返回 `abstractRevision:0/undefined` 条目。
- `noteChange(projectId,{count=1,at})` → dirty_count+1、first_dirty_at 首次设置、last_change_at；供管理 mutation 与未来事件调用（可缺省）。
- `shouldRefresh(projectId,{countThreshold=10,ageMs=86400000})` → bool。
- `status()` → `{projectsWithAbstracts, totalRevisions, dirtyProjects}`。

View 形状（冻结/无绝对路径）：
`{schemaVersion:'memory-abstract-v1', projectId, projectName, projectState, revision, digest, generatedAt, generationRoute, stale, dirtyCount, applicability, counts:{memories,byKind}, basis:[...]}`。

### 3.2 `src/sharing.mjs`（B 所有）

`createSharingManager({catalog, registry, abstracts, now=()=>new Date()})` → frozen API：

- `discover({targetProjectId})` → `[{sourceProjectId, sourceProjectName, sourceProjectState, abstractRevision, abstractDigest, generatedAt, counts, applicability}]`：所有**已登记且 active**的其他项目（排除 target）；另加**已与 target 有 active 关系**的 retired 源（`applicability=historical_unknown`）。abstract 用 `abstracts.read`（保证删除即时反映）。
- `grant({sourceProjectId, targetProjectId, abstractRevision, decisionBasis, permissionRef})`：
  - 二者均已登记、`source!=target`、source 必须 active、target 必须 active；`abstractRevision` 必须等于 source **当前** abstract revision（防止用旧摘要决策）；`decisionBasis`（Agent/用户决策依据，≤2000 chars）与 `permissionRef`（用户许可引用，≤512）必填；`catalog.write` 内 upsert `share_relations`（既有行→active、revision/basis/permission/updated_at；
  - 若关系唯一约束冲突用 `ON CONFLICT(source_project_id,target_project_id) DO UPDATE`）。
  - 返回 relation view。本函数**不含授权判断**：调用方必须已确认用户动作（管理 API 的 `actor:'user'`；模型/工具不得调用）。
- `revoke({relationId})` → relation view（state='revoked'、revoked_at）；不存在返回 `RELATION_NOT_FOUND`；幂等返回当前 revoke 视图。
- `list({targetProjectId,sourceProjectId}={})` → relation views，含 `currentAbstractRevision`、`upToDate`（是否跟随最新）、source/target 项目名与状态。
- `resolve({targetProjectId, sourceProjectId, query, limit=5})` → `{relation, abstractRevision, items}`：
  - 关系必须 active；source abstract 用 `abstracts.read` 取当前 revision（自动跟随）；若 source 无 abstract → `ABSTRACT_UNAVAILABLE`。
  - 通过 registry 取 source 的 enabled scopes → `store.search(query,{limit})`；逐条 `store.get` 复核 live；再核 applicability；返回 items：`{id, recordGeneration, kind, text, sourceRef, sourceVersion, verification:'unverified', projectId:sourceProjectId, repoId, applicability}`。
  - 关系 revoked → `SHARE_DENIED`；target 无权限不得继续；明细不复制、不改变来源 scope。
- `status()` → `{activeRelations, revokedRelations, targets}`。

错误码（`catalog`/模块抛 `Error.code`）：`PROJECT_NOT_FOUND`、`PROJECT_RETIRED`、`INVALID_SHARE`、`ABSTRACT_UNAVAILABLE`、`STALE_ABSTRACT`、`SHARE_DENIED`、`RELATION_NOT_FOUND`。

### 3.3 registry 适用性（Lead 所有，`plugin/project-registry.mjs`）

`applicabilityForScope(scopeRef)` / `applicabilityForProject(projectId)` → `{applicability:'current'|'historical_unknown'|'unavailable', projectState, sourceAvailable, checkedAt}`：

- active 项目且 repo `canonicalRoot` 目录存在 → `current`；
- 项目 retired 或 repo 根不存在/不可读 → `historical_unknown`（有登记仍可读历史记忆/abstract，但不得称 current）；
- scope 未登记/项目不存在 → `unavailable`。
- 仅 lstat/stat + realpath 边界检查；不扫描源码、不读 revision 内容。

### 3.4 管理 API 扩展（C 所有，`plugin/m2-management.mjs`；Lead 负责合并进 index）

`createM2Operations({registry, abstracts, sharing, now})` → plain map，handler 形如 `(input, context) => ({ok:true,value}|{ok:false,error})`：

| operation | input | 说明 |
|---|---|---|
| `abstract.list` | `{projectId?}` | 当前项目的 abstract 视图；缺省用 bound project |
| `abstract.refresh` | `{projectId}` | **用户动作**；`abstracts.refresh`，返回视图 |
| `share.discover` | `{targetProjectId?}` | 发现可共享 abstract（不含明细） |
| `share.list` | `{targetProjectId?,sourceProjectId?}` | 关系清单与 upToDate |
| `share.grant` | `{sourceProjectId,targetProjectId,abstractRevision,decisionBasis,permissionRef}` | **用户动作**；permissionRef 缺省由 entry 生成 `local-user-grant-v1:<uuid>` 并记录 |
| `share.revoke` | `{relationId}` | **用户动作** |
| `shared.search` | `{sourceProjectId,query,limit?}` | 在 active 共享内检索 source 明细（模型可用） |

- `plugin/management.mjs` 的 `USER_ONLY_OPERATIONS` 增加 `abstract.refresh`、`share.grant`、`share.revoke`（Lead 编辑）。
- 响应值不得含绝对路径；`applicability`/warning 字段必须带上。
- 客户端（D 所有，`client.js`）：记忆中心增加第 4 个 tab「项目摘要与共享」：本项目 abstract 查看/手动刷新；可发现的其他项目 abstract 列表；分享建立（选择 source、填写决策依据；permission 由 UI 生成用户手势引用）与撤销；共享明细搜索框与结果（显示来源/未核验/适用性）。全部文案走 locale（`memoryCenter.*` 命名空间），仅使用 `--dsw-alias-*`；HTTP 仍只用 `POST /dsh-local-memory/api`。

### 3.5 工具（Lead）

- `memory_abstracts`：列出当前项目的 abstract 与可发现的其他项目 abstract 摘要（model actor 允许）。
- `memory_shared_search`：`{sourceProjectId,query,limit?}`，在已有 active 共享内检索 source 明细；无共享返回 `SHARE_DENIED`。
- 不新增授权类工具；`share.grant/revoke`、`abstract.refresh` 只能从用户界面/管理 API（actor user）调用。

## 4. 自动维护

- `plugin/index.mjs` 注册一个低频 timer（默认 10 分钟，`config.abstracts.pollMs` 新增，默认 600000，最小 60000）遍历 active 项目调用 `abstracts.read`（内部按阈值自动 refresh），失败只诊断不阻塞。
- 管理 mutation（memory.correct/archive/delete/restore）后调用 `abstracts.noteChange`（通过 management 的可选 `onMemoryChange` 回调，Lead 接线）；即使未接，read 的 basis 校验仍保证删除即时断开。
- 不为此新增模型调用；无网络。

## 5. 验收（v0.3.0 增量）

| 验收 | 观察 |
|---|---|
| MEM-M2-A1 | 两个登记项目 A/B：A 有若干经验 → A abstract 可被发现（摘要/basis/来源），B 不能读 A 明细；用户 grant 后 B 可按查询读 A 明细并带来源/适用性；revoke 后同查询立即 `SHARE_DENIED` |
| MEM-M2-A2 | A 删除一条被引用记忆 → A abstract 读取立即刷新且不含该条；B 已建立共享的明细查询不再返回被删记录；晚到任务不能复活 |
| MEM-M2-A3 | A 新增/纠正记忆使 abstract 变化：关系保持 active，读取自动使用最新有效 revision（无需重新决策）；`upToDate` 变 true |
| MEM-M2-A4 | A 退休：abstract/记忆仍可管理；applicability=`historical_unknown`；已有共享仍可读但标记 historical；不自动产生新共享 |
| MEM-M2-A5 | 模型/工具不能 grant/revoke/refresh（USER_ACTION_REQUIRED）；共享明细不复制成 B 记录；异常/未知项目 fail closed |
| MEM-M2-A6 | catalog v1→v2 迁移幂等、失败回滚、旧数据与 identity 保持；v0.3.0 全量 318 项测试全绿（含 M1 回归） |

测试：`tests/abstracts.test.mjs`、`tests/sharing.test.mjs`、`tests/m2-management.test.mjs`、`tests/project-registry.test.mjs`（applicability）、`tests/plugin-entry.test.mjs`（端到端）；证据写入 `evidence/m2-verification.json`，文档更新 mechanisms/TODO/README。

## 6. 明确后置

- MEM-204 能力事件消费（`plugin/capability-events.mjs`）：catalog 已预留表，接口随后续增量实现；本版不声称。
- 语义压缩 abstract（模型）、冷档（M3）、跨 Agent MCP、向量检索、远端共享：不做。
- 证明正文/年度记录不进入 abstract 与共享。

## 7. 实现状态与实现偏差（v0.3.0，2026-11-08）

**状态**：MEM-202/203 已实现并自测；MEM-204 未实现；catalog v2 已由 `openProjectCatalog` 做显式 v1→v2 迁移（本设计 §2 原先写"Lead 实现"，已完成）。证据：`evidence/m2-verification.json`、`evidence/m2-install-verification.json`、`docs/m2-independent-review.md`。

实现时的明确偏差/补充（均已在 README/mechanisms 记录，不改变硬边界）：

1. **abstract 生成本地抽取式**：`generationRoute='local-extractive-v1'`，取每 scope generation 最新的 60 条 live 记录，摘要为原文 240 字符前缀；不调用模型、不做语义合并。删除/纠正引用记录即时重建；新增变动按 `dirty_count≥10` 或 24h 合并（可手动刷新）。
2. **管理 API 的 `shared.search` 增加可选 `targetProjectId`**：HTTP 路由没有会话绑定，记忆中心必须显式给 target；模型工具仍只从可信会话绑定解析 target。该扩展在 `plugin/m2-management.mjs` 顶部注释与测试中固定。
3. **共享自动跟随只更新 relation 的 `abstract_revision`**：用户决策依据/permission/created_at 仍是审计原值；`list().upToDate` 在下一次 resolve 前或 source abstract 已 stale 时为 false。
4. **发现/读取状态门**：`discover` 要求 target active；`resolve` 允许 retired source（`historical_unknown`）但要求 target active；retired source 不出现 grant 按钮。
5. **客户端共享页只列 target 侧关系**（其他项目→本项目）；source 侧关系当前只在 API/审计视角可查。
6. **无 `src/project-lifecycle.mjs`**：退休/适用性并入 `plugin/project-registry.mjs` 的 `applicabilityForProject/ForScope`，未单独建模块。
7. **未做真实 profile 写入旅程**：安装观测只覆盖 catalog 迁移、状态路由、工具加载与槽位注册；M2 的 grant/revoke/refresh 只在 FakeHost/临时库测试中执行。
8. **dirty 由产品写入路径维护**：自动提炼 commit（scheduler `onJobSettled`）与 `memory_remember` 成功后调用 `noteChange`；`memory.correct/archive/restore/delete` 仍经 management 回调。直接 `store.put` 的内部/测试路径不累计 dirty，但 read 的 basis/revisionSummary 校验仍会返回 stale。
