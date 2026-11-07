# Task 2独立代码与机制复审

日期：2026-11-04。实现：`/root`；独立审查：`/root/memory_task2_review`。审查者只读，不改实现、不安装、不调用业务API。无Git基线，按真实源码、测试行为及SHA256固定范围。

## 代码结论

**Task 2组件通过独立复审。** 最终没有未关闭的Critical、Important或Minor；受控队列、删除恢复和工作记忆可进入Task 3适配。不是05完整plugin验收，也不是实际Provider/Host/UI/出口认证。

审查者独立运行Node26正式全套61项，61通过、0失败、0skip，约16.54秒；另读主代理Host24的61项TAP，未将其称为自己独立执行。除正式测试外，审查者在真实临时资源上重验未知执行锁、旧正文输入恢复、事项身份、合并幂等、证明撤权后的零内容读取、FTS当前字节和日期冲突。主代理两运行时最终输出见[验收证据](task2-evidence.md)。

## 发现及关闭

| 编号 / 初始级别 | 问题 | 最终修订与独立复核 |
|---|---|---|
| T2-01 / Important | 超时后job不再running，但远端可能仍在执行，新任务可越过并发限制 | authority根级dispatch_lock跨scope/重启持久化unknown；只接受对应终结响应或可信Host证明；外scope/旧token不能解锁新owner |
| T2-02 / Important | 生命周期变化及旧正文文件恢复可能保留已失效排队明文输入 | advance统一清旧epoch输入、queued转stale；reconcile只留当前epoch的有效queued/running输入；全库旧文件恢复反例通过 |
| T2-03 / Important | 默认工作ID随sourceVersion变化，重复计算同一事项 | 稳定sourceRef+fragment锚；同一锚新版本须明确merge/correct；多锚需显式itemRef |
| T2-04 / Important | 仅SQLite core secure_delete仍留下FTS影子段词条 | FTS5 secure-delete同时启用，旧策略首次重建；热策略失效拒绝；影子块/当前DB字节及legacy迁移反例通过 |
| T2-05 / Important | 历史readAuthorized可能在撤销后仍驱动证据读取 | get/list先查当前可信authorize再碰内容，默认deny；撤权时降unread，独立内容读取计数为0 |
| T2-06 / Important | 合并时不同日期未明确保留，可能吞掉矛盾 | 日期及goal/关联字段进入candidate conflict，确认原值保留；具体模型日期也需明确确认 |
| T2-07 / Minor | 重复相同工作合并仍推进epoch/revision，打断其他工作 | 相同来源和候选为no-op，状态版本保持不变 |

另外核对session_removed空affected_refs边界，最终用session_ref与受影响引用并集失效；已关闭。主代理收尾反例发现带引号值中的秘密赋值漏判，已先红后绿改为不消费分隔符的扫描，并区分明确结束的非法Provider响应与传输结果不明；最终61项及审查均包含这些字节。

## 固定最终实现

以下10项由审查者报告摘要，并由主代理在冻结后逐一重算一致；其他实现、测试、schema及物料摘要见[完整清单](../evidence/task2-verification.json)。状态/说明文件的后续勾选不冒称由实现摘要覆盖。

| 文件 | SHA256 |
|---|---|
| src/backend.mjs | `3dfca144e7099c19e8dd7112646c0bf3bd68366b99c116fe3c360172802eb187` |
| src/jobs.mjs | `e7a5846ae2b2ee7a7f200ad7fabfaff0b4773902f3ba9827f0d5d539c53669ca` |
| src/lifecycle.mjs | `49e1762b80e58310e3739358376eb3f5b57da6de73a7c353ff9b380c87d19e20` |
| src/provider.mjs | `24acda11f39fd1101548e7ba04b6ce07ad6b97d0e9bc74af5264268fb1d1003a` |
| src/schema.mjs | `e1e505538339eba17d2a27c3deb150fccefdd84b20c9983f6dd850c134676c02` |
| src/scope.mjs | `80c65e8271579953eaed5f19533508511cddb7002f4a5ec91c046126f01da4da` |
| src/store-internals.mjs | `45f252a7403cb4f2b0b90d341195a5a173bb3b9c3689e2e794643053b7499052` |
| src/work-summary.mjs | `ddbff1df54337e9b7978a7520e3d488911a2223895d0a332c18561a7b01f8b10` |
| src/work-summary-evidence.mjs | `262c5a2d9b6eda3cd6c914ad9df3ed9de6d9992f6a700bccc844724186966488` |
| tests/work-summary.test.mjs | `55d29b3aa250a885a457c13a51c3987e58b3146f69dae4e59464af43882791dd` |

## 机制说明复核

[Task 2阶段机制说明](task2-mechanisms.md)与[实施概要](task2-implementation.md)已单独复审通过。审查初稿指出1项阻塞表述和3项精度问题，全部关闭：

- 崩溃不自动转unknown/清输入；openStore仍保留同epoch running输入和锁，须Host确认原worker退出后显式recoverInterrupted，再清输入但仍不解闸。
- revision只随正文/召回相关变动递增，纯队列状态与预算写入不推进它。
- 官方snapshot restore只收active同版本；旧正文reconcile可保留同版本archived/stale，但不召回，不能承诺所有非active正文都清除。
- 会话额度按(scope_ref,session_ref)累计，不是跨scope的同session全局额度。

最终两份文档无剩余阻塞或非阻塞问题。审查者提供的最终SHA256为：task2-mechanisms.md `38799a11fd80e72f62a9477c31fb64f71a3e20daa5145cdf859aa076ed112f3e`；task2-implementation.md `d397d763e10c8e1a4ad66187a7f0b28e21d5cb6fdcfb8090752a29507d4d6acf`。文档轮未重复运行未改代码的测试。完整05的docs/mechanisms.md仍待Task 3实际Host旅程完成，不能以本阶段说明冒充项目交付。

## 后续适配约束

实际Host/Provider、当前可撤销授权、unknown恢复的可信完成收据、真实出口与junction/盘型准入、提醒/模板映射/年度分页导出及模型质量仍待验证。默认deny回调不得被替换成永远true；不得用当前epoch替换旧UI预览token；结果引用不等于恢复后正文仍存在；未知执行闸门不得通过重启或盲重试绕开。管理员全部控制文件回滚、介质擦除与模型端计费不在本组件承诺范围内。
