# 本轮产品与软件设计交付索引

2026-11-07。范围：**只确认产品与交付设计，不继续实现**。优先完成04单仓/多仓代码学习，再收束05本地长期记忆。已有用户答复见[集中决定记录](product-decisions.md)，设计默认值不是新的用户确认。

> **2026-11-08实施状态更新（历史设计交付之后）**：05当前为**v0.3.0已安装增量**，M1集成与M2的MEM-201/202/203已实现；现行证据记录318/318组件测试及3/3真实安装库最终门探针。MEM-204、M3冷档、MEM-405模板和完整M4/M5仍未完成；真实业务Provider、真实profile内M2写入、GUI视觉及OS级出口仍未验。入口见[05 README](../05-local-memory/README.md)、[机制说明](../05-local-memory/docs/mechanisms.md)、[M2独立评审](../05-local-memory/docs/m2-independent-review.md)。其他能力按capabilities.json及各自最新证据计进度，不沿用本文件早期“未实现”描述。

## 2026-11-08：05后续设计与面板评审

**后续用户修订优先于本节下方历史结论：**现行产品体验见[MEM-EXP-1](../05-local-memory/docs/memory-experience-contract.md)，采用直观阅读、自动管理、小bar、结论角标与≤100字归因、对话纠正和后台反思。新合成原型为[简化体验](../05-local-memory/docs/ui-review/memory-simple-review.html)，不再等待A/B选择。原R2整理/55步计划的手工选批、显式发布、换会话路径已封存；它们的旧评审与19项原型检查均仅覆盖原物料，不覆盖本次修订。新增合同独立评审和新原型证据另记，不改变v0.3.0代码/已安装profile及33份M2封存物料。

当前设计入口：[简洁体验合同与六项增量待办](../05-local-memory/docs/memory-experience-contract.md)、[独立评审](../05-local-memory/docs/memory-experience-review.md)、[新原型浏览器检查](../05-local-memory/docs/ui-review/simple-browser-check.json)。不改v0.3.0代码、已安装profile或33份M2封存物料，不调用业务模型API、不发布仓库。新增自动化、归因和Host连续性仍待实现。

历史材料：[R2整理设计](../05-local-memory/docs/history/2026-11-08-manual-memory/memory-consolidation-design-r2.md)、[旧实施计划](../05-local-memory/docs/history/2026-11-08-manual-memory/memory-consolidation-plan-r2.md)、[原UI 0.2](../05-local-memory/docs/history/2026-11-08-manual-memory/memory-center-ui-design-0.2.md)，各自保留原字节和旧评审身份，仅参考技术约束，不能执行旧用户旅程。原[设计验证](../05-local-memory/evidence/memory-design-verification.json)只覆盖历史物料；当前修订证据见[简化体验验证](../05-local-memory/evidence/memory-experience-verification.json)。

## 优先两项

| 能力 | 成品与首版方向 | 现行交付 |
|---|---|---|
| 04 Linux驱动/用户态单仓、多仓关系与学习 | Harness对话skill＋Atlas薄适配；组件概览、问题路径、源码证据、本地导航/报告、暂停续读；专用面板后置 | [产品说明](../04-code-learning/docs/product-form.md)；[编码设计](../04-code-learning/docs/software-design.md) |
| 05 本地长期记忆 | Harness记忆中心plugin；经验与年度工作两分区，自动草稿/人工审定报告；多仓、共享abstract、非C冷档、明确删除与项目保留 | [统一待办](../05-local-memory/TODO.md)；[历史产品答复与现行索引](../05-local-memory/docs/product-form.md) |

## 其他六份编码设计

| 能力 | 已确认首版与设计入口 |
|---|---|
| 07 上下文管理 | 首版只读观察组成/来源/用量，手动压缩后续增量：[产品](../07-context-management/docs/product-form.md)、[设计](../07-context-management/docs/software-design.md) |
| 08 工作台UI | Harness内统一工作台，先接05/07，逐项组合：[产品](../08-workbench-ui/docs/product-form.md)、[设计](../08-workbench-ui/docs/software-design.md) |
| 06 本地图示 | 图生成/讲解＋本地可视化编辑首版一起交付：[产品](../06-local-diagrams/docs/product-form.md)、[设计](../06-local-diagrams/docs/software-design.md) |
| 03 会话管理 | 基础管理＋会话回退，文件回退后置；运行中移除/恢复，关闭后永久清理：[产品](../03-session-management/docs/product-form.md)、[设计](../03-session-management/docs/software-design.md) |
| 02 远端环境 | AutoEnv本地MCP＋skill＋任务/日志入口，SSH/Telnet、装包/测试/日志及必要GDB：[产品](../02-remote-environment/docs/product-form.md)、[设计](../02-remote-environment/docs/software-design.md) |
| 01 浏览器与认证 | plugin优先原内置页；不可接通时使用Harness内显示/操作的专用隔离浏览器：[产品](../01-browser-auth/docs/product-form.md)、[设计](../01-browser-auth/docs/software-design.md) |

七份软件设计和05待办均定义实现边界、数据/接口、状态、错误恢复、增量任务、验收及局部修改；详细约束见[设计合同](software-design-contract.md)。文中未来代码/测试/配置路径未创建，不代表已安装能力。

## 固化流程与改进

根[SKILL.md](../SKILL.md)为实际skill入口；按需读取[引导细节](workflow-guide.md)、[设计合同](software-design-contract.md)、[局部增改规则](design-change-policy.md)。每题带简短背景/目的/建议及影响；已明确要求不重问；机制默认值由设计者决定。中途流程改进记录于[变更来源](workflow-changes.md)。

每项目正式实现前说明路线、来源固定版本和逐机制采用方式；完成后按[机制合同](mechanism-document-contract.md)写完整说明，供改进skill。当前阶段文档不替代该最终机制交付。

根skill已通过格式验证，并完成一个全新上下文、只写文档的[合成行为案例](skill-forward-test.md)，观察到高层提问、继承已有决定和局部增改均符合本次目标；该案例不认证真实运行和所有场景。

## 独立评审与运行限制

独立评审：[04/02](design-review-learning.md)、[07/08/06](design-review-surfaces.md)、[01/03及05待办/流程](design-review-browser-sessions.md)。保留原发现与后续复核，不以多个agent赞同替代具体关闭证据。

本轮收口：七份软件设计的Critical/Important设计发现均已关闭；05作为统一TODO交付已独立接受。产品问题按已有明确答复收束，目前没有等待用户补答的产品取舍。最终版本为04 CL-DESIGN-2、02 RE-DESIGN-2、07 CTX-DESIGN-2、08 UI-DESIGN-2、06 DIA-DESIGN-2、03 SM-D2、01 BR-D3；05为MEM-TODO-1。各报告绑定实际摘要，后续改动不能沿用旧字节的评审证明。

评审仅确认设计可编码与范围一致，不认证真实运行。实施前还需固定完整离线构件/许可、重核实际Host、执行真实隔离与出口负例；真实Linux/Kbuild、站点认证、远端协议/GDB和最终模型请求控制仍按各文档门禁验证。允许已批准模型API和登记可信目标，不能额外遥测/同步/托管记忆/远端图示/自动下载。本轮未改H盘项目、Harness profile、真实会话或账号，未调用业务模型API。

当前状态与审查摘要以最终[设计验证清单](../evidence/design-verification.json)及各评审结论为准；未关闭的Important发现不能标编码设计完成。旧05测试和历史调查证据保留原身份。
