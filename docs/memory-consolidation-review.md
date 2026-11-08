# 受控跨会话记忆整理：独立设计评审

评审编号：`MC-REVIEW-1`。日期：2026-11-08。状态：**R2 独立静态复核完成；四项历史 Important 均在设计层关闭，当前 0 Critical / 0 Important / 0 Minor。可作为后续实施输入，不认证任何功能已实现或运行通过。**

评审者未编写或修改待评设计、计划和代码；本轮只写本报告。审查为本地静态阅读和接口/状态反例推导，没有运行新功能、迁移、Host、真实 Provider、安装或出口测试，没有提交或同步。

## 1. 对象与基线

被评基线为 `dsh-local-memory-linqu@0.3.0`，本地 Git HEAD `d75472f30aea5c7842143497637c4363e2a26d15`。

| 初轮实际读取对象 | 修订 | SHA256 |
|---|---|---|
| `docs/memory-consolidation-design.md` | MC-DESIGN-1 R1 | `fadff123d1665eac0fbe65ed70c3cf2959911b0f8887773aefe67d95c6831d23` |
| `docs/superpowers/plans/2026-11-08-memory-consolidation.md` | Spec R1 | `fd978777e0235bec026a2454cf406a0a6ab158e3b6591580a6355a619fd84e8f` |

两份对象均位于 `05-local-memory` 下；不是工作区根的 `docs/superpowers/plans`。复核后将在本报告记录最终设计和计划的实际 SHA，不使用未提交文档的 Git HEAD 冒充文档身份。

先独立检查了根 AGENTS/SKILL、设计/局部修订/共同开发合同、05 当前 `schema/store-internals/backend/lifecycle/jobs/provider/work-summary/projects/abstracts/sharing`，以及 `configuration/project-registry/host-grants/harness-provider/scheduler/management/final-projection/index` 和 M2 独立评审。主要判据是能否按真实 API 编码、能否保护当前自动经验流、来源/删除/撤权是否贯穿新正文与历史、unknown 是否保守且可恢复、实际工具是否能使用发布结果。

## 2. 初轮发现（保留原发现及反例）

严重度：Critical 为数据/权限硬边界突破或不可恢复破坏；Important 为核心合同、实际可用旅程或可编码性缺口；Minor 为不改变主要行为的规格精度问题。

### MC-R01 — 批次许可到期同时清除长期发布结果

**Important；初轮状态：open。** 位置：设计 R1 §7.2、§8.1/8.2、§9.2；计划 Task 5/7/9。

R1 批次 permission 固定 24 小时，候选发布和版本读取/最终投影都核该 permission 及 expiry，没有独立的 publication 使用许可。反例：用户用 `memory_only` 生成并发布合法版本，原记忆和路由始终有效；25 小时后读取会因原批次过期而拒绝、reconcile 还要清正文。这使与摘录无关的已发布整理也无法持续作为本地知识使用，且没有版本续权入口。

需要补齐：区分执行/候选有效期和发布后使用权；明确重启、显式 revoke、来源删除、摘录到期分别作用于哪些权限与正文。补 `memory_only` 发布跨 TTL/重启仍可读，以及含到期摘录的版本清除负例。

### MC-R02 — broker 发送前拒绝可能污染旧队列为假 unknown

**Important；初轮状态：open。** 位置：设计 R1 §7.3/7.4；计划 Task 6/7；实际基线 `src/jobs.mjs: runJob`。

旧队列仅把 `RouteUnavailable` 归为 `failed/not_dispatched`，把完成但非法响应归为 failed；其他异常一律 `outcome_unknown` 并保留 scope dispatch_lock。R1 只定义 inner Provider 的 RouteUnavailable，未给新增 wrapper 的 owner/总预算/已有全局门/reserve/markInFlight 拒绝定义确定分类。

反例：scope A 已有真实 unknown，scheduler 仍启动 scope B 的旧 queued 提炼；broker 在 reserve 因 A 的门拒绝，从未进入 inner，却以普通异常回到 B 的旧队列。B 被误记 unknown 并新增隔离锁。预算耗尽或并发直接 run 同样可能发生；这会影响既有 PF-03b 自动流。

需要补齐：精确定义 wrapper 调用 inner 前后的线性化点和全部异常映射；确定未发送必须通过旧队列可识别类型返回，持久状态损坏仍须 fail closed。调度器在 gate held/unavailable 时不消耗 queued 作业；直接调用也须保持确定的 `not_dispatched`，不能制造假 unknown。补跨 scope/旧 purpose、预算拒绝和 reserve/mark 故障用例。

### MC-R03 — 失效工具历史使聊天持续阻断，缺少用户恢复旅程

**Important；初轮状态：open。** 位置：设计 R1 §9.2/9.3；计划 Task 9/10。

新门检查每次请求内的自有工具历史；删源、切换 head 或重启后 projection map 丢失都 block 整个 `llm/stream`。这条 fail-closed 边界本身合理，但 R1 未定义如何让用户继续工作。

反例：Agent 在聊天 S 调 get 获得 v1，用户随后发布 v2。S 下次请求仍带旧工具结果，零 next；由于模型请求无法发送，Agent 不能再调用 search/get 自愈。插件重启后，所有带此类结果的旧聊天也出现同样问题。仅写“恢复说明”或验证零 next，尚未构成可恢复的使用旅程。

需要补齐：给出已核 Host 适配或确定的首版恢复动作。若采用新会话重新查询，应明确旧聊天本地保留、没有透明历史替换、用户何处看到具体原因/动作，并把这一 rollout 代价写入使用旅程与验收；不能虚构可修改 deep-frozen 历史的 Host API。

### MC-R04 — 引用结构校验不能兑现语义/CONFIG 自动保留声明

**Important；初轮状态：open。** 位置：设计 R1 §5；计划 Task 3。

R1 声明新时间/实验数字、跨 build 归并、丢失 CONFIG 条件等应整份拒绝；但 validator 入参为模型 text 与不含源正文的 manifest，输出 support 只有来源别名，没有可执行的条件映射或支持充分性规则。

反例：同 scope 的 m0 为“仅 CONFIG_X=y 需要 barrier”，m1 为“CONFIG_X=n 不需要 barrier”；模型输出 `duplicates`、statement 为“始终需要 barrier”，support 覆盖 m0/m1、status 为 unverified。给出的 schema/引用覆盖检查均可通过。来源存在不等于 statement 被充分支持，未核验标签也不能证明已保留条件。

需要补齐：明确可自动检查的边界与算法（例如限定的原文条件字段/片段映射），或者收窄自动校验承诺并将语义、条件和归并质量留为显式的人审事项。候选必须持续显示全来源和未核验状态，不能把引用合法写成语义正确。补“引用合法但错误概括/新数字”的负向或人工拒绝旅程。

## 3. 已确认的设计方向与保留边界

以下是静态审查确认的设计选择，**不是功能通过证据**：

- 旧普通经验 PF-03b 自动提炼/保存/召回被明确保留；新手动批次/显式发布是新视图的 rollout 默认。
- 新队列、批次授权和 purpose 与旧 message receipt 分开，不伪造历史 session 准入；实际旧 queue 无 cancel 的事实已写清。
- 单批固定具体 scope/binding；不把项目多仓等同同一事务；CONFIG_CONFLICT、退休/禁用 binding 有拒绝要求。
- 候选/派生版本独立于 records 和年度 work_summaries，不篡改原事实或年度本人贡献/证明；共享继续指向原 scope 活记忆且 user-only grant。
- 内容 v2→v3、authority v1→v2 与当前精确 signature/identity 门明确关联；catalog v2 不新增正文；删除/归档/纠正的依赖清理被安排进原同步事务。
- 手动工具有独立投影设计，没有声称可以直接复用原 RECORD_FIELDS；PTC 首版拒绝，真实 Host 门不足时工具保持 unavailable。
- 模型只经批准 DSH Provider；存储/索引/管理本地，不接托管 memory。原 M2 组件/安装态证据没有被提升为真实整理、Provider 或 OS 出口证明。

## 4. R2 修订复核与关闭记录

下列关闭结论均来自评审者重新阅读实际落盘 R2；不是仅采信作者答复，也不是执行测试所得。

| 原发现 | 当前状态 | 实际修订与对应未来用例 |
|---|---|---|
| MC-R01 | **closed（设计层）** | §6.1 permissions 增 publication，SQL CHECK 要求其 expires_at=NULL；§7.2/8.1 发布事务创建绑定 versionDigest 的独立读权；§8.2 版本读不比较历史执行 epoch、batch TTL 或 bridge activation。摘录 TTL 仍只清依赖版本，scope revoke 撤 publication。计划 Task 5 的 `memory_only_publication_survives_batch_expiry_and_restart_but_not_publication_revoke` 和 `excerpt_expiry_only_purges_dependent_versions` 对应反例。 |
| MC-R02 | **closed（设计层）** | §7.3 明确发送前拒绝为 `DispatchPreflightUnavailable extends RouteUnavailable`；markInFlight 故障将 inner 调用 0 与本地控制状态不明分开，不制造远端 unknown；§7.4 scheduler tick/launch 均核 canDispatch，门占用时不 claim 旧任务。provider requestId 明确为 job.id，区别 caller request_id。Task 6/7 已补旧队列前置拒绝、mark 故障、跨 scope unknown 与保持 queued 的验收；首次升级当日旧预算也按 authority 去重导入，不以新控制库清零。 |
| MC-R03 | **closed（明确首版恢复限制）** | §9.2 明说没有已核历史替换接缝；失效聊天仍被阻断，UI 收安全诊断并指导使用现有 Host 新聊天入口后重查，不自动复制旧正文。旧聊天保留本地，不能称透明恢复或用户已确认的体验。Task 9/MC-AT-11 增“旧聊天仍 blocked，新聊天重查后有效 dispatch”的完整旅程。固定无正文 refusal envelope 仅允许有限字面量/无额外字段，避免拒绝本身锁聊天；动态索引仍须投影。 |
| MC-R04 | **closed（收窄保证并保留人审）** | §5 不再声称结构检查可证明自然语言支持充分；duplicates 只允许首尾去空白后原文逐字相等，validator 增完整 InputSnapshot 并核 manifest.inputDigest。related/source_correction 仍明确语义未验，UI 完整原文对照，发布带 semanticValidation=not_performed；工具 get 同时给完整原文/条件，不能仅输出摘要。Task 3/9 补不同 CONFIG 伪 duplicates、错误概括 fixture 和完整原文/超限路径。未知 secret 模式不冒称完整 DLP。 |

最终细化也已复核：Manifest 直接列 `inputDigest`，rootSources 排序后入 digest，API-04..07 各接口映射明确；单个 group 超过 4000 字符时固定 `MC_INPUT_TOO_LARGE`、安全索引及本地 UI 查看动作，不无限要求缩小 groupIds。

## 5. 需求、接口与验收覆盖复核

| 需求 | 主要接口/模块与计划 | 验收覆盖/当前证据边界 |
|---|---|---|
| MC-001 跨会话输入 | API-01/04/05；Task 2/5/7 | AT-01；不要求旧 session 活着、不扫描 transcript；未来合成闭环待执行 |
| MC-002 固定来源/身份 | API-01/02/04/07；Task 2/4/7 | AT-02/04；当前 catalog enabled binding 再核，不只信 registry 缓存；来源摘要不冒充已核事实 |
| MC-003 原文不足 | API-02/03；Task 2/3 | AT-03/04；memory_only 和 user_attested_excerpt 区分，无 Host 原片段接缝假设 |
| MC-004 模型输出 | API-03；Task 3/8/9 | AT-05；覆盖/引用/容量可查，语义仍由完整原文对照和显式发布暴露；模型质量待验 |
| MC-005 发布原子性 | API-06/09；Task 1/5 | AT-06/10；epoch+scopeRevision+head CAS；候选不推进 revision，发布推进；无正文操作重放 |
| MC-006 删除/撤权 | API-02/07/10；Task 4/5/9 | AT-04/07/10/14；原事务级联输入/摘录/候选/历史版本，现存 body 物理清理与晚到阻断均有负例要求 |
| MC-007 共享预算/unknown | API-05/08；Task 6/7 | AT-08/09；所有 purpose 包装同一 Provider；跨库 journal 保守恢复，不许原作业重发 |
| MC-008 实际入口 | API-11/12；Task 8/9/10 | AT-11/14；UI request/poll/review/publish 和 native 手动检索均有路径；Host 门未证前工具禁用 |
| MC-009 scope/CONFIG/出口 | API-01/04/08；Task 2/6/11 | AT-02/12；不同 concrete scope 不合并，CONFIG 漂移拒绝；批准模型、Host/OS 出口仍为运行门禁 |
| MC-010 年度无损 | 原 work_summaries 独立；Task 4/5/10 | AT-01/13；不读写其 collection，原本人贡献/证明/确认/缺证维度保持原身份；逐字节回归待执行 |
| MC-011 索引与共享 | API-06/12；Task 5/9；F03 后置 | AT-11/13；有界本地索引，原共享和 user-only grant 不放宽；不复制跨 share 明细作输入 |
| MC-012 恢复与证据 | API-05/08/11；Task 7/10/11 | AT-09/10/14；取消/卸载未知不释放门、备份当前 authority 门、每层证据独立；全部功能验证待执行 |

局部修改映射保留 MC-001..012 / API-01..12 / AT-01..14，且后置自动召回、年度整理、共享 Agent 索引与 Host/PTC 分别有边界；没有要求整份重做或重问已有产品选择。旧 PF-03b 自动经验流继续原语义，新派生手动批次默认没有把它改成人工逐条审批。

## 6. 最终文件身份与静态核验

| 最终对象 | SHA256（评审者独立复算） |
|---|---|
| `docs/memory-consolidation-design.md`，MC-DESIGN-1 R2 | `914369cf773f9077794c2ad5b50bd58e22ca7f0b6c68b77316293e59f037269f` |
| `docs/superpowers/plans/2026-11-08-memory-consolidation.md`，Spec R2 | `27a5e39fc7e0e8a5533171c7caa996839b045c435f6b5dd531d5fb1f18bc42be` |

实际只读命令包括 `Get-Content`/`rg`、`Get-FileHash -Algorithm SHA256`、本地 Markdown 链接/围栏/控制字符/checkbox 检查、`git -C 05-local-memory rev-parse HEAD/status --short/diff --stat`。最后静态核验退出 0：两份本地链接缺失 0、控制字符 0、已勾选步骤 0；设计 14 个代码围栏成对，计划 55 个步骤全部未完成。当前 tracked diff 为空；设计、计划和本报告是新增文档。其他 UI 新文档属于并行交付，不在本报告评审范围，也未被本评审者修改。

本报告最后写入后又独立复算上述两份哈希，才可将其作为最终身份；本报告自身不放入待评对象哈希以避免自引用封存循环。后续设计/计划若变更，须重核受影响发现与哈希，不能继续引用本快照的关闭结论。

## 7. 结论与实际限制

**设计层不阻断后续实施**：四项初轮 Important 已按上述规则关闭，当前 0 Critical / 0 Important / 0 Minor。具体文件职责、schema/signature 迁移、权限、队列/预算、取消/恢复、发布/删除和工具使用旅程足以组织增量编码与独立验收。

此结论保留四个明确产品/运行限制：首版手动批次与显式发布；原文不足时只整理先前未核验陈述；related 等语义质量并未自动认证；失效工具历史需要新聊天重查。真实 Host 最终门、真实 Provider 质量/费用、OS 出口、迁移/故障及 UI 旅程仍须按计划运行，当前没有新增 PASS、可安装或完整首版完成证明。

**接下来该怎么做：** 根协调者用约 5 分钟核对交付摘要中的设计 R2 与计划 SHA；完成标准是引用本报告的两个最终摘要、四项限制和“全部实现待执行”状态均一致。
