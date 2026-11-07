# Task 2实施细化：持久队列、权威生命周期与工作记录

2026-11-04。沿用已审PLAN、work-summary-design与既有来源，不新增上游依赖。Task 2组件已实现并通过双运行时各61项及独立代码复审，见[证据](task2-evidence.md)、[评审](task2-review.md)及[实际机制](task2-mechanisms.md)。实际Provider桥接留Task 3；本阶段只注入外部调用边界替身，不注册/调用其他模型API。

## 存储和身份

- 正文SQLite升级到schema 2；schema 1仅在显式allowLegacyMigration时、核定旧结构完整后迁移。未知/损坏结构拒绝。新库与升级库采用相同DDL路径。
- 数据根另设authority.sqlite及身份锚文件，保存无正文的scope epoch/revision、记录状态/来源/摘要、来源失效、事件幂等、任务状态和预算。正文快照不包含该账本或队列输入。缺失、身份不符、损坏或未知版本拒绝开放。
- epoch只在删除、更正、归档/来源失效等生命周期变动时递增，任务入队的generation即epoch；revision随正文/召回相关变动递增，用于排序、记录代次和召回缓存；纯队列状态/预算写入不推进它。普通新增不会互相作废同epoch内排队的任务。
- 正文与附加authority使用DELETE journal、FULL同步及同卷SQLite事务。事务回调必须同步；异步模型调用在事务外。每个返回重新核权威身份/记录状态/摘要/代次。缓存仅存ID，绑定scope/query/策略/revision，不存旧正文，事务内不新建缓存。
- forget移除当前正文/索引，启用SQLite core与FTS5 secure-delete并清旧不安全索引，保留无正文tombstone和来源阻断；不承诺介质擦除，也不能撤回已经产生的文件备份或Provider请求。archive停召回但保留本地正文。纠正有supersedes，旧记录停召回。来源失效事件幂等、保守失效，不把跨模块操作假装全局事务。
- restore只接本scope/authority身份的受限正文快照，按当前账本逐条核对后恢复；拒绝导入账本。索引重建先按账本清理失效正文。整个文件系统及全部控制文件被管理员一起回滚不在可证明范围内。

## 模型队列

- 本地持久请求ID与输入摘要，冻结Provider/model/routeRef/routeVersion、scope、source/version、purpose、epoch及会话。队列正文输入有界、完成后清除；authoritative状态/预算保留以阻止旧正文库恢复后重发。
- 凭据来源输入拒绝，文本在入队、返回与落库前过滤；模型输出只接受固定结构，不接受路径、scope、来源或证据认证覆盖。
- 根级共享预算分别约束请求数、输入字符和最大输出tokens（不是货币成本估计），覆盖普通记忆与工作提炼；每会话也限额。未知费用保留已占预算。跨日旧任务不借旧预算在新一天执行。
- 全根并发上限1；独立dispatch_lock带唯一job/token，unknown也保持闸门。超时/取消/传输结果不明在可能发出请求后记outcome_unknown，不重试、不fallback；晚到结果即使返回也不能提交。崩溃当下仍保留running/输入/锁，openStore不自动清理；Host确认原worker已退出后须对相应scope显式recoverInterrupted，才转unknown并清输入，仍不解闸。明确终结响应或可信Host完成收据只能解除对应job/token的闸门，不重试旧请求。
- 请求提交与正文结果在同事务幂等落库；结果写回再次校验epoch、来源未失效、授权路由及运行token。

## 年度工作记录

- 专用work_summaries表和管理对象，不进入普通经验search/list。Task 2实现创建/合并/更正、来源去重、证据引用及受控核对、生命周期；提醒/UI/模板映射与年度分页导出留Task 3。
- 粗粒度project/requirement/problem；贡献/过程结论/结果分别带basis/support/confirmation。模型只能产候选，默认inferred/missing/pending；用户确认与材料支持是独立轴。
- 登记证明只存引用不读取/下载。显式核对只在登记本地证据根和当前可信授权允许时读取有界文本、核版本/秘密/引用片段；支持按材料版本绑定一条断言。get/list也先核当前可撤销授权；材料变化或撤权降为未读/待重核，不拿历史readAuthorized当永久许可。未提供年终维度保持pending_reference。
- 同源请求去重与证明身份去重分开；不同目的重复使用材料不增加独立证据。已人工确认的内容不被模型合并覆盖，矛盾进入待确认。删除/来源失效同样约束工作正文、证据、备份和在途任务。

## 本轮交付和验证

新增真实SQLite故障/恢复、冻结路由、超时晚到、显式中断恢复unknown、预算与并发、非法结果/秘密、工作隔离与证明负例。两固定运行时全套各61通过，独立代码审查已关闭发现；具体证据和未验证边界以所链报告为准。本文件是实施决策概要，不是完整插件或出口认证。
