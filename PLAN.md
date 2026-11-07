# 本地长期记忆独立开发计划

> 执行约定：按任务逐项执行失败用例→最小实现→通过验证；独立评审后进入下一阶段。Task 1/2已有组件验收；Task 3作业执行授权已通过独立复审。**2026-11-07：M1已接成v0.2.0可安装插件，本地Node26全量258/258通过、真实安装库`llm/stream`/最终门探针3/3、desktop profile安装验证通过；M2/M3与完整M5仍未完成。** 见[README](README.md)、[实现合同](docs/m1-plugin-design.md)、[完整机制](docs/mechanisms.md)、[独立评审](docs/m1-independent-review.md)；旧阶段报告保留历史快照。

2026-11-04：Task 2组件验收完成，Task 3为下一执行项。[阶段机制说明](docs/task2-mechanisms.md)记录当时真实行为及后续skill改进边界。预先编写的局部后端验证仍隔离于[experiments/sqlite-backend](experiments/sqlite-backend/README.md)，不替代正式验收。正式路线和逐项来源见[开工说明](docs/implementation-route.md)；完整插件完成后按[安装验证计划](docs/shared/live-installation-plan.md)使用用户已授权的Harness和Provider。

**Goal:** 在本地保存和检索有来源的跨会话记忆，并经批准 DSH Provider 进行有预算的提炼/反思。
**Architecture:** 原生 DSH plugin 接会话钩子与 Provider；本地存储/索引适配器复用已锁定的原生记忆实现。先验证 kovey 路线，RestRegular 仅在已确认缺口时对照；不同时挂两个 writer。
**Tech Stack:** Node >=24.9 的离线固定运行时、DSH 0.2.1-rc.5 组合基线、本地 SQLite/FTS、ESM adapter；本地 embedding 和跨 Agent MCP 后置。
**Spec:** [记忆设计](docs/shared/code-memory-design.md) §5—8；[共同约束](docs/shared/development-contract.md)。

## Global Constraints

- 模型 API 可用于提取/总结/反思/去重；本地存储、索引、检索和管理，不接托管记忆。
- 原始秘密不得进入记忆/模型；缺 scope 拒绝，不降 global。队列入队绑定 Provider/model/scope/用途，不扫描其他环境 key。
- 运行时无 Git fetch/push、自动更新、权重下载和未知模型 fallback；词法是首个可独立交付，不依赖向量模型。
- Task 1的正式路径已创建，其他路径按任务交付；experiments不替正式实现。以下命令在本目录，Windows用.\runtime\node.exe；当前只验证Windows，Linux运行物料未准备，不宣称Linux平台测试通过。

## Review Focus

1. A 项目记录不能从 B 的全文/FTS/管理导出或缓存读出 → MEM-01。
2. 入队 A 后切到 B 或 A 超时，不能重选 Provider/盲重试 → MEM-02。
3. forget 后晚到提炼、索引重建和旧备份不能复活正文 → MEM-03。
4. 同一来源被重复提取不能伪装多份独立证据 → MEM-03。
5. 钩子重复注册、卸载或03事件重放不能重复注入/扩大scope → MEM-04。

## Task 1：锁定本地后端与真实隔离存储（MEM-01）

**Files:** Create source-lock.json, package.json, src/backend.mjs, src/scope.mjs, tests/backend.test.mjs, tests/source-lock.test.mjs, tests/fixtures/。
**Interfaces:** openStore(root, {scopeRef}) → 本地 store；put(record)/search(query,{limit})/close()。record 包含 id、scopeRef、sourceRef、sourceVersion、kind、text、state、generation、supersedes；scopeRef 非空且由可信调用方指定。source-lock 记录源码/包摘要、许可、DSH兼容和禁用网络能力。

- [x] 固定候选与离线运行物料；写 source-lock 测试：不匹配摘要/宿主范围必须拒绝，不允许 latest 或启动安装器。运行 .\runtime\node.exe --test tests/source-lock.test.mjs，先确认验证器缺失导致失败。
- [x] 实现本地锁检查；阅读所选包 store/schema 后写薄适配，关闭 sync/远端 embedding，保持来源版本。禁止复制假定的上游私有表结构直接使用。
- [x] 用临时真实 SQLite/FTS 写 MEM-01：A/B 同名项目、空 scope、同仓 worktree 不同版本；对照正文、召回、管理导出均不越界。先运行失败再实现隔离。
- [x] 运行 .\runtime\node.exe --test tests/source-lock.test.mjs tests/backend.test.mjs；断开模型时保存/查已有记录仍工作，真实数据库可重开且数据一致。

## Task 2：受控模型队列与纠错/删除（MEM-02/03）

**用户新增范围：** 已独立评审的[年度工作记忆设计](docs/work-summary-design.md)进入本任务及Task 3。独立work_summaries集合、粗粒度项目/需求/探索记录、受控提炼和证明状态已在本任务实现，不混入普通经验召回；《年终总结维度.md》未提供时仅pending_reference，不伪造标准。提醒、模板映射和正式年度导出留Task 3。

**Files:** src/jobs.mjs、src/provider.mjs、src/lifecycle.mjs、src/store-internals.mjs、src/schema.mjs、src/validation.mjs、src/work-summary.mjs、src/work-summary-evidence.mjs及相应tests/schema已创建；backend/scope同步扩展。
**Interfaces（实际）:** createJobQueue(store,{provider,...})；enqueue({requestId,scopeRef,sessionRef,sourceRef,sourceVersion,fragmentRef,inputRef,inputClass,input,routeRef,generation,purpose,itemRef?}) → job状态视图；runJob(jobId,{timeoutMs,signal}) → 状态视图；store.forget({id,collection?,expectedGeneration}) → 回执；createWorkSummaryManager(store,{evidenceRoots,authorize})。generation为scope epoch，与正文record.generation的revision不同；输入来源/路由不可由模型返回值更改。细节见[机制](docs/task2-mechanisms.md)。

- [x] 写 MEM-02：Provider A 入队、活动会话切 B 仍只用 A 或暂停；错误/超时无其他 key/CLI fallback；费用不明标 unknown。写 MEM-03：用户更正 supersedes、同源重复不增证据、删除后的晚到结果及旧备份被 tombstone 拒绝。先运行 .\runtime\node.exe --test tests/jobs.test.mjs tests/lifecycle.test.mjs 确认失败。
- [x] 加热缓存负例：先search填缓存，再forget/纠正后用同query不可读到旧正文；03来源失效事件到来后旧缓存也不可当fresh。缓存key至少含scope、query、检索策略/索引代次；每条命中仍以权威sourceVersion和generation/state复核，不把缓存存在当作授权或有效性依据。
- [x] 实现本地预算/并发/输入过滤、结构化结果校验与事务写入幂等；超时不承诺恰好一次模型计费，仅在已支持的 Provider 幂等语义下使用其键。
- [x] 实现 generation/tombstone 及 restore 前重放删除清单；权威删除清单独立于可恢复的正文备份，不得随旧库整体覆盖回滚。恢复时先建立权威generation/删除状态，再开放查询和后台提取；清单缺失、损坏或版本未知则拒绝开放。增加旧备份抹掉tombstone、缺删除清单恢复、晚到任务重写的负例。归档、停召回、物理清除和备份窗口分开返回。完整原始会话不作为默认永久存储。
- [x] forget/supersedes/来源失效在事务结果可见前失效相应召回缓存，或在每次返回前按权威generation/state拒绝旧命中；无法完成有效性复核时返回不可用，不回退旧缓存正文。
- [x] 复跑上述测试，验证拒绝模型扩大 scope/路径和假秘密金丝雀。单测只证明适配合同；真实 Provider 行为留集成门。
- [x] 按工作记忆设计实现src/work-summary.mjs、src/work-summary-evidence.mjs及schema/测试；先验证WS-01/02/03/05/06失败，再实现独立collection、来源/事项去重、贡献/结果的自述/待确认/待补证状态及共享预算。人工登记与本地读取不依赖模型，证据存在或用户确认不自动升级support。

实施限定：删除回执只证明当前SQLite正文/索引清除，不是SSD擦除或外部备份撤销；快照restore与旧库reconcile的保留规则分开。崩溃当下running输入不会自动消失，Task 3需确认原worker退出后显式recoverInterrupted再清输入、保留unknown锁；可信结束收据方可解锁，不自动重发。

## Task 3：DSH 原生钩子和本地管理（MEM-04）

2026-11-05启动核对：已重新核安装摘要，并在实际内嵌运行时完成10项隔离库API测试，覆盖Cordis生命周期、LLM prepareCall/终结语义、Agent scope与Session事件。接入清单和必须补强的Host差异见[task3-host-interfaces.md](docs/task3-host-interfaces.md)。尚未加载完整profile、实现正式plugin或调用真实Provider，以下六项不因此勾选；原Task 2全套及物料摘要保持不变。

同日Provider阶段：已实现plugin/harness-provider.mjs及有界终结/清理、activation fence与measureInput，独立设计/代码复审通过。原Node组件新增24项，实际安装库新增8项；Node全85、内嵌全93通过。因固定prompt计数修改了src/jobs.mjs，当前摘要以[Provider阶段报告](docs/task3-provider-review.md)为准；上段“保持不变”只描述先前接口核对阶段。缺inputChars的旧queued拒绝续跑，不透明补算。第二项仅Provider接缝部分完成，钩子/管理等仍待实现，以下六项保持未勾选。

2026-11-06当前消息钩子阶段：实现[session-hooks](plugin/session-hooks.mjs)和queue/store归属快照核验；接受事件冻结后入队、事务前后撤权全回滚、仅claimed与最终enter交集召回、稳定注入和同realm单writer。新增25项单元与8项原生测试；Node110/内嵌126全过，独立复审无阻塞，见[子计划](docs/task3-hooks-plan.md)、[机制](docs/task3-hooks-mechanisms.md)与[评审](docs/task3-hooks-review.md)。当前清单以该阶段为准。真实grant/scope配置、scheduler执行/提交许可及最终projection/dispatch门、03事件消费和管理/年度功能未完成，以下原六项仍不整项勾选。

**Files:** Create plugin/index.mjs, plugin/client.tsx, cordis.patch.yml, tools/smoke.mjs, tests/plugin.test.mjs, tests/network.test.mjs。

2026-11-06执行授权阶段：直接在queue内默认deny，冻结执行lease，经Provider透传覆盖prepare/stream窗口，提交前后复核取消与worker/来源/路由；合法年度merge的自身epoch推进与外部变更分开。unknown晚到不再自动解闸，只有可信结束确认。独立评审发现的取消微任务竞态和合并回归已修复，Node125/Host146及独立125/5/附加3均通过，见[子计划](docs/task3-execution-plan.md)、[机制](docs/task3-execution-mechanisms.md)及[评审](docs/task3-execution-review.md)。真实grant映射、自动scheduler及主对话最终projection仍待实现，原六项保持未整项完成。
**Interfaces:** registerMemoryPlugin(ctx, config) → dispose；consumeCapabilityEvent(eventV1) 幂等标记受影响来源待核；管理操作始终执行与后端一致的scope/版本校验。

- [ ] 用 contract fixture 写重复安装/注入去重、读跨scope拒绝、dispose清理、03事件重复/乱序后可重核的失败测试；不依赖03服务真的运行。
- [ ] 对照已锁定 DSH 服务和所选包实现钩子、批准路由及本地查询/纠正/删除入口；实现一个 writer，面板不接收API key。跨Agent MCP暂不加入首版。
- [ ] 运行 .\runtime\node.exe --test tests/plugin.test.mjs tests/network.test.mjs；网络fixture证明未知endpoint、sync和下载请求被拒，不能仅检查文本无fetch。
- [ ] 创建 smoke 脚本，只对自动生成的临时 DSH_HOME/假会话运行。执行 .\runtime\node.exe tools/smoke.mjs --isolated，保存实际宿主/Provider请求/重启召回/秘密与网络证据。模型质量用合成标注集另测，未经运行不声称效果通过。
- [ ] 验证WS-04/07/08的本地管理、缺证对话提醒（去重/可延后）、更正、版本化维度映射和带引用JSON/Markdown导出；断开模型仍可导出，明确自述/待补证与未知日期，不默默截断，不扫描真实历史或自动取回附件。
- [ ] 完整交付时创建docs/mechanisms.md，按[机制说明合同](docs/shared/mechanism-document-contract.md)说明场景/触发/决策/工具/状态/证据/失败、来源与设计原因、skill可调策略和代码硬边界；由独立评审核对最终机制与实际行为一致，作为后续改skill依据。

## 独立交付与后置项

前三任务通过可独立交付原生记忆；Hindsight/OpenViking、多Agent MCP、本地向量与高级UI只在词法/原生能力明确不足时加。真实历史导入先有范围/数量/预算预览，不因本计划获准全量扫描。

