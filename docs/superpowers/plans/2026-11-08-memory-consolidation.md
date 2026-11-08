# 受控跨会话记忆整理 Implementation Plan

> **已封存，不直接执行以下55步**：用户最新体验以[MEM-EXP-1](../../memory-experience-contract.md)的EXP-T1至T6为准。这里手工选批次、显式发布和新聊天恢复路径已被取代。权限/迁移/删除等技术约束可参考，自动队列、引用归因和Host连续性需按新合同重新拆实施任务。旧逐字计划保留于[历史副本](../../history/2026-11-08-manual-memory/memory-consolidation-plan-r2.md)。下方指令仅为历史计划内容，不表示当前开工授权或现行任务顺序。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从同一具体scope的获准普通记忆生成可审阅、有来源的候选，发布独立派生版本，并通过本地UI与受最终投影保护的native手动工具取用。

**Architecture:** 新建独立manifest/整理队列/候选版本，不改写原memory或年度记录。复用原scope authority同步事务、批准Provider和唯一scheduler，增加所有用途共用的profile持久预算/dispatch门；删除继承覆盖所有新正文。首版手动触发和显式发布，普通经验旧自动流不变。

**Tech Stack:** ESM JavaScript、Node内置`node:sqlite`、`node:test`、当前Cordis/DSH接缝；不新增npm依赖。

**Spec:** [MC-DESIGN-1](../../memory-consolidation-design.md)，修订2；执行者必须先读设计及本计划。基线 v0.3.0 / `d75472f30aea5c7842143497637c4363e2a26d15`。

## Global Constraints

* 本轮只设计；本计划所有代码、命令、测试、提交与安装步骤均**待执行**，没有PASS证据。实施须获得相应阶段范围，不在本轮执行。
* 只选同一具体scope的2..16条活`memories`，摘录0..8条；不读写`work_summaries`，不跨repo/build/worktree/share，不提高事实可信度。
* prompt+规范输入总字符≤8000；默认1024、最大2048输出token；候选24h、摘录24h，默认整理2次/日；profile总预算取config.limits。
* content v2→v3、authority v1→v2；catalog保持v2；新增profile `model-control.sqlite` v1与identity anchor，精确signature/owner/identity验证。
* 新purpose `memory_consolidate`仅进入新队列；旧queue显式只支持原3purpose；所有用途共用同一个包装provider，unknown不重发/不越门。
* 手动trigger/显式publish为本增量设计默认，非新增用户产品确认；旧PF-03b自动经验流不变；automaticRecall只接受false。
* 仅批准DSH模型API可接收精确选中input；其他数据/索引/管理本地；禁止Anthropic托管memory/Dreams、CLI/key fallback、额外网络或同步。
* 当前真实Host及OS出口未在本轮验证；源码接缝、替身、真实Host、真实Provider分别记证据，不复用旧M2成功数冒充新通过。
* 本轮不commit/push、不改旧封存件；正式实施任务中的commit是小步检查点建议，须按当时权限执行，不能现在执行。

## Review Focus

* 旧job成功后原fragment已清：memory_only仍可聚类，但无excerpt的source_correction必须整份拒绝（Task 2/3）。
* 删除/归档/撤权发生在candidate或历史version已写后：当前所有派生正文实质清除，不能只打stale（Task 4/5）。
* 另一个scope的旧extract仍unknown：新整理不得借独立queue、重启或直接run绕过profile门（Task 6/7）。
* HTTP publish重放/崩溃后catalog.operations缓存旧candidate：只回无正文ref，已删除对象不因replay复活（Task 5/8）。
* native工具结果在history中、投影map丢失或经PTC聚合：未知自有结果零dispatch，嵌套不输出正文（Task 9）。

---

## 文件与增量地图

| 增量 | 新文件/主要改动 | 可独立验收产物 |
|---|---|---|
| I1 / Task 1..5 | schema、inputs、validation、lifecycle、versions及对应tests | 不调用模型，以合成output完成同scope候选→发布→来源失效清除闭环 |
| I2 / Task 6..7 | profile control、provider wrapper、consolidation jobs/grants、scheduler | 替身Provider的一次调用闭环；旧/新purpose共享预算/unknown门 |
| I3 / Task 8..10 | management、UI/locale、native手动工具/最终门、Host合同工具 | 用户入口完整；手动检索有来源；真实Host合成门证明单独记录 |
| I4 / Task 11 | 批准Provider/出口验收工具、独立审查与新证据 | 授权范围内的合成完整旅程、故障和出口证明；再决定release |

各Task可分派，但Task 1→2→3→4→5与6→7及8→9→10的接口依赖必须遵守。设计作者不作为最终独立审查者。本计划本身不启动subagent；未来执行方法由协调者按用户/仓库授权决定。

## Task 1: 合法双库迁移与profile控制库身份

**Files:**
- Create: `src/consolidation-schema.mjs`, `tests/consolidation-migration.test.mjs`, `tests/fixtures/mc-v030-content.sql`, `tests/fixtures/mc-v030-authority.sql`。
- Modify: `src/schema.mjs`、`src/store-internals.mjs: initializeAuthority/assertAuthority`、`src/backend.mjs: openStore/exportSnapshot/restoreSnapshot接口`。

**Interfaces:**
- Produces: `CONTENT_V2_SIGNATURE`, `CONTENT_V3_SIGNATURE`, `AUTHORITY_V1_SIGNATURE`, `AUTHORITY_V2_SIGNATURE`, `migrateConsolidationSchema(ctx): void`；SQL按设计§6逐字段落地。
- `openStore`仍返回同MemoryStore；旧v1显式迁移语义保留，新的v2→v3合法加表自动迁移，未知sig拒绝。

- [ ] **Step 1: 写行为失败测试。** `migrates_v030_pair_without_changing_memories_or_work` 断言原records/work payload字节相等、authority.identity不变、版本3/2；`rejects_modified_or_unknown_schema_without_writes` 断言未知表/触发器/版本拒绝且旧库sha不变；`rolls_back_both_databases_at_each_migration_fault` 断言两个版本同时旧或同时新。对应MC-AT-10。
- [ ] **Step 2: 运行失败测试。** `& .\runtime\node.exe --test tests/consolidation-migration.test.mjs`，预期FAIL：新schema/exports尚不存在；不能把import失败当已有行为红灯，新增接口后需确认断言因迁移缺失而失败。
- [ ] **Step 3: 实现精确迁移。** 先核现有anchor/owner/scope/signatures，已attach的content+ledger用专用同步事务升级，发生在只认新sig的普通write/assertAuthority之前；更新expected signature与open后的schema_version捕获；不要移除FTS integrity/secure-delete断言。初始head/policy行用明确scope初始化。
- [ ] **Step 4: 跑目标与旧迁移回归。** `& .\runtime\node.exe --test tests/consolidation-migration.test.mjs tests/migration.test.mjs tests/backend.test.mjs`；预期退出0、无skip；旧snapshot v2仍可在新代码恢复原collection。
- [ ] **Step 5: 记录检查点。** 核diff只有该Task文件；在实施授权允许时提交 `feat(memory): migrate consolidation storage`，不改旧evidence。

## Task 2: 同scope输入manifest与用户摘录

**Files:**
- Create: `src/consolidation-inputs.mjs`, `tests/consolidation-inputs.test.mjs`, `tests/consolidation-fixtures.mjs`。
- Modify: `plugin/configuration.mjs`、`plugin/project-registry.mjs`（暴露已核binding快照，不更改scope算法）。

**Interfaces:**
- Consumes: Task1新表、现`store.get/contextOf/entry_sources/checkedText/canonical`。
- Produces: `createConsolidationInputs(store,{registry,config,now})`，方法/manifest见MC-API-01/02/04；明确包含`rootSources:SourceIdentity[]`；`registerExcerpt(args): ExcerptRef`、`revokeExcerpt(args): MutationRef`、`snapshot({jobId,permissionId,memoryIds,excerptIds,mode,route,baseHeadRevision}): {manifest,input,inputChars}`、`assertCurrent(manifest,{phase}):void`。jobId/permissionId为内部预分配，不接受HTTP调用方指定。
- `normalizeConfig`新增设计§4.3字段；`routeRefFor(config,'memory_consolidate')`选择整理route，未知purpose抛错；config schemaVersion仍1。

- [ ] **Step 1: 写失败用例。** `two_sessions_same_scope_yield_pinned_manifest`核recordGeneration/bodyDigest/rootSources；`cross_repo_build_binding_or_config_conflict_refused`模型调用0（MC-AT-02）；`missing_original_fragment_yields_memory_only_warning`核无虚构original text（MC-AT-03）；`excerpt_registration_is_user_attestation_not_host_proof`核assurance固定；`expired_revoked_or_changed_excerpt_never_reads`（MC-AT-04）；`exact_prompt_plus_input_limit_rejects_without_truncation`断言8000可容、8001拒绝及CONFIG原文未剪裁。
- [ ] **Step 2: 跑失败测试。** `& .\runtime\node.exe --test tests/consolidation-inputs.test.mjs tests/configuration.test.mjs`，预期新增行为FAIL，旧配置应保持兼容。
- [ ] **Step 3: 实现固定输入与config。** 文本只进入content输入/摘录表，manifest/permission无正文；所有来源/状态/时间同步检查；无文件读取、history扫描、凭据访问或网络。默认关闭，新启用时scheduler.concurrency必须1；automaticRecall非false拒绝。CONFIG_CONFLICT禁发送/发布，不猜scope。
- [ ] **Step 4: 验证。** 同Step2命令，预期0；另 `& .\runtime\node.exe --test tests/project-registry.test.mjs tests/projects.test.mjs`，预期旧多仓scope/CONFIG行为仍过。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): pin consolidation inputs and excerpts`。

## Task 3: 严格模型JSON与离线候选生成

**Files:**
- Create: `src/consolidation-validation.mjs`, `schemas/consolidation-output.schema.json`, `tests/consolidation-validation.test.mjs`。
- Modify: `src/provider.mjs`（新增`MODEL_PURPOSES`与原3项`EXTRACTION_PURPOSES`）、`src/jobs.mjs: PURPOSES使用点`、`plugin/harness-provider.mjs: PROMPTS/measureInput`。

**Interfaces:**
- Produces: `validateConsolidationOutput(text:string,manifest:ConsolidationManifest,inputSnapshot:InputSnapshot): CanonicalCandidatePayload`；InputSnapshot为设计§5完整模型输入（含schema/mode/context/kind/assurance），核其inputDigest；schema mc-output-v1见MC-API-03；`CONSOLIDATION_PROMPT`只有一份权威文本供bridge和计量使用。
- `createControlledProvider`允许4个model purposes，现`PURPOSES`可保留为MODEL_PURPOSES别名以免旧导入断裂；旧queue/snapshotQueueRoute显式只认EXTRACTION_PURPOSES。

- [ ] **Step 1: 写失败测试。** `complete_groups_and_untouched_preserve_every_selected_memory`；`rejects_missing_duplicate_unknown_or_wrong_memory_excerpt_refs`；`source_correction_requires_excerpt_and_stays_hypothesis`；`rejects_verified_secret_extra_fields_and_oversized_output`；`different_CONFIG_text_cannot_be_exact_duplicate`；`related_summary_semantics_are_unverified_and_originals_are_preserved`（错误概括fixture不得被当作语义校验通过）；`unknown_build_never_becomes_verified_current_build`；`old_queue_refuses_consolidation_purpose`。对应MC-AT-03/05/12。
- [ ] **Step 2: 跑红灯。** `& .\runtime\node.exe --test tests/consolidation-validation.test.mjs tests/jobs.test.mjs tests/harness-provider.test.mjs`；预期新增schema行为FAIL，留住旧队列断言。
- [ ] **Step 3: 实现validator/prompt。** JSON整份解析/clean/shape/精确enum/引用覆盖/上界；duplicates只认首尾去空白后逐字相等；candidate本地添加warnings/coverage/route与unverified、semanticValidation=not_performed；不宣称能自动检出任意条件损失/实验编造。模型无权提供权限/事实认证字段。prompt+输入仍≤8000，token仍≤2048，不修改原用途最大值。
- [ ] **Step 4: 验证。** 同Step2预期退出0；确认源prompt注入fixture只作为数据，未增加任何工具动作或自动重发。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): validate sourced consolidation candidates`。

## Task 4: 删除继承与新正文实质清理

**Files:**
- Create: `src/consolidation-lifecycle.mjs`, `tests/consolidation-lifecycle.test.mjs`。
- Modify: `src/lifecycle.mjs: forget/archive/correctMemory/consumeCapabilityEvent/restoreSnapshot`、`src/store-internals.mjs: advance/reconcile`、`src/backend.mjs: exportSnapshot/rebuildIndex`。

**Interfaces:**
- Produces: `invalidateConsolidation(ctx,{memoryIds:string[],rootSources:SourceIdentity[],excerptIds:string[],reason:string,mode:'delete'|'invalidate'}): {clearedInputs,clearedExcerpts,clearedBodies}`；`invalidateConsolidationEpoch(ctx,currentEpoch:number):void`；`reconcileConsolidation(ctx):void`。
- 由原同步事务调用；删除pending/ready正文，running仅标invalidated+abort通知，不释放任何dispatch锁。

- [ ] **Step 1: 写矩阵失败测试。** 原delete/archive/correct/event分别发生在queued/running/ready/两个历史version时，断言新content三表中无相应正文、entry依赖阻断、原年度payload不变；`archive_restore_does_not_restore_old_derived_body`；`restoring_v2_or_v3_snapshot_requires_current_authority`；`unknown_running_dispatch_gate_survives_purge`。对应MC-AT-07/10/13。用SQL读取当前表实际字节，不只断言API隐藏。
- [ ] **Step 2: 跑红灯。** `& .\runtime\node.exe --test tests/consolidation-lifecycle.test.mjs`，预期FAIL：旧生命周期未清新正文。
- [ ] **Step 3: 实现同步依赖清理。** rootSources全继承，候选旧epoch一律清；version依赖失效清head并递增headRevision；保留无正文tombstone/幂等结果。snapshot v3只导出活发布版本，不带候选/摘录/input；v2仍合法。禁止权限不明时重建entry或依赖。
- [ ] **Step 4: 验证。** `& .\runtime\node.exe --test tests/consolidation-lifecycle.test.mjs tests/lifecycle.test.mjs tests/abstracts.test.mjs tests/sharing.test.mjs`；预期0，无新派生被塞进原abstract/share；全量旧行为未回退。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `fix(memory): inherit source lifecycle into consolidation bodies`。

## Task 5: 离线候选保存、CAS发布与有界本地检索

**Files:**
- Create: `src/consolidation-versions.mjs`, `tests/consolidation-versions.test.mjs`。
- Modify: `src/consolidation-inputs.mjs`（使用Task4清理/reconcile），`tests/consolidation-fixtures.mjs`（可信离线候选构造器，不能成为生产绕过入口）。

**Interfaces:**
- Produces: `createConsolidationVersions(store,{inputs,grants,config,now})`的方法见MC-API-09；另内部`saveCandidate(ctx,{jobId,runToken,payload,manifest}):CandidateRef`仅同queue事务可调用，不从管理/工具导出。
- `getCandidate/getVersion/search`均核digest/entry/全部根依赖；read不调用Provider；search有界扫描最多25份活version，无新FTS。

- [ ] **Step 1: 写失败用例。** 合成合法payload保存→ready→publish→search，断言原records与work字节不变（MC-AT-01）；`publication_checks_revision_epoch_head_and_binding`；`duplicate_publish_returns_same_id_but_changed_request_conflicts`；`each_fault_rolls_back_head_body_entry_operation_together`；`replay_after_delete_returns_only_tombstone_metadata`（MC-AT-06/10）；`new_batch_does_not_claim_full_scope_coverage`；`memory_only_publication_survives_batch_expiry_and_restart_but_not_publication_revoke`、`excerpt_expiry_only_purges_dependent_versions`（MC-AT-14）。
- [ ] **Step 2: 红灯。** `& .\runtime\node.exe --test tests/consolidation-versions.test.mjs`，预期新增行为FAIL。
- [ ] **Step 3: 实现离线版本闭环。** Candidate保存不推进store revision；publish一个同步content+ledger事务CAS，并创建kind=publication、expires_at=NULL、绑定versionDigest的独立读取许可；版本不依赖batch TTL，摘录仍保留单独TTL。成功才advance revision；candidate正文清除、entry superseded。元数据幂等仅写authority，不写catalog；过期/GC清正文并保留tombstone；明细超4000时返回group索引，禁止截断条件。
- [ ] **Step 4: 验证I1。** `& .\runtime\node.exe --test tests/consolidation-migration.test.mjs tests/consolidation-inputs.test.mjs tests/consolidation-validation.test.mjs tests/consolidation-lifecycle.test.mjs tests/consolidation-versions.test.mjs`；预期0。产物是**离线合成闭环**，不得称模型整理已可用。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): publish independent consolidation versions`。

## Task 6: 全purpose profile预算与持久dispatch协调

**Files:**
- Create: `src/model-dispatch-control.mjs`, `plugin/model-dispatch.mjs`, `tests/model-dispatch-control.test.mjs`, `tests/model-dispatch.test.mjs`。
- Modify: `plugin/index.mjs` provider装配，`plugin/management.mjs`与`plugin/host-grants.mjs`旧恢复联动（不改旧准入语义）。

**Interfaces:**
- Produces: `createModelDispatchControl({root,limits,now})`含MC-API-08各同步方法；`createProfileControlledProvider({inner,control,resolveOwner})`保持原bind/approved/measureInput/execute。
- `resolveOwner(requestId:string): {scopeRef,ownerKind:'extraction'|'consolidation',fingerprint,policyDigest}|undefined`读取实际running row；requestId明确为provider传入的**job.id**，不是caller row.request_id/HTTP operationId；dispatches/legacy导入/recovery_journal/scope dispatch_lock用同一job.id。未知owner拒绝。`confirmQuiescence({requestId,scopeRef,status,confirmationRef,token}):RecoveryRef`只匹配原owner。
- 独立control库schema/version/identity见设计§6；无正文、无网络。旧queue本地预算继续有效，总预算为额外硬门。

- [ ] **Step 1: 写失败用例。** `old_extract_annual_and_consolidation_share_profile_daily_caps`；`different_scopes_cannot_dispatch_in_parallel_even_without_scheduler`；`unknown_blocks_all_purposes_after_restart`；`same_id_changed_scope_or_body_never_reexecutes`；`legacy_unknown_import_or_scope_scan_failure_holds_gate`；`legacy_import_and_recovery_use_job_id_not_caller_request_id`；`bootstrap_imports_distinct_authority_daily_reservations_once`；`preflight_budget_gate_owner_or_identity_refusal_is_not_dispatched_for_legacy_queue`（断言没有新增unknown/profile row、不改原owner锁）；`mark_fault_before_inner_is_not_dispatched_but_control_failure_keeps_gate`；`missing_control_anchor_fails_closed`；`recovery_crash_after_local_release_keeps_global_gate`。对应MC-AT-08/09/12。
- [ ] **Step 2: 红灯。** `& .\runtime\node.exe --test tests/model-dispatch-control.test.mjs tests/model-dispatch.test.mjs`，预期没有broker行为而FAIL。
- [ ] **Step 3: 实现控制库/wrapper。** 持久reserve→in_flight后才inner.execute；所有发送前预算/gate/owner/身份拒绝映射`DispatchPreflightUnavailable extends RouteUnavailable`，不制造假unknown；inner后只有确定RouteUnavailable为not_dispatched，完成非法响应为completed，其余unknown保留门。启动导入旧unknown；首次bootstrap按不同authority汇总当日旧预留，legacy_budget_imports幂等并完成后不重导。任何不可枚举scope拒绝启用；原所有queue只能拿wrapper，scope原dispatch_lock继续防御。恢复先本scope锁、再journal/全局门；中断只保守续做释放、不重发。
- [ ] **Step 4: 验证。** 同Step2加 `tests/jobs.test.mjs tests/execution-authorization.test.mjs tests/management.test.mjs`，预期0；检查四purpose实际只触及同一个inner provider实例，旧模型任务无新接收方。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): share profile model dispatch and budgets`。

## Task 7: 整理授权、新队列和唯一scheduler

**Files:**
- Create: `plugin/consolidation-grants.mjs`, `src/consolidation-jobs.mjs`, `tests/consolidation-grants.test.mjs`, `tests/consolidation-jobs.test.mjs`。
- Modify: `plugin/scheduler.mjs`、`plugin/index.mjs`，`tests/scheduler.test.mjs`。

**Interfaces:**
- Consumes: Task2 inputs、Task3validator、Task4purge、Task5saveCandidate、Task6包装provider。
- Produces: `createConsolidationGrants({config,registry,now})`含设计§7.2的authorizeBatch/authorizeExecution/authorizePublication/revokeScope；`createConsolidationQueue(store,{provider,inputs,grants,config,now})`含MC-API-05全部方法；`createScheduler`新增可选`consolidationQueueFor(scopeRef)`、`canDispatch():boolean`，旧签名兼容。
- owner登记在queue running row落库后、wrapper调用前完成；不能靠调用参数注入可信scope。Task7测试要使用Task6真实本地broker、仅inner模型为替身。

- [ ] **Step 1: 写失败用例。** `one_call_creates_ready_candidate_without_changing_originals`（MC-AT-01）；`enqueue_replay_reuses_job_without_new_uuid_permission_or_budget`；`permission_route_binding_changes_at_claim_dispatch_candidate_publish_abort`；`queued_cancel_clears_input_without_call`；`running_cancel_timeout_and_late_result_stay_unknown_no_candidate`；`restart_never_recreates_old_batch_permission`；`held_or_unavailable_profile_gate_keeps_all_scheduler_jobs_queued`；`three_old_jobs_then_one_consolidation_prevents_starvation`；`stop_is_bounded_and_does_not_claim_remote_stop`。对应MC-AT-04/07/08/09/14。
- [ ] **Step 2: 红灯。** `& .\runtime\node.exe --test tests/consolidation-grants.test.mjs tests/consolidation-jobs.test.mjs tests/scheduler.test.mjs`；预期新增行为FAIL。
- [ ] **Step 3: 实现状态/lease。** enqueue同事务固定manifest/route/预算日/无正文permission/输入；run一次调用，候选保存与终态原子；runninginvalidated不释放未知锁；取消仅新queue有接口，不冒称旧queue支持。唯一scheduler同scope busy、启用整理固定并发1、每3旧任务让1整理；无自动扫描或周期整理。
- [ ] **Step 4: 验证I2。** 同Step2加 `tests/model-dispatch.test.mjs tests/jobs.test.mjs tests/harness-provider.test.mjs tests/host-grants.test.mjs`，预期0，明确这是替身Provider层；不调用真实模型。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): execute authorized consolidation jobs`。

## Task 8: 同步管理入口、无正文幂等与UI

**Files:**
- Create: `plugin/consolidation-management.mjs`, `tests/consolidation-management.test.mjs`。
- Modify: `plugin/management.mjs`、`plugin/index.mjs`、`client.js`、`locale/zh.json`、`locale/en.json`、`tests/plugin-entry.test.mjs`。

**Interfaces:**
- Produces: `createConsolidationOperations({registry,config,queueFor,versionsFor,inputsFor,grants,dispatchControl,now})`返回MC-API-11同步handler表；handler context扩展内部operationId，由dispatcher传入。
- request只入队；`consolidation.*`全部绕过catalog.operations/fallback，mutations业务幂等写scope authority；READ_ONLY/USER_ONLY两表显式更新。

- [ ] **Step 1: 写失败用例。** `http_user_can_request_poll_review_and_publish`；`model_or_host_cannot_request_grant_publish_revoke_or_cancel`；`all_consolidation_extras_are_synchronous`；`catalog_operations_never_contains_candidate_excerpt_or_model_body`；`source_delete_then_http_retry_returns_no_stale_body`；`config_conflict_disables_consolidation_dispatch_and_publish`。对应MC-AT-02/07/08/13。
- [ ] **Step 2: 红灯。** `& .\runtime\node.exe --test tests/consolidation-management.test.mjs tests/plugin-entry.test.mjs`，预期新operation未注册而FAIL。
- [ ] **Step 3: 实现管理及UI。** 使用同origin route与locale；按设计ComparisonRow/CandidateReview DTO显示完整原文对照、batch覆盖、source缺失/unverified/unknown/语义未验/预留成本；提供excerpt登记、候选diff、停止/弃用/发布、版本搜索与恢复说明。写operation只回refs；候选通过实时读展开；清理后客户端卡片清缓存；无自动模型poll/retry，无新增远程资源。本轮另交的A/B原型不等于client已实现。
- [ ] **Step 4: 验证。** 同Step2加 `tests/management.test.mjs tests/m2-management.test.mjs tests/work-management.test.mjs`，预期0；人工本地fixture走UI各状态，记录截图与尺寸，仅本轮后续实施时做。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): expose consolidation review and publication`。

## Task 9: native手动检索工具与派生最终投影

**Files:**
- Create: `plugin/consolidation-projection.mjs`, `tests/consolidation-projection.test.mjs`。
- Modify: `plugin/final-projection.mjs`组合门、`plugin/index.mjs`工具注册，`tests/final-projection.test.mjs`。

**Interfaces:**
- Produces: `createConsolidationProjection({registry,grants,versionsFor,sessions,config,now})`含`recordToolResult(args):void`、`verify({sessionId,messages}):{action:'pass'|'block'|'not_ours',reason?}`、`dispose():void`。
- 新工具`memory_consolidation_search({query,limit})`与`memory_consolidation_get({versionId,groupIds?})`；只有native exec.callId/无exec.parent可输出正文，current绑定/recall授权。工具render文本唯一，digest含schema标记`local-memory-consolidation-result-v1`。

- [ ] **Step 1: 写失败用例。** `native_result_is_citable_and_checked_at_every_final_dispatch`；`get_includes_complete_originals_or_returns_only_index_when_over_limit`；`single_group_over_4000_returns_too_large_and_local_UI_recovery`；`deletion_archive_revoke_head_change_after_tool_result_blocks_zero_next`；`missing_projection_or_history_call_mapping_blocks`；`fixed_refusal_passes_but_extra_text_cannot_forge_refusal`；`blocked_chat_has_visible_recovery_and_new_chat_query_can_continue`（旧聊天仍blocked、新聊天重新检索后有效dispatch，不能假装透明修复）；`changed_render_or_tool_call_id_blocks`；`ptc_parent_or_missing_callId_returns_no_body`；`deep_frozen_mixed_old_new_projection_request_is_never_mutated`。对应MC-AT-11。
- [ ] **Step 2: 红灯。** `& .\runtime\node.exe --test tests/consolidation-projection.test.mjs tests/final-projection.test.mjs`，预期新tool-result不会被旧门识别而FAIL。
- [ ] **Step 3: 实现新投影分支。** 不放宽旧RECORD_FIELDS；新version ref与所有roots/publication许可及excerpt TTL分别核验，不使用batch TTL；从assistant tool-call名称及tool source/callId/结果标记识别自有历史。map缺失不可pass；任何一个门block则llm/stream零next，并向本地UI发安全恢复诊断，明确通过现有Host新聊天后重查继续，不猜测历史撤回API。PTC拒绝，不输出可被聚合绕门的正文。
- [ ] **Step 4: 验证。** 同Step2加 `tests/consolidation-management.test.mjs tests/session-hooks.test.mjs`，预期0。自动召回仍false；旧用户普通经验自动流继续原实现。
- [ ] **Step 5: 记录检查点。** 实施允许时提交 `feat(memory): gate manual consolidation tool results`。

## Task 10: 封存Host合成合同、故障与全量回归

**Files:**
- Create: `tools/host-api/consolidation.test.mjs`, `tools/test-consolidation-host.mjs`, `tests/consolidation-end-to-end.test.mjs`。
- Modify: `tests/fake-host.mjs`（仅添加真实形状tool result/exec.callId fixture），必要时扩展测试入口，不改旧封存证据。

**Interfaces:**
- `tools/test-consolidation-host.mjs`沿现`tools/test-m1-host.mjs`隔离方式，使用封存版本真实Cordis/LlmRuntime/ToolsRegistry；模型adapter只合成，不访问真实API或用户会话。
- 新证据文件未来写 `evidence/mc-design1-<stage>-<commit>.*`；至少含command、exit、Node/Host/source SHA、fixture位置、skip/unknown、stdout摘要、模型替代边界。

- [ ] **Step 1: 写失败集成用例。** 从实际tool execute→Host render→role:tool→最终stream链检查有效放行、删除后0 adapter dispatch、历史map缺失阻断；prepare/stream时撤权、卸载后晚到回包、发布SQL断点、control双文件损坏。对应MC-AT-01/07/09/10/11/14。
- [ ] **Step 2: 首次运行记录具体缺口。** `& .\runtime\node.exe --test tests/consolidation-end-to-end.test.mjs`；`& .\runtime\node.exe tools/test-consolidation-host.mjs`。预期首次新集成测试失败位置可定位；若Host物料缺失/不同版本则阻断该层，不用skip冒充通过。
- [ ] **Step 3: 只修适配缺口。** 不虚构Host API；若native工具结果形状不匹配，保持工具unavailable，UI候选/发布仍可本地验收；不能让正文工具绕开最终门。独立本地UI截图与locale/theme检查在合成profile进行。
- [ ] **Step 4: 全量本地与Host回归。** `& .\runtime\node.exe --test tests/*.test.mjs`、`& .\runtime\node.exe tools/test-consolidation-host.mjs`、`& .\runtime\node.exe tools/test-m1-host.mjs`；预期退出0、没有未说明skip。新证据注明真实模型/OS出口仍未验，不能覆盖历史M2文件。
- [ ] **Step 5: I3评审检查点。** 另一个未参与实现的角色审查需求→用例、事务/清理/共享门/工具history；修复阻断项再复验受影响测试；实施允许时提交 `test(memory): verify consolidation host contracts`。

## Task 11: 真实批准Provider、出口与发布门禁

**Files:**
- Create: `tools/verify-consolidation.mjs`（合成profile/已登记route参数，默认dry/read-only计划显示；真实执行需显式参数）及独立新证据。
- Future update only: `docs/implementation-route.md`、`docs/mechanisms.md`、`README.md`/版本清单/TODO，在**正式实现范围**按真实结果同步；本设计轮不更新。

**Interfaces:**
- verifier固定`--profile-root <approved-local-temp-root> --route-ref <registered-ref> --execute-approved-api`，仅消费Host凭据引用；无env key/任意URL、无用户原始数据。运行物料commit/依赖SHA入证据。

- [ ] **Step 1: 在调用前记录合成实验预测。** 待用户预测的业务观察明确标待完成；工程自动测试预期可按MC-AT矩阵固定，但不能替用户声称理解/观察。首个运行行为：两条合成重复/矛盾经验，预期一次调用、候选unverified且冲突保留。
- [ ] **Step 2: 只在正式实施与现有API授权/门禁满足时运行。** `& .\runtime\node.exe tools/verify-consolidation.mjs --profile-root <本地合成profile> --route-ref <已登记route> --execute-approved-api`，预期ready→显式publish→本地search/get成功，原memory/年度记录不变；模型不稳定输出可失败，不得重试到好结果后隐藏失败率。
- [ ] **Step 3: 运行批准环境的负向出口与故障检查。** 未批准Provider、重定向/DNS/代理/子进程/浏览器资源无新增接收方；记录实际方法/拒绝日志。若OS级隔离无法证明，明确未验，不声称已完成该层；不得自行放开网络完成测试。
- [ ] **Step 4: 独立最终评审。** 对MC-001..012、API01..12、AT01..14逐项映射实际证据；模型质量与权限/状态分别结论。没有Host最终门证明则手动工具禁用并保留运行门禁，不能宣布完整首版完成。
- [ ] **Step 5: 发布/安装按现有范围执行。** 先更新开工路线与每来源实际采用机制、构件锁、机制说明和已验证状态；再按当时既有授权安装合成验收并记录release。commit/push/外部同步不是本设计任务授权，当前不得执行。

## 后置任务边界

MC-F01自动召回必须另建任务：`plugin/session-hooks.mjs` 的RecallRef union→`recordDerived`→最终门head/全依赖验证→真实Host删除后0dispatch；此前 `automaticRecall=false`。MC-F02年度无损整理、MC-F03Agent索引授权解耦、MC-F04Host原文/PTC/自动整理都不在上述实现任务中，不得为省任务偷偷开启。

## 设计自检与交接

需求覆盖：MC-001→2/5/7/8，002/003→2/3/4，004→3，005→5，006→4/5/9，007→6/7，008→8/9/10，009→2/6/11，010→4/5/10，011→5/9与明确后置，012→7/10/11。Review Focus五项均有对应失败测试；所引用接口由前置Task生产，不引用不存在的Host私有方法。candidate保存不推进revision，publication推进revision；manifest pin和publish CAS一致。catalog没有新正文缓存；跨库broker恢复按保守unknown，不宣称全局原子事务。

此计划已按MC-DESIGN-1进行静态自检；独立评审由根协调者组织。**全部checkbox保留未完成。** 没有执行迁移/测试/API/Host/安装/提交。计划文件只是可编码合同，未来若来源/范围实质变化先更新影响ID和路线，再实施；不需要重问既有授权或细阈值。

**接下来该怎么做：** 用约15分钟先审查Task 4、6、9的三个失败旅程是否覆盖删除正文、跨队列unknown和工具历史；完成标准是每个反例能指向明确状态、清理事务或最终门，再从Task 1开始执行。
