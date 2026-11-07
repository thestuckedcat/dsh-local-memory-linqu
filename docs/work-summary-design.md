# 05新增维度：项目、需求与问题探索的工作总结记忆

日期：2026-11-04。状态：方案已由另一位独立Agent评审通过；Task 2存储、受控提炼、生命周期及本地证明状态组件已通过测试和[独立代码复审](task2-review.md)，Task 3提醒/管理UI/正式导出待实现。本文件保留已审方案正文，以下“拟/建议”是设计快照；实际差异与边界以[阶段机制说明](task2-mechanisms.md)为准。本文件本身不授权扫描历史、读取真实证明、联网或调用API。原方案评审见[Task 1历史记录](task1-review.md)。

来源是本次用户明确需求：参与的项目、需求、解决或探索的问题先做粗粒度独立总结记忆，用作开发者年终岗位总结依据；可在对话中提醒附证明文档。**不是已借鉴或已合入另一记忆框架的新能力。** 本项目已有底座来源、采用方式和当前阶段见 [implementation-route.md](implementation-route.md)；原计划见 [PLAN.md](../PLAN.md)。

完整机制说明遵守 [mechanism-document-contract.md](shared/mechanism-document-contract.md)，最终随05交付到本模块`docs/mechanisms.md`。本设计给出拟议机制与skill可调点；交付时须按实际代码、行为和证据更新，不以审计日志或版本清单替代完整机制解释。

## 1. 目标与边界

增加独立的 `work_summaries` collection，保存“我参与了什么、想达到什么、本人做了什么、得到什么结论或结果、何时发生、依据是什么”。它是结构化工作记录与带引用的本地导出，不先建设绩效评分、岗位评价、完整报告生成或项目管理平台。

《年终总结维度.md》尚未提供。当前不猜测其维度、评价标准、权重、级别、模板或合格门槛；记录状态为`dimensionMapping.status=pending_reference`。未来拿到指定版本后才做可版本化映射，不能把新维度倒推成历史事实，也不能凭空补“业务价值”“效率提升”等用户未给出的结果。

这项增量落在05的Task 2和Task 3：Task 1现有本地后端及其审查可继续，不以本设计未评完阻断。**05完整插件交付必须包含本增量的持久结构、受控提炼、管理/缺证提醒及引用导出验收；Task 1通过不能视为新需求已完成。**

## 2. 与普通经验记忆分离

普通经验/规则召回默认不读取`work_summaries`；工作总结查询、管理和导出必须显式选择该collection与已批准scope。工作经历不能因“我参与了X”自动升格为跨项目规则；技术经验可另生成普通记忆，但需独立ID、来源引用和正常门控，不把整份贡献叙述重复灌入上下文。

年终依据可以跨项目：首版支持逐scope导出，或由可信调用方明确给出**已批准scope集合**后汇总。授权集合不等于global、all或全历史；每个scope分别校验权限、记录generation和来源身份，跨项目聚合不改写原scope或把同名事项合并。集合含未批准/缺失scope时默认拒绝该次完整导出，不静默少导一个项目。

建议Task 2新增专用`work_summaries`表存放结构化payload及必要身份列，保持Task 1 records语义稳定；表与独立FTS可在后续明确版本迁移中增加，不伪装当前已经存在。scope、来源版本、generation和权威删除机制复用05边界；查询/管理接口、缓存key和导出同时带collection与scope，不能只在UI过滤。正文、引用元数据、FTS、缓存、修订与备份均遵守同一授权。

首版无需embedding、跨Agent MCP、第三方报告服务或批量历史导入。没有模型时，本地人工登记、修正、查询和导出仍可用。

## 3. 最小记录结构

`schema_version=1`。一条记录对应一个粗粒度工作事项；项目、需求和问题探索通过显式引用联系，不因相似标题自动合成一个事项。

| 字段 | 最小语义 |
|---|---|
| `id / collection / scopeRef / generation` | 稳定身份；collection固定work_summaries；scope来自可信调用方，模型不得更改 |
| `itemType` | `project / requirement / problem`；问题可记录exploring/solved/not_reproduced/inconclusive，未解决也能如实留下探索结论 |
| `title / projectRef? / requirementRef? / problemRef?` | 简短标题及已登记事项关联；未知引用留空，不按仓名猜项目 |
| `goal` | 当时目标或问题描述；未知写unknown，不改写为已达成目标 |
| `myContribution` | 本人贡献陈述；不自动把团队结果算给本人，不把Agent完成动作等同用户本人完成 |
| `processOrConclusion` | 粗粒度过程、判断、已排除假设或当前结论；探索与验证分开 |
| `result` | 实际结果、指标或未形成结果；没有测量/交付证据时不补数值、收益、完成或成功 |
| `time` | `start?/end?/observedAt/precision`；工作时间依据与记录时间分开，聊天日期不能推为项目起止日期 |
| `sources[]` | 会话/轮次/用户输入/明确登记文档等sourceRef、sourceVersion、片段锚点；不默认保存完整原始会话 |
| `evidenceRefs[]` | 本地证明引用、显示名、版本/摘要（若已核对）、可访问状态、关联陈述；远端URL仅作为未取回引用 |
| `pendingEvidence[] / pendingConfirmation[]` | 哪个陈述缺什么材料、哪项贡献/时间/结论待用户确认；不能只留一个不明确的“待补” |
| `recordState / createdAt / updatedAt / supersedes?` | draft/active/archived等管理状态；active表示参与本collection查询，不表示事实获证 |
| `dimensionMapping` | 先pending_reference；后续映射存独立版本/源模板引用，不覆盖原始叙述 |

对`myContribution / processOrConclusion / result`分别保存以下断言元数据，防止一份证据把整条记录“全部认证”：

- `basis`：`user_reported / source_observed / inferred / unknown`，写明陈述从哪里来。
- `support`：`missing / unread / partial / supported / conflicting`，以及对应evidenceRef与支撑范围；supported必须有实际内容核对的支持说明，不由文件存在或模型confidence直接产生。
- `confirmation`：`pending / user_confirmed`；用户确认是独立轴，不能把无材料的自述自动标supported。

普通用户自述可先保留为`user_reported + missing/unread + pending`的草稿。用户明确说“这项本人贡献准确”后可更新confirmation，不捏造证据。只有结果中确有数字、单位、基线/测量范围与来源时才保存指标；不强制把每项探索转成数字。

工作日期/归属年度未知或仅有含糊区间时，加入明确的时间待确认项。按年/时间范围查询与导出时，这类记录单列“日期/年度待确认”，不按observedAt或聊天日期强制归年，也不能在过滤阶段悄悄漏掉；时间已确定且范围外的排除数与规则可见。首版只做基于已提供时间的选择与待确认分组，不推断复杂工期或绩效归属。

## 4. 证明引用与事实支持

“有文件”只证明当前引用可访问；“读过文件”只证明处理了该版本内容；二者都不自动证明本人贡献、需求完成或结果因果。测试日志通过可能支持某次测试结果，不证明谁实现；代码提交可能支持某人提交了改动，不自动证明其独立完成整个需求；设计文档可能支持方案存在，不证明上线或性能收益。证据结论必须限定范围。

本地附件只在用户明确提供/登记且在允许路径范围内时读取，先核真实路径、来源版本和秘密边界；不递归扫描目录、不下载URL附件、不自动搜索邮件/工单/历史会话补证。链接未取回、文件缺失、内容未核或无法证明陈述时仍保持missing/unread/partial，明确待补材料。文件变化或丢失后，原support标待重新核对，不能保留“当前已证实”的表象。

缺材料不拒绝登记工作事项，也不反复打断当前任务。可在本轮粗总结确认、用户要求导出或重要结果陈述缺证时提示一次，例如：“这条暂按本人描述记录；如有对应需求/设计/提交/测试结论，请在方便时附上本地引用，便于年终核对。” 提醒说明具体缺的是哪条贡献或结果；同一来源版本/待补项去重，用户暂不提供即可保持待补，不当作材料已存在。用户可关闭或延后同项提醒。

导出时始终保留basis/support/confirmation与缺证清单；只有已获支持的具体断言可显示“该引用支持……”，其余显示自述/待确认/待补证。未补证明文档的记录不能标“已证实”。

## 5. 提炼、合并与更正触发

首版触发只覆盖当前获准对话：用户显式“记一条工作总结/更新这项”，或当前任务到一个已知阶段时提出/形成粗总结候选。模型通过既有批准Provider提炼，输入仅含当前scope与有必要的片段；不为了补齐履历扫描历史，也不自动导入全部Git记录。

持久队列purpose增加`work_summary_extract / work_summary_merge`。入队绑定collection、scope、事项身份、sourceRef/sourceVersion、generation、批准route、输入引用和预算；处理结果不得更改scope/来源身份或把support升级。复用Task 2超时unknown、取消、并发、预算及无未知fallback规则，工作摘要与普通经验任务共享可核对总预算，不另开隐藏无限额度。

同源去重键至少为`scopeRef + collection + sourceRef + sourceVersion + fragmentRef + purpose`；同一来源事件重放、重复点击或模型重复候选不得增加独立证据数。源内容新版本产生修订/替代，不把旧版本当新完成事项。不同来源只有明确事项ID或用户确认归属时才合入；标题相近仅是合并建议，不能跨项目自动合并。

上述为请求幂等键；证据身份另按`scopeRef + sourceRef + sourceVersion + fragmentRef`去重，不含purpose。提取、合并或导出多次引用同一材料，均不能变成多份独立证明。

合并保留多来源引用与断言各自状态；出现矛盾进入pendingConfirmation，不用“最新模型答案”覆盖人工修正。用户纠正本人贡献/时间/结果时提升记录generation并保留supersedes追踪，已确认内容不得被后续自动提炼静默改写。已删除/来源失效的代次、缓存和在途摘要仍受权威tombstone约束，旧备份/摘要重放不能复活。

## 6. 未来《年终总结维度.md》的版本化映射

目前不创建任何假的维度条目。用户提供文件后，显式登记该本地文件、内容摘要、版本与用户给定适用范围；映射记录包含`mappingVersion/templateRef/templateDigest/summaryId/summaryGeneration/dimensionRefs/status`。

一次映射只说明当前事项如何对照该版维度：`unmapped / proposed / user_confirmed / needs_review`。不符合或未覆盖的事项保留unmapped；模板变化只创建新mappingVersion，旧映射保留来源与版本但不再冒称当前。新模板不能自动修改myContribution、result或原有support，也不能倒推历史评分或评级。无模板时导出通用项目/需求/问题分组，标题明确“依据草稿”，不宣称已符合年终标准。

## 7. 拟新增路径、接口及计划落点

以下全部为未来路径，不在本轮创建实现；相对`05-local-memory/`。

### Task 2：持久结构与受控提炼

拟新增：`src/work-summary.mjs`、`src/work-summary-evidence.mjs`、`schemas/work-summary.schema.json`、`tests/work-summary.test.mjs`、`tests/work-summary-lifecycle.test.mjs`及合成fixtures；在后续明确迁移中扩展本地schema，并扩展既有jobs/provider/lifecycle，保持Task 1现有数据合同与验证继续有效。

拟议接口：

```text
saveWorkSummary({requestId,scopeRef,itemRef?,draft,sources,expectedGeneration})
  → {id,generation,recordState,pendingEvidence,pendingConfirmation}
enqueueWorkSummary({scopeRef,itemRef?,sourceRef,sourceVersion,fragmentRef,
                    inputRef,routeRef,generation,purpose}) → jobId
mergeWorkSummary({scopeRef,id,candidates,expectedGeneration})
  → {id,generation,pendingConfirmation}
registerWorkEvidence({scopeRef,id,reference,claimRefs,expectedGeneration})
  → {evidenceRef,accessStatus,supportUnchanged:true}
reviewWorkEvidence({scopeRef,id,evidenceRef,claimRef,assessment,
                   sourceVersion,expectedGeneration}) → {id,generation,support}
```

调用方已绑定scope/collection与来源；draft和assessment须通过schema与依据校验。register只登记引用，不自动下载/读取全文或提高support；review需要已批准材料的实际版本与支持说明，不允许仅传`support='supported'`绕过。query/get/forget/restore用相同scope与生命周期，不另开绕权入口。

### Task 3：管理、缺证提醒与本地导出

拟新增：`plugin/work-summary-panel.tsx`、`src/work-summary-export.mjs`、`src/work-summary-mapping.mjs`、`tests/work-summary-management.test.mjs`、`tests/work-summary-export.test.mjs`；通过本地管理入口接入，不新增公共Web服务或托管报告平台。

```text
listWorkSummaries({scopeRef,itemTypes?,timeRange?,states?,limit,cursor})
  → {items,unknownTimeItems,nextCursor,pendingEvidenceCount,pendingTimeCount}
workSummaryReminder({scopeRef,id,generation,trigger})
  → {show,missingClaims,reason}  # 可延后/关闭、按待补项去重
exportWorkSummaries({scopeSelection:{scopeRefs,authorizationRef},selection,
                     expectedGenerations,timeRange?,unknownTimePolicy:'separate',
                     format:'json'|'markdown',outputRef,mappingVersion?,pageSize?,cursor?})
  → {exportId,localRef,manifestRef,scopeRefs,recordRefs,mappingVersion,pendingItems,
     completeness:'complete'|'partial'|'rejected',totalMatching,exportedCount,
     unknownTimeCount,outOfRangeCount,nextCursor?,truncated}
```

导出只写登记本地输出根；校验generation一致性，禁止越根/软链接、未知scope和秘密原文。JSON保存结构与引用，Markdown按项目/需求/问题列事实状态和证明清单，不补完整绩效叙事、评分或美化结论。证明文档默认只导出引用元数据，不复制整个附件。导出断开模型API也能完成，原始材料不因导出自动发送给模型或其他服务。

单scope用scopeRefs的一项集合表达；多scope仅接受调用方已批准清单，authorizationRef绑定允许范围而非新建隐式授权。逐scope读取前与完成前重核权限/集合与generation，expectedGenerations与recordRefs均用`scopeRef+id`限定，保留每条来源身份，不按裸ID去重。引用不能反向扩展到未批准scope，缓存与分页cursor同时绑定集合摘要、过滤/模板版本和一致性快照；发生撤权、变更或损坏则拒绝完成并要求重核，不宣称跨scope原子事务。

导出不得静默截断：小结果完整输出；超过单次资源预算时分页，并在每个分片和manifest标出totalMatching/exportedCount、nextCursor、未知时间/排除/待补统计及`completeness=partial`。只有同一已核范围的全部分页写出且复核成功后，才生成`complete`清单；中断或无法维持一致性则明确partial/rejected。若无法分页则明确拒绝，不生成看似完整的正文。`truncated=true`必须同时标partial及限制，**不可作为完整年终报告依据**；UI与Markdown标题同样显示“不完整依据”，不能只在JSON藏状态。

## 8. 正负验收（新增工作摘要用例，均未执行）

| ID | 正向完成标准 | 必须拒绝或保持待补的负例 |
|---|---|---|
| WS-01 结构与隔离 | 同scope分别记录project/requirement/problem并重开持久化；普通经验召回不包含该collection；显式批准A+B导出仍保留各来源 | 缺scope、B读A、模型改collection/来源身份、跨scope裸ID碰撞或自动global；将活跃状态冒称已证实 |
| WS-02 触发与同源去重 | 当前对话显式提炼；同源重放仅一个事项修订，证据数不增 | 扫全部历史/仓库、相似标题跨项目合并、Agent工作当本人贡献、同段重复计功 |
| WS-03 来源与证明 | 用户自述可先存待补；登记引用保持support不变；内容核对只支持相应断言 | 文件存在、日志成功或用户确认被自动升级为整条贡献/结果获证；未读/缺失文档标已证实 |
| WS-04 提醒与管理 | 一次明确缺证提示，可延后；更正/冲突可见；未知工作时间单列待确认且时间过滤不漏项 | 每轮重复催材料、强制补文档才能记忆、用聊天日期归年/补项目日期、年度过滤默默漏掉未知时间或编造指标 |
| WS-05 生命周期 | 纠正/删除使热缓存及晚到job失效，旧备份不能复活；跨collection来源删除按登记策略一致 | 自动覆盖人工确认、过期generation写回、只删展示未删索引、旧导出缓存泄漏正文 |
| WS-06 模型/预算/秘密 | 固定入队Provider和总预算，假秘密在输入/结果/日志/本地导出均不可见 | 切Provider漂移、隐式另调摘要API、下载URL附件、输入被模型要求扩大scope |
| WS-07 维度映射 | 无模板时pending_reference；提供模板后按版本映射并保留unmapped | 伪造《年终总结维度.md》标准、模板更新改历史结论/证据状态、自动生成评级 |
| WS-08 引用导出 | 本地JSON/Markdown含逐scope来源/证明/待补及未知时间清单；批准集合的分页manifest计数一致，全页成功才complete；断开模型仍可导出 | 越根、未批准scope混入/被静默少导、过程中撤权/改代次仍报complete、默认复制证明全文、隐藏截断、truncated=true当完整依据、将草稿写成最终绩效事实 |

实施验证落点：Task 2先为WS-01/02/03/05/06写失败行为测试，再加最小持久结构和队列；Task 3验证WS-04/07/08及Host管理入口、提醒去重和带引用导出。独立评审核对真实行为与输出，不能用仅含字段名的测试或本设计代替完成证据。

## 9. 机制说明用于改进skill

用户需要的是完整端到端机制说明，主要用来改进后续skill。最终`docs/mechanisms.md`应按下表，以实际实现填充“场景→触发→输入/决策→工具/状态→输出/证据→提醒/失败”，附固定版本源码与对应测试/安装/API旅程，说明证明了什么、没有证明什么。下列编号是本增量拟议机制ID，正式交付时固定，不增加后台服务。

| 机制 | 场景/触发 | 输入与决策 | 工具/状态 | 输出与证据 | 提醒/失败 | skill可调策略 | 代码/策略硬边界与用例 |
|---|---|---|---|---|---|---|---|
| MEM-WORK-01登记提炼 | 用户显式记工作，或当前阶段适合粗总结 | 先区分工作事实/经验；当前scope内片段，贡献不明写待确认 | save/enqueue；draft，冻结route/来源/代次 | 项目/需求/问题记录及sourceRef | 输入不足保留缺项；模型超时unknown | 何时建议记录、解释和提问措辞、候选展示顺序 | schema、collection隔离、scope/route冻结、总预算；WS-01/02/06 |
| MEM-WORK-02合并纠正 | 同源重放、同事项新信息或用户纠正 | 请求幂等与证据身份分开；跨来源归属不明不自动合并 | merge，generation/supersedes与缓存失效 | 修订关系及保留的来源/支持状态 | 矛盾进入待确认，不覆盖人工确认 | 何时提示合并、怎样解释差异、复核步骤 | 来源去重、跨scope拒绝、CAS/删除账本；WS-02/05 |
| MEM-WORK-03材料核对 | 用户登记证明或请求核对断言 | 引用存在≠贡献/成果成立；只评实际材料版本的支撑范围 | register保持support，review更新断言状态 | evidenceRef、核对理由、支持/不足项 | 缺文件/变更/无因果证据保持待补 | 推荐材料类型、先核哪条断言、复核说明 | 路径/读取授权、秘密过滤、禁止模型自行升级support；WS-03/06 |
| MEM-WORK-04缺证提醒 | 粗总结确认、导出或重要结果缺证 | 按待补项/来源版本检查是否已提醒或延后 | reminder记去重/延后状态 | 一次具体材料提醒，记录仍可保存 | 用户暂不提供就保留待补；不每轮追问 | 提醒时机、措辞、展示/延后策略（在允许配置内） | 不得强制或伪造证明，不暴露其他scope；WS-04 |
| MEM-WORK-05依据导出 | 用户选项目/时间与逐scope或批准集合 | 逐scope权限+代次，未知时间单列；全部分页完整才complete | export，冻结清单/cursor/manifest | 本地JSON/Markdown、来源与完整性计数 | 缺范围/撤权/资源不足明确partial/rejected | 分组、可见字段顺序、复核提示和分页呈现 | 本地输出根、逐scope授权、来源身份、禁止静默截断；WS-01/04/08 |
| MEM-WORK-06维度映射 | 用户未来提供指定维度文件 | 只对已登记模板版本映射，未覆盖保留unmapped | 新mappingVersion，不改事实字段 | 模板摘要与记录代次对应关系 | 未提供维度就pending_reference，变更需复核 | 映射提问、缺口展示、解释顺序 | 不伪造维度/评分，不提升证据等级；WS-07 |
| MEM-WORK-07生命周期 | 更正/删除/来源失效/备份恢复 | 权威generation与tombstone优先，旧任务不得写回 | forget/restore与缓存/引用失效 | 状态/范围/备份窗口及恢复证据 | 无法核权威状态则拒绝开放，不回旧正文 | 如何解释受影响事项、提醒用户复核 | 事务、删除清单、在途拒绝与scope边界；WS-05 |

skill可调内容通过明确调用参数/允许配置（如reminder.trigger、展示分组、候选复核顺序）传递，位置与最终工具schema记录到机制说明；预算策略只能在代码设定的上限内选择。schema、权限、Provider/网络、凭据、代次、删除和事务边界必须由代码/策略保证，不能靠prompt承诺放宽。未来调整skill引用机制ID、规则前后差异、原因与最小回归用例；改变硬边界则作为实现/策略变更处理，不因写了skill自动生效。

机制中的触发决策、数据/状态流、取消/部分完成/恢复分支和来源取舍都要解释；审计仅保留必要ID/版本/状态来支持核对，不能用日志代替这份说明。这些资料不直接修改skill、岗位维度或已批准流程，也不能把一条用户工作记录自动升级为全局行为规则。

本需求属于K1/G/Q的工程增量；没有执行提炼、读取证据或验证实际总结质量。来源明确为用户新增需求，后续模板和证明材料均待提供，所有新增实现与验收均待完成。

**接下来该怎么做：** 用约15分钟以一条合成“参与需求、当前结论、尚无证明材料”的记录审查字段与导出，完成标准是本人贡献自述、待确认结果和待补证明三者不会被合并成“已证实成果”；该动作先由独立评审核对设计，不影响Task 1继续。
