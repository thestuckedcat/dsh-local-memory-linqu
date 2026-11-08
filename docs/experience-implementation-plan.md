# 05 体验与后台巩固：实施计划（v0.4.0 增量）

编号 **MEM-IMP-1**，2026-11-09。基线：05 仓库 `fa258ac`（设计文档提交），运行插件仍为 v0.3.0（`d75472f` 的代码与 318/318 证据）。设计依据：[MEM-EXP-1](memory-experience-contract.md)、[MEM-BG-1 修订3](memory-background-plan.md)、[整理设计](memory-consolidation-design.md)（历史技术参考）。本文是开工说明与分阶段实现计划，**不是完成报告**。

## 1. 已核对的 Host 接缝

| 接缝 | 事实 | 用途与边界 |
|---|---|---|
| `agent/status` 事件 | `idle` ⇄ `running`；`agents.list()` 可枚举活 Agent | 后台整理的空闲判定：所有活 Agent 均 idle 且持续 30s 才可派发；未知/断档延后 |
| `agent/turn-stopping` | serial，turn 关闭前 | 读取本轮 assistant 文本，生成/校验引用归因 |
| `agent/pre-step` | 可替换进入下一步的消息 | 现有召回注入；扩展记录本轮候选 |
| `systemPrompt.section` | 有序 prompt section，可返回文本 | 登记记忆引用规则（仅声明采用的记忆） |
| client `conversation.composer.dock` | session 级 list slot，composer 下方 | 小 bar（正在记忆/整理/暂缓），不插入聊天正文 |
| client `conversation.chat.turnTail` | 完成 turn 的尾部扩展，owner props `{turn,seq,openFile}` | 本轮“记忆影响”映射（≤100 码点） |
| assistant 文本渲染 | **没有**可替换 assistant 正文的 slot | 角标只能以文本标记 + turnTail 映射呈现；不能注入 React 内联角标。不伪造“已实现内联角标” |

小 bar 和 turnTail 在当前页面需重载客户端 bundle 才能看到；真实 Host 行为仍须安装级验证。

## 2. 分阶段交付

### Phase A：阅读优先体验壳（本轮首个可验交付）

- 记忆中心默认列表：短标题、摘要、项目/时间、来源方式；状态与高级动作移入详情/次级区域；不改变现有管理 API。
- 新 slot `conversation.composer.dock`：小 bar 显示 `正在记忆 / 正在整理 / 记忆暂缓 / 空闲`，只读 `status`，页面隐藏时停止轮询，失败静默降级。
- `status` 增加 `experience:{phase,queued,running,paused}`；不改现有字段。
- 测试：客户端静态/注册/render smoke；status 管理操作；不调用模型。

### Phase B：结论引用与≤100字归因

- 召回记录条目增加稳定短引用 `记1..记5`；系统 prompt 注册“只有实际采用的记忆才可引用”的规则。
- `agent/turn-stopping` 解析 assistant 文本中的 `〔记N〕`；只接受本轮注入且当前仍有效的记录；生成映射文本，按 Unicode 码点校验 ≤100；超限则缩减采用集合并记录不可用，不截断/漏报。
- 持久化归因（catalog v3 表 `turn_attributions`，session+turn 主键，无正文，记录 memory id/版本/短名/映射摘要）；管理 API `memory.attribution`（只读，用户/模型均可，仅返回本会话/turn 的有效记录）。
- `conversation.chat.turnTail` 展示“记忆影响：…”，点击展开来源；assistant 正文中的 `〔记N〕` 仍为文本标记（无内联 React 角标 slot），在 README/mechanisms 如实记录。

### Phase C：自然语言纠正与后台反思

- 提炼 purpose 增加“用户明确纠正”标记；只有明确指向时可定位旧记录；不确定时暂缓争议内容，不作猜测。
- 纠正先停用旧记录/派生/共享引用，再保存新来源；新增 `memory_reflections` 本地记录（原因分类、证据、假设分开）。
- 后台反思使用受控 purpose，空闲窗口派发；失败/迟到不复活旧值。

### Phase D：自动后台巩固与证据摘录

- content v3 / authority v2 迁移：最小证据摘录（有来源版本、摘要、删除传播），不复制全量历史；旧记忆无原文标“不可回看”。
- 新 purpose `memory_consolidate` + 独立 manifest/权限/预算/队列；沿用 profile dispatch 门；unknown 不重发。
- 自动触发：dirty 10 条或 1h；全 Host idle 30s；每批 ≤5，后台并发 1；前台到达停止后续批次；重启重核来源/授权，旧 lease 无效。
- 派生表示独立于原经验；发布同步事务 CAS；失败保留旧有效表示；不覆盖原记忆，不自动永久删除。
- 管理 API/记忆中心“整理”状态与查看；自动更新导航；不要求用户批次/审核/发布。

### Phase E：冷档与收尾

- M3 非 C 冷档、删除传播、MEM-204 事件代次；不可用时不伪装完成。
- 最终更新 TODO/README/mechanisms/implementation-route，生成 v0.4.0 证据并同步仓库。

## 3. 先做 Phase A 的理由

Phase A 不依赖模型调用或 Host 空闲接缝，是后续小 bar/归因/整理的可见载体；先交付可回退的 UI/状态层，再逐步接入引用、纠正和后台整理。每阶段独立测试、独立证据，不把设计稿当已实现。

## 4. 验收与证据（Phase A）

- `tests/management.test.mjs` 客户端用例覆盖：新 slot 注册、locale 键齐全、render smoke、timer 清理。
- `tests/plugin-entry.test.mjs`/`tests/management.test.mjs` 验证 `status.experience` 形状与只读性。
- `node --check client.js`、全量 318+ 测试、evidence 更新。
- 视觉与真实 composer 位置需页面重载后人工复核，不能以静态测试替代。
