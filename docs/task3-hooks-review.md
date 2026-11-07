# Task 3当前消息钩子阶段验收与独立复审

日期：2026-11-06。**当前窄组件通过独立验收，无未关闭Critical/Important项。** 范围为`plugin/session-hooks.mjs`、queue/store归属快照接缝及当前事件/召回测试和机制说明。Task 3整体仍在进行中，本阶段不是可安装的完整DSH插件。设计由`/root/design`完成，主代理实现，`/root/memory_task2_review`完成最终独立复审。

## 运行结果与范围

| 验证 | 实际结果 | 证据与限制 |
|---|---|---|
| Node26.13.0正式组件 | 110通过，0失败/取消/skip/todo，exit0 | [TAP](../evidence/task3-hooks-node26.tap)；原85项加25项hook测试 |
| Harness内嵌Node24.21.0 | 126通过，0失败/取消/skip/todo，exit0 | [TAP](../evidence/task3-hooks-host24.tap)、[回执](../evidence/task3-hooks-host24.json)；同110项加原Provider8项、新hook8项安装库测试 |
| 新增Host源码物料 | 7/7与实际固定ASAR及manifest逐字节一致，exit0 | [核对回执](../evidence/task3-hooks-source-proof.json)，命令`.\runtime\node.exe tools/verify-hook-sources.mjs`；证据副本不作运行依赖 |
| 独立Node26 | 全110/110，14.58秒；新增重入断言后另跑25/25，2.72秒 | 独立审查者实际运行和最终结论；未将主代理结果计作独立结果 |
| 独立原生hook | 最新8/8，子进程1071.08ms，exit0 | [TAP](../evidence/task3-hooks-native-independent-review.tap)、[回执](../evidence/task3-hooks-native-independent-review.json)；绑定最新源码SHA，另含真实surface保持一次的独立证明 |

组件命令为`.\runtime\node.exe --test --test-reporter=tap --test-reporter-destination=evidence/task3-hooks-node26.tap tests/*.test.mjs`；宿主命令为`.\runtime\node.exe tools/test-session-hooks.mjs`。后一工具先校验exe与ASAR固定摘要，再以最小环境、隔离DSH_HOME和Node网络守卫运行，`windowsHide:true`，没有打开应用UI。

原生测试使用真实Cordis Context、SessionStore、AgentRegistry、LLM/SDK和实际fiber清理，但agent是合成subject，没有运行完整AgentLoop；adapter、授权回执、scope配置均为替身。只有单独测试驱动显式执行一个`runJob`连接既有Provider桥接，hook本身不调度模型。网络守卫只覆盖指定Node API，不能证明整个Host/Chromium/原生模块/其他进程无外发。没有读取真实profile、凭据或调用已注册业务API；回执false字段依据已审调用路径，非全系统监测。

## TDD、发现与关闭

初始19项在组件缺失时全部失败，保留[初始红灯TAP](../evidence/task3-hooks-red.tap)。后续补充容量/累计长度/TTL、render上限、缓存淘汰、安装失败清理、Promise观察与硬上限，共25项。不是所有后加反例都在初始红灯文件中；下面注明实际观察到的失败。

| 编号 / 来源 | 问题与实际表现 | 修订和关闭依据 |
|---|---|---|
| SH-01 / Important，独立hooks_review | 将两个`ctx.on`放在同一个push参数列表；第二次注册抛错时，第一个off还未登记，残留一个监听 | 顺序注册并立即存off；主代理及独立接替审查确认部分失败零监听、owner释放、可重新安装 |
| SH-02 / Important，独立hooks_review | async消息factory返回rejected Promise；形状检查虽拒绝，但原Promise未观察，Node报含CANARY的unhandled rejection | 先经`sync(createUserMessage(...))`观察并拒绝Promise；新增用例先复现原始失败，再25/25及全套通过 |
| SH-03 / 文档与实现一致性，独立hooks_review | 原CAPS允许最长等待5000ms/召回8000单位，超过计划1000/4000承诺 | CAPS收紧到1000/4000；配置+1用例先失败再通过，合法上限仍可用 |
| SH-04 / 测试证据，独立memory_task2_review | 原native重复投递把append返回event对象当seq再eventAt，实际额外emit了undefined，未证明重复事件 | 改为先断言`eventAt(event.seq)===event`再emit该真实event；全126重新通过，重复任务仍只有一个 |
| SH-05 / 行为澄清，独立memory_task2_review | 已提交召回遇到含旧recall的decision重入，会剔除该消息，需判断是否误删当前上下文 | 独立核实际loop:1067—1072后确认decision是待append增量；剔除避免重复append，既有历史不撤回。单元/native既有案例补显式携旧recall重入断言，机制说明固化该取舍 |

fixture曾以rename模拟损坏权威标记，被当前沙箱返回EPERM；排查确认未到业务断言，改用临时文件写入无效内容触发拒绝。没有把该rename当已通过的系统能力，也未因此改变生产边界。

首位独立审查者`/root/hooks_review`在报告SH-01/02/03后触发服务用量限制，未提供最终通过结论。随后由`/root/memory_task2_review`接替独立重跑和逐项核实；不得把首位审查者中断算作验收成功。

最终接替审查结论：Critical无；Important三项均经读码和实跑关闭；原生重放测试、committed增量语义和eventAt迁移债均已关闭或准确列为限制。阶段机制与代码/证据一致。上述独立复审不包含真实授权链、调度/执行授权或完整wire保证。

## 机制与固定物料

[阶段机制说明](task3-hooks-mechanisms.md)按稳定编号解释当前准入、冻结/回滚、当前交集召回、注入身份、提交收据、单writer/清理，以及skill可调点和代码硬边界。既有[Provider阶段报告](task3-provider-review.md)与[Task 2报告](task2-review.md)保留原历史字节；当前`src/jobs.mjs`新增归属核验，以本阶段清单为准。

下列SHA由独立审查者提供，主代理重算一致；[本阶段物料清单](../evidence/task3-hooks-verification.json)在复审结束后冻结。该清单不覆盖会造成循环摘要的本报告、README和状态入口；这些收尾文件另做链接/状态核对。子计划仅在完成后更新勾选状态，不冒称最终勾选字节已由独立审查者运行。

清单共87份物料，自身SHA256为`6121dcf6230ac9563093461bda391809f84499ae471abcbd73aefe67395ed4d5`；包含当前实现/测试/运行时/vendor许可、计划/机制、本轮证据及37份Host源码副本。此前30份副本为历史核对来源，新增7份在本轮重新与固定ASAR逐字节核对，不把清单收录冒充全部源码的再次动态验收。

| 所审文件 | SHA256 |
|---|---|
| plugin/session-hooks.mjs | `e435937e689d5a3b31fa428a91700e4cdcdb2e3ccfbbe77461ebac1d4d60f07a` |
| src/jobs.mjs | `1975abc317465c4ae14ad12038e13217ce6031b03a4956e23bf19912829f449b` |
| tests/session-hooks.test.mjs | `48e0df749ef972d8e572fef0207fa8c884401b15471bfb24656f8a25d1652fcd` |
| tools/host-api/hooks.test.mjs | `f8e278e07eec760c249f804f5eb4293972694ee6e3a22d9a5409b63bbb0ab7bf` |
| docs/task3-hooks-mechanisms.md | `de0e1b5644989ca9f6dd1c8bd98a08913821e735f4b4b00d2e4415f2523f61d6` |

## 后续硬门

- `resolveScope/admitMessage/readApprovedRoute`目前是同步可信注入合同，尚未实现真实配置/准入链；source.kind和rpcId不授予许可。
- hook只入队。可信scheduler必须补入队后的撤权、执行前和提交前许可复核，不可用既有epoch/source检查替代用户授权，也不自动重试unknown。
- pre-step保证仅到交还decision时有效；外层middleware/prepareRequest之后仍可await。Host最终projection/dispatch复核尚待实现，旧历史中已提交的召回不能承诺撤回。
- `eventAt`在当前Host源码标deprecated；现版本确实可用，但升级前须用同等可信的新收据接口迁移，不可删除身份检查。
- canonical session/header摘要不保证不可重复实例；同realm WeakMap不保证跨VM/进程唯一writer；元数据缓存不构成跨重启永久注入去重。
- 管理UI、03生命周期事件消费、工作记忆提醒/模板映射/完整年度导出、插件bundle、真实profile/API与全出口验证均未完成。`年终总结维度.md`仍待用户提供，年度记录仍为独立collection、不自动进入普通召回。
