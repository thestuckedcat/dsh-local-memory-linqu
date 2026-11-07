> 本文件是总工作区 `E:/dsh/plugin/docs/` 中对应文档的副本，便于本仓库独立阅读；文中指向其他能力目录、总工作区根文件或 umbrella 结构的链接在本独立仓库中可能不可用，权威原文以总工作区为准。

# 代码关系与本地记忆：独立方案设计

日期：2026-11-03。状态：`in_review`。范围：用户新增第 4 项代码关系（驱动为主，单仓/多仓）和第 5 项记忆机制的前期调查与设计。无实现、插件安装、私有仓库扫描或真实环境调用。设计角色与独立评审角色分离；本文件不改变已审查的第 1—3 项文件。

完整调查矩阵与源码出处见 [code-memory-research.md](code-memory-research.md)；本文件规定方案、必要适配和验收，不将调查声明改写为实测结果。

## 1. 用户边界与本次许可

USER_PRIOR：Agent 可以通过模型 API 进行记忆提取、总结、反思、去重。记忆存储、索引、检索和管理服务必须在本地；不依赖第三方托管记忆平台。模型调用优先复用 DSH 已配置 Provider，不增加不受控的数据接收方。这个明确许可覆盖此前对本次记忆需求不适用的“额外记忆蒸馏一律禁止”表述；不能据旧表述排除 Hindsight 或 OpenViking。

允许的网络接收方仍只有已配置模型 API 和当前任务明确指定的可信环境目标。记忆模型处理属于本次已授权用途，不等于可任意选择云模型、托管记忆、远端 embedding 或备用 Provider。优先本地 embedding/词法检索；主模型不支持 embedding 时不能自动改用另一家服务。插件遥测、自动更新、模型权重自动下载、公共代码索引和第三方记忆平台均不在许可内；依赖与权重预置离线并固定摘要。

用户已粘贴分享需求，按其明确文字设计；未成功读取分享页面，不把页面标题、主观评分或未取得的内容当作证据。下文候选功能多数来自项目文档，只有源码/发布包与验证证据齐备后才能作准入结论。

## 2. 方案总览

第 4 项推荐分层复用：**clangd/Serena 作编译配置内的符号证据 + DSH 原生 codegraph 作结构导航 + 少量驱动/多仓规则适配**。原生图谱先评 `CC19990113/dsh-plugin-codegraph`，多仓现成工具另评 `optave/ops-codegraph-tool`；不将 Tree-sitter 图或 LLM 生成关系当作完整调用事实。先把符号、引用、候选调用、构建依赖和跨仓协议分别标记，再统一查询。

第 5 项推荐先对 DSH 原生记忆进行短名单验证：**RestRegular/dsh-memory、kovey/dsh-memory、slow-stack/mneme**；以 Provider 复用、项目隔离、可纠错管理和预算证据选取一个。Hindsight 和 OpenViking 保留为增强后端候选，但不能启用默认云端分支；官方 memory MCP、Serena memory 与 qmd 是不同粒度的基线或组成件。此阶段不给未经比较的最终产品选型或主观分数。

共用连接形态：本地服务优先 stdio MCP；DSH 原生插件承担会话生命周期、Provider 复用、受控召回注入和管理 UI；skill 说明代码判断和记忆操作流程。内核代码索引、自动提炼和记忆维护分别运行，禁止“打开项目即执行构建/下载/导入全部历史”。

## 3. 第 4 项：候选与取舍

| 候选 | 公开证据 | 取舍和未证实项 |
|---|---|---|
| [Serena](https://github.com/oraios/serena) | 提供 LSP 语义导航、引用及 MCP，包含 C/C++ 支持 | 首选符号访问候选；C/C++ 应明确使用 clangd 和匹配构建参数，禁止缺失语言服务时隐式下载；原生编辑/命令工具先关闭，不能据通用语言支持推断所有内核语义可解 |
| [CC19990113/dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph) | 原生DSH codegraph/codegraph_index；主调查核实 languages.ts 有C/C++扩展与WASM grammar、本地加载路径 | DSH结构图首审候选，显式索引便于限制范围；多仓联邦、宏/配置和间接调用仍需适配，不能因有C语法就承诺完整驱动关系 |
| [optave/ops-codegraph-tool](https://github.com/optave/ops-codegraph-tool) | 本地SQLite、MCP、多语言关系和显式多仓查询范围 | 多仓备选；`--repos` 能限制查询不等于自动解析跨仓C ABI；远端端点、embedding、native依赖及发布包待完整审计 |
| [johnman/gitnexus](https://github.com/johnman/gitnexus) | registry/group 与跨仓contracts；C/C++支持声明 | 仅参考接口概念。独立评审核实 LICENSE 为 PolyForm Noncommercial 1.0.0，未取得适用授权前不作公司场景实现基底；group提取器当前是HTTP/gRPC/topic，不是自动C ABI、EXPORT_SYMBOL或ops分析 |
| [denzharkov/codegraph-mcp](https://github.com/denzharkov/codegraph-mcp) | Tree-sitter 图、关系查询、影响分析、笔记；Claude 专用安装与 API 代理路径 | 可借鉴图谱及查询；不照搬 installer/hooks/proxy。README 指默认安装会修改 ANTHROPIC_BASE_URL、后台监督代理，语义搜索权重取得也须审计；不是即装即用 DSH 组件 |
| [lzehrung/codegraph](https://github.com/lzehrung/codegraph) | CLI/MCP/库、C/C++ 解析，报告 partial/not_found 和图谱限制 | 图谱层优先比较对象，能否完全离线、依赖及实际驱动 fixture 质量待查；项目也声明不能替代编译器，不能承诺完整动态调用 |
| [dsh-plugin-knowledge-graph](https://github.com/Luke-Yong/dsh-plugin-knowledge-graph) | 主调查读取src/index.ts，当前工具描述限定TS/JS/Python | 不作C/C++驱动首选；默认目录发现可能含兄弟目录，必须改为登记根，不能直接在私有工作区启用 |
| [Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail) | 可视化源码浏览；官方仓库已于 2021-12-14 归档 | 可作交互参考；不把已归档项目当作活跃维护的新主线，也不能把“本机GUI”误称成已有 Harness MCP |

[clangd 官方编译命令说明](https://clangd.llvm.org/design/compile-commands)明确解析依赖 include 路径、宏、语言模式和目标参数；缺失这些会造成错误解析。由此推断：驱动项目必须先固定构建变体，才能解释图谱的有效范围。

驱动平台尚待用户确认。下文 Linux Kbuild/CONFIG/Module.symvers/ioctl 是验收设计的条件示例，不是假定所有项目都用 Linux；若为Windows WDK或RTOS/固件，替换对应构建数据库、配置与ABI/协议证据，保留身份、关系分级和跨仓版本原则。

## 4. 第 4 项：数据模型与可信边界

### 4.1 单仓索引前置条件

REQ-C01：每个索引 snapshot 必须关联 `repo_id`、Git revision、dirty 文件摘要、构建变体、体系结构、toolchain/clangd 版本、compile_commands 摘要、内核配置及生成头文件身份。不能只用目录名或符号名字作全局 ID。索引与当前工作树不匹配时显式标 stale，禁止悄悄使用旧行号作修改依据。

REQ-C02：获取 compile_commands 只能使用已有产物或用户批准的生成命令；读取 compile database、项目配置或服务器仓库不授权执行其中的程序、构建脚本或插件。query-driver 等可执行工具链探测需固定允许路径，clangd 远端索引、debuginfod 和网络扩展默认禁用。分析环境隔离、路径只读、无网络下载。

REQ-C03：缺少宏/配置/生成头或编译参数失败时仍可返回文本/语法候选，但要降级并说明遗漏；不得给“无调用方/无依赖”的确定结论。声明、定义、词法引用、直接调用、间接候选、编译/链接依赖、运行观察为不同关系类型。

### 4.2 驱动关系层

| 关系 | 可用证据 | 明确不能自动证明的部分 |
|---|---|---|
| 直接符号引用/调用 | 编译配置内 AST、clangd definition/reference、源位置 | 未编译的 CONFIG 分支、运行时是否实际执行 |
| 宏生成入口/注册 | 宏定义和展开来源、注册点源码 | 单纯正则命中不等于实例完整或变体都启用 |
| ops/回调/函数指针 | 结构体类型、初始化赋值、注册/调用点，必要时数据流或动态证据 | 不能把同名函数/字段全部连成已证调用；未覆盖运行赋值时保留候选集合 |
| 模块符号 | EXPORT_SYMBOL*、Module.symvers、Kbuild/链接产物与模块版本 | 导出不等于已被某模块调用，符号存在不等于 ABI 匹配 |
| 中断/workqueue/定时器 | 注册点、处理函数、结构体归属及排队位置 | 时序、设备/硬件触发、并发发生性需要目标证据 |
| ioctl/用户态到内核 | 共享 UAPI、命令值、结构体布局、兼容分支和驱动入口 | 一端声明不能证明另一仓实现版本一致；需追踪 32/64位 compat、对齐、字节序 |
| 固件/设备协议或 DMA | 协议版本、描述符布局、寄存器/队列写入位置、目标 trace | 不能从跨仓名字相似推断真实传输或硬件行为 |

REQ-C04：每条边包含 `kind`、`source_evidence`、文件摘要/源码范围、snapshot/variant、分析器及状态 `observed/compiled/syntactic/inferred/unresolved`；状态说明证据类型，不是给所有边编造概率。LLM 解释与人工注释不得升级为编译或运行事实。

调用关系还必须定位到 call-expression 及已绑定的调用目标，或明确的运行调用事件。definition/reference 只证明定义或引用；函数地址赋给ops字段、取地址、类型引用均不能直接生成已确认call边。间接调用缺绑定证据时保留候选，不以compiled标签掩盖关系类型差异。

### 4.3 多仓联邦

REQ-C05：以显式 workspace manifest 登记各仓根、repo_id、revision、分支/dirty 状态、构建变体、依赖版本和共享接口。不得扫描未登记目录、遍历私有网络仓库或自动 fetch。linked worktree 可共享仓库身份，但索引必须区分 revision 与 dirty 内容。

REQ-C06：跨仓身份先由符号/头文件/库版本/导出符号/接口 ID 建立候选，再由构建清单与协议证据确认。路径映射只能映射登记根，不得用 basename 猜测或允许 `..`/软链接跳出范围。同名仓和同名静态符号不能合并。

REQ-C07：manifest 必须标明分析范围与未纳入仓库；图谱只说明“登记范围内发现的关系”。跨仓缺源码、生成接口或版本冲突时返回 unresolved。支持按仓独立增量索引，聚合查询保留各自 snapshot，不强迫把多个仓复制成一个虚假的 Git 仓。

### 4.4 工具形态与最小接口

| 接口 | 返回要点 |
|---|---|
| `code_status(workspace_ref)` | 已登记范围、snapshot、variant、覆盖率计数、失败与stale |
| `code_symbol(query, repo_ref?, variant_ref?)` | 候选符号完整身份、定义位置与证据类型 |
| `code_relations(symbol_ref, kinds, direction, depth, budget)` | 有界边集合、每边来源、遗漏和 unresolved |
| `code_impact(change_ref, workspace_ref)` | 编译可确认影响与待核候选分开，不把可达性当测试全覆盖 |
| `code_evidence(edge_ref)` | 当前源码摘要/范围、索引版本与复核步骤 |

这是适配器合同建议，不声称候选已提供这些同名工具。DSH UI 图谱可后置：首阶段只提供带证据的结构化查询，避免为大图画得漂亮牺牲判断准确性。

## 5. 第 5 项：真实需求矩阵

| REQ | 必须满足的能力 | 验收目标；具体数值在 fixture 试验前冻结 |
|---|---|---|
| M01 本地服务 | 存储、索引、检索、管理均本地，离线依赖预置 | 断开模型API时仍可列出/编辑/查已有记忆，无托管平台依赖 |
| M02 模型处理 | 提取/总结/反思/去重允许，优先复用 DSH Provider | 记录来源Provider、模型、用途、token；拒绝未知备用接收方，失败不回落到其他Provider |
| M03 自动写入 | 有价值结论可自动提炼；事实/用户偏好/项目决策分型 | 关联来源会话/轮次/证据，候选与已确认项可区分；不是全量聊天永久复制 |
| M04 自动召回 | 新会话与相关任务自动召回，正文按需读取 | 相关性、噪声、漏召回、重复注入与token开销可测；失败不阻塞主任务 |
| M05 预算 | 提炼频率/并发/token/时间与注入上限受控 | 不因反思递归再触发自身；取消、重启恢复、队列上限和费用可见 |
| M06 隔离 | 项目、用户、会话/global、必要多仓范围显式区分 | 无跨项目默认泄漏；任何全局晋升显式规则与记录，路径同名不串库 |
| M07 纠错遗忘 | 编辑、合并、冲突、失效、归档、删除可管理 | 用户纠正优先，版本替代可追溯；删除同时失效索引/缓存/镜像，不能下次自动复活 |
| M08 追溯 | 记忆附来源、时间、版本、repo/snapshot适用范围 | 旧代码决策跨版本使用时标过期/待核，不当成现状；模型生成内容不是实测证据 |
| M09 管理 | 可视化或可用本地管理入口、导入导出备份恢复 | 能知道记住了什么、为何召回、成本多少；历史敏感数据不外传 |
| M10 秘密保护 | 密码/token/cookie/私钥不入记忆或模型请求 | 输入前剔除、工具输出过滤、金丝雀覆盖错误/日志/备份；无法判定则不自动存 |

用户未明确个人记忆与项目记忆的优先级、保留期限、global 默认开启策略和预算数值；这是配置基线待决项，不应伪造成已确认需求或无限扩张研究。

## 6. 第 5 项：候选事实核验与选型分支

| 候选 | 文档可确认能力 | 主要准入工作/定位 |
|---|---|---|
| [RestRegular/dsh-memory](https://github.com/RestRegular/dsh-memory) | 主调查实时manifest0.30.1，可重建source；JSONL、本地向量或词法降级、作用域、自动召回、版本去重、面板与审计 | 原生召回/管理短名单；自动提炼及Provider复用尚未取得完整实现证据，不能据贴文排名当首选全能力方案。关闭/移除GitHub/HF镜像/Modelscope及自定义URL下载；多进程锁与完整遗忘须测 |
| [kovey/dsh-memory](https://github.com/kovey/dsh-memory) | 0.3.2；项目/global分层、自动召回、有界蒸馏、Markdown+SQLite、FTS5；源码distillModel空沿用agent Provider | 优先验证自动提炼+Provider复用；无repo会降global、cwd缺失有process.cwd回落，须改为明确scope或拒绝；剥离memory_sync fetch/rebase/push。同仓worktree共享记忆须附版本隔离；安装版rc.5兼容声明需实测 |
| [slow-stack/mneme](https://github.com/slow-stack/mneme) | 实际插件0.10.0，根0.0.0只是壳；SQLite+Markdown镜像、自动总结/autoDream、冲突队列、面板 | 原生短名单；源码默认embedProvider=openai、scopeEnabled=false、strictScope=false，不符合目标默认。须固定本地embedding或词法、强制scope隔离、验证Provider路径；运行时供给/下载离线封闭 |
| [qwert702/dsh-memory](https://github.com/qwert702/dsh-memory) | 2.1.0；项目/global、本地JSON、自动提取/注入/巩固、图形管理；源码提取Provider空随会话、manage回落extract配置 | 保留备选；声明适配0.2.0/rc.2，需验证现装rc.5；embedding默认启用且transformers可首用下载，需预置或禁用；公开lib来源与构建可追溯性待核验 |
| [Hindsight coding-agents](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | DSH集成、retain/recall/reflect、项目知识页、本机daemon或自托管 | 增强后端候选。文档默认cloud且autoUpdate开启；daemon首次下载并独立选LLM，必须显式本地后端、固定构件、关闭更新、禁止环境凭据/CLI回退。不能原样安装 |
| [OpenViking](https://github.com/volcengine/OpenViking) | 本地可自托管context服务、分层摘要、会话提炼、可浏览记忆；另有托管版 | 增强后端候选。自托管需要embedding与VLM，须本地embedding与Provider适配、禁托管服务/URL导入下载。127.0.0.1:1933只代表一段服务入口，不证明下游模型/存储本地 |
| [官方 memory MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | 实体/关系/观察，源码JSONL及stdio | 小而可审查的持久存储基线；不是已完成自动提炼、预算、冲突管理产品，可做薄实现底座而非冒称功能齐全 |
| Serena memory | 主项目声明长流程记忆能力 | 若只要开发笔记可减少组件；自动提炼、管理、隔离等完整需求尚未证实，需核实具体API/文件语义 |
| [qmd](https://github.com/tobi/qmd) | 本地文档检索CLI/MCP，作为记忆文档检索候选 | 不等于完整记忆生命周期；模型权重、平台依赖、自动下载与管理面另审，不能用“all local”替代动态证据 |

README 声称的测试数量、评分、性能提升不作为本环境证据；以上未完成全量源码/依赖/发布包审计，动态branch不是交付版本锁定。

本轮协作源码证据（只读抽查，不代表全量审计）：

- `CC19990113/dsh-plugin-codegraph/packages/tree-sitter/src/languages.ts:392-426` 定义C/C++扩展与grammar；`grammar.ts` 本地require.resolve加载。
- `kovey/dsh-memory/src/learn/distill.ts:89-96` 从显式配置或agent.options解析provider/model，`:196` 调用llm.stream；`src/scope/resolver.ts:54-75` 有global/cwd回落；`src/sync/git.ts:203/222` 有fetch/push路径。
- `slow-stack/mneme/dsh-mneme/lib/config.js:367/903/911` 的embedding与scope默认值需加固；不能把默认加权召回当硬隔离。
- `RestRegular/dsh-memory/source/memory-local/src/embed-install.ts:53/71-73` 包含运行时/权重下载源；store.ts 的删除记录和向量更新只能证明部分遗忘路径，备份/journal与自动重导入仍须测试。
- `johnman/gitnexus` 调查快照 `13abf192e06d8ebdbbd5403aec7457a732cca68b` 的 `group/sync.ts` 注册HTTP/gRPC/topic提取器；LICENSE的非商业条件与是否适用须单独确认，不能默认为MIT/Apache许可。

确切路径、行号和manifest均对应调查时版本；执行前锁定commit、构件与依赖摘要，不能把缓存README版本当作实时发布包。

## 7. 第 5 项：架构、Provider 与生命周期

```text
DSH会话事件（只取获准片段）
  → 本地敏感过滤/范围/预算检查
  → 记忆候选队列
  → DSH Provider适配 → 既有模型API（提取/总结/反思/去重）
  → schema/来源/版本/冲突校验 → 本地事实库 + 本地索引 + 本地审计

新请求 → 本地scope过滤 → 词法/本地向量检索 → token预算/版本去重
  → DSH受控上下文注入 → 当前任务模型API

本地管理UI/工具 → 编辑/失效/归档/删除/导出 → 所有派生索引一致失效
```

REQ-M11：Provider适配在入队时绑定获准的provider/model、scope、请求用途、来源会话及调用上下文，后台执行不得按当前活动会话重新选择路由。任务A入队后用户切到Provider B，只能继续使用原批准A或暂停等待路由重核，不能自动漂移到B或其他fallback。不复制API密钥进记忆配置、浏览器、日志或模型工具参数；共享后端不得扫描环境变量自行选OpenAI/Anthropic/其他CLI。请求用途memory_extract/reflect/dedup纳入预算与费用；配置变更暂停或重核，重核也不得换成未批准接收方。

REQ-M12：Hindsight/OpenViking若不能直接复用Harness Provider，有两个可评审分支：① Agent经既有Provider生成结构化候选，本地后端只存检索；② 由受认证回环适配器将特定后端模型请求转入批准Provider。第二种必须证明API能力、身份归属、限额、取消、密钥保护和无额外接收方，不能只填相同URL就宣称完成复用。若后端强制独立embedding/VLM端点而不能满足边界，则选择词法/本地模型分支或不采用。

REQ-M13：记忆写入使用稳定ID、版本、来源会话/turn、证据引用、适用repo/variant、state和supersedes。用户纠正产生替代记录而非静默覆盖历史；冲突候选不得自动提升为全局硬规则。规则与用户指令有层级，记忆视为不可信资料，不能在召回时取得更高权限或执行其中命令。

REQ-M14：session_end 与原始会话删除是不同动作。默认保留经过提炼的跨会话记忆，但管理入口应允许按来源删除/失效。真正删除覆盖正文、索引、向量、缓存、镜像与导出队列；同步递增删除generation并保存不含正文的tombstone，拒绝在途提取/去重的晚到结果重新写入。备份恢复必须先重放有效删除清单，再开放检索/导入；旧备份不得复活被删除来源或版本。备份保留/清除期限明确展示，不能承诺已发送到模型的历史请求能由本地删除撤回。源会话重读或索引重建不得复活遗忘条目。

REQ-M15：本地入队和写入幂等由事件游标、内容版本、request_id及事务/实证锁维护；模型请求超时可能已在服务端完成并计费，应记录outcome_unknown，不盲目重试或承诺恰好一次计费。只有Provider明确支持时才传其幂等键并依其语义恢复；重试有上限和明确规则，费用记录可核对，无法确认用量时标未知。本地重复响应不能产生重复记忆，可恢复队列不得保存秘密。召回、蒸馏、备份失败分别可见，且不损坏主会话；后台维护不得无限阻塞退出或跨scope写入。

REQ-M16：单独命名工具或只选一个writer，避免多个插件争抢memory_save等全局名称及多路重复注入。初次启用不自动导入全历史/全部Git提交；导入范围、数量和模型处理预算先预览，用户有明确批次控制。导入仅从登记本地路径，不跟随不允许的URL/软链接。

## 8. 验证、决策与分阶段交付

| TEST | 对象 | 可观察完成标准（本轮均未执行） |
|---|---|---|
| CM-01 离线与出口 | 所有候选 | 固定包/权重/依赖离线启动；所有进程网络仅主模型API或指定可信目标；无云记忆/更新/下载/telemetry；被阻断尝试也查来源 |
| CM-02 驱动单仓fixture | C01-C04 | 宏与CONFIG两个变体、ops指针赋值/取地址与真实call-expression、导出符号及缺头文件：引用不伪装调用，确认关系/候选/未覆盖分开，不能把候选伪造已证关系 |
| CM-03 多仓fixture | C05-C07 | 用户库/UAPI/驱动三仓、同名符号、不同revision、dirty和路径映射：不串身份，版本不匹配返回未确认 |
| CM-04 时效与资源 | C01/C07 | 改代码/宏/头或manifest后旧索引stale；增量更新不遗漏删除；输出有截断，超限/取消不伤主任务；记录索引耗时/内存而非先许诺性能 |
| CM-05 记忆生命周期 | M03/M07/M08/M14 | 保存→重启→召回→纠正→冲突→遗忘/删除；在途模型结果晚到、索引重建、旧备份恢复及源重新导入后均不复活；来源与版本可追溯；旧代码结论标过期 |
| CM-06 范围与注入 | M04/M06/M13/M16 | 两项目/多worktree/子代理/恶意记忆及同名工具：不越权召回写入，不把内容当指令，无重复正文膨胀 |
| CM-07 Provider及预算 | M02/M05/M11/M12 | 提取/反思/去重均经批准Provider；A入队→活动会话切B→只走绑定A或暂停；变更/故障/取消不探测环境中其他key或备用服务；队列/日预算/请求量/token可核对 |
| CM-08 秘密与管理 | M09/M10 | 假秘密在提取前过滤，工具/日志/镜像/导出不漏；UI只本机受保护；备份恢复一致且不暴露密钥 |
| CM-09 对照效果 | M03/M04 | 冻结人工标注的小任务集：无记忆与候选同模型比较命中、噪声、纠正次数、token和延迟；不引用厂商分数替代结果 |

实施阶段建议：① 固定候选源码/构件与编译环境；② 无私有数据的驱动fixture比较Serena/clangd和图谱；③ 以同一记忆任务集比较RestRegular、kovey、mneme；④ 若原生插件缺少明确必需能力再比较Hindsight/OpenViking本地后端；⑤ 用户批准design/spec、范围、预算后才接真实仓库/历史与运行任务。两项可独立交付，不能因图谱完成宣称记忆已通过。

记忆验证顺序优先kovey的自动提炼/路由与预算，再对照RestRegular的召回管理；原生方案无法满足已确认需求时再深入Mneme/Hindsight及OpenViking。候选使用隔离临时profile逐个比较，不同时部署多个writer或重复注入链路，不以比较名单表示要全量安装。

方案评审应分别给架构方向与部署准入状态；本设计不自判PASS。关键未知包括实际兼容性、完整数据流/构件审计、Provider复用接口以及fixture效果。需求输入已足够做方案设计，不能再以分享链接未读取阻止本轮设计；参数与比较结果仍待验证。

知识定位 K1/G/Q：目标是辅助驱动分析和减少跨会话返工，不是扩展课程。

**接下来该怎么做：** 用约 30 分钟设计一份不含私有代码的最小验收fixture，覆盖两个CONFIG变体的ops调用、跨仓ioctl和一条被纠正的记忆；产物是一张“预期确认/候选/未知关系及纠正后应召回内容”表。用户预测、实际执行和效果比较均待完成，先预测再验证。
