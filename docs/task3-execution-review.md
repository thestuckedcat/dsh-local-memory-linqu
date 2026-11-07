# Task 3作业执行授权：验证与独立评审

日期：2026-11-06。**本窄组件通过独立验收，无未关闭Critical/Important。** 范围为queue执行许可、Provider透传、prepare/stream检查、提交回滚与unknown恢复收紧。设计agent为`/root/execution_design`，主代理实现，另一agent`/root/execution_review`完成独立代码和机制审查。完整Task 3与可安装插件仍未完成。

## 实际验证

| 运行 | 结果 | 证据 |
|---|---|---|
| 本地Node26.13.0正式组件 | 125/125，0fail/cancel/skip/todo，exit0，TAP约22.60秒 | [TAP](../evidence/task3-execution-node26.tap)；原110加新授权13、bridge2 |
| Harness内嵌Node24.21.0完整回归 | 146/146，0fail/cancel/skip/todo，exit0，子进程约38.12秒 | [回执](../evidence/task3-execution-host24.json)、[TAP](../evidence/task3-execution-host24.tap)；同125加原生Provider8/hook8/执行5 |
| 独立Node全套 | 修后125/125，exit0，0fail/cancel/skip/todo | [独立TAP](../evidence/task3-execution-independent-node26.tap)、[独立评审回执](../evidence/task3-execution-independent-review.json)；修前36/122通过未冒充关闭反例 |
| 独立新原生执行 | 修后5/5，exit0 | [独立回执](../evidence/task3-execution-native-independent-review.json)、[独立TAP](../evidence/task3-execution-native-independent-review.tap)；摘要绑定最终源文件 |
| 独立附加状态断言 | 3/3，exit0 | [TAP](../evidence/task3-execution-independent-assertions-green.tap)：预算拒绝后跨重开不退款、unknown跨重开隔离、已确认年度记录合并及撤权rollback |

命令（05目录）：`.\runtime\node.exe --test --test-reporter=tap --test-reporter-destination=evidence/task3-execution-node26.tap tests/*.test.mjs`；`.\runtime\node.exe tools/test-execution-authorization.mjs`。独立原生可用同runner的`--native-only --independent`另存。新runner沿用已锁exe/ASAR、最小env、隔离DSH_HOME、windowsHide和Node网络守卫，不覆盖旧阶段TAP/JSON。

旧Provider/hook runner记录各自历史测试数，应使用新runner验收当前工作树。旧source-lock/schema/vendor/运行时不变；jobs/provider/bridge和相关测试的摘要已变化，不能拿旧87份物料清单当本轮审查证明。package仍为开发组件清单，`npm test`使用当前Node运行组件测试，不提供DSH bundle。

## 红灯与修订依据

- 初始[6项红灯](../evidence/task3-execution-red.tap)5fail/1pass；in-flight原例只等默认10秒超时，不足以区分及时撤权，细化后[6项全失败](../evidence/task3-execution-red-refined.tap)。补及时撤权、默认deny、版本变更零成果、授权metadata和异常回调，再实现通过。
- [unknown晚到反例](../evidence/task3-execution-quarantine-red.tap)9项中1fail：旧自动settle回调解锁后，第二任务不再gate-held。移除自动释放并更新旧测试为必须显式可信结束确认；失败不退款、不重试旧job。
- [prepare窗口反例](../evidence/task3-execution-source-window-red.tap)实际为stale而非unknown：旧实现仍stream后才挡提交。给assertExecution增加worker/token、epoch/source/route检查，修后零stream，结果unknown保留闸门。
- [伪signal反例](../evidence/task3-execution-signal-red.tap)旧instanceof接受原型伪装并completed；改用原生getter品牌及状态检查，零调用/failed/not_dispatched。
- [abort/立即成功竞态用例](../evidence/task3-execution-race-red.tap)首次已通过，不标成红灯证明。设计指出`quarantine:!confirmedSettled`表达式仍不满足unknown一律隔离，作为收紧规则移除该标志；保留用例固定行为。

## 独立发现及修订

| 编号 / 级别 | 独立复现与根因 | 实际修订与验证 |
|---|---|---|
| EX-01 / Important | 标准AbortController加3/4轮microtask，invocation赢Promise.race后、queue提交前caller取消，原代码只核lease，仍completed并新增一条；[独立红观察](../evidence/task3-execution-independent-probes-red.jsonl)保留实际边界状态 | checkRunning在提交前/后均直接核原runJob signal和内部controller；正式[2项红灯](../evidence/task3-execution-review-findings-red.tap)复现后通过，含最终callback内caller.abort，移除listener后也不能漏取消 |
| EX-02 / Host集成风险 | commit-complete授权回调同步重入recoverInterrupted或改route/epoch，原代码仍用旧row finish completed；可信JS副作用，不是模型输入越权 | 最后外部回调后复核worker/token、epoch/source/route及取消；回调限定只读。误写会随外层事务rollback，不能作为可靠删除入口 |
| EX-03 / Important回归 | EX-02后核原claim epoch，合法work_summary_merge本身会advance epoch，导致正常merge变stale；[正式红灯](../evidence/task3-execution-merge-red.tap)与[独立红灯](../evidence/task3-execution-independent-assertions-red.tap)确认 | 原epoch仍核执行及提交前；受控写完成、最终Host callback之前捕获writtenEpoch，后核对照它。正式annual merge正常/撤权两分支通过，保留原贡献及证据等级，撤权时原记录/epoch全部rollback |

上述修订后重新执行全套并由独立agent复核，最终数字以本报告收尾表和新物料清单为准，不能继续使用修前122/143当新字节证明。

既有queue测试逐一显式提供仅测试用`authorizeTestExecution`；worker死亡子进程另用本进程稳定signal。缺许可反例直接调用真实`createJobQueue`，生产没有兼容性默认放行。原先“等到晚到settle就解闸”的一项测试因本轮有意收紧规则失败，已改为未授权确认拒绝、可信确认后放行第二任务；没有忽略suite失败。

## 独立评审与物料

独立评审已确认EX-01/02/03关闭，MEM-EXEC-01—05与最终实现及实际证据一致，范围内没有未关闭Critical/Important。[评审回执](../evidence/task3-execution-independent-review.json)留存独立命令、exit码、物料摘要和判断范围；[机制说明](task3-execution-mechanisms.md)解释skill可调策略与代码硬边界。[新阶段物料清单](../evidence/task3-execution-verification.json)绑定当前源、测试、运行物料、机制和证据，不覆盖本收尾报告/README/状态入口，避免循环摘要。计划完工勾选由主代理收尾，未冒称该勾选本身是独立测试。

清单包含116份物料，自身SHA256为`7884c43e303d4b299b038800406801ebb23c5a6eafbfe4c438b3a7f2d6737d03`。历史Host源码副本沿用原来源核对，未新增上游取件；本轮由runner再次锁定实际exe/ASAR摘要，未把清单收录冒充完整Host认证。

下列摘要由独立审查者提供，主代理重算核对：

| 所审文件 | SHA256 |
|---|---|
| src/jobs.mjs | `ce8e5b4d63e3c25a7e4796670c322d76a2de204f641da839b8cfe22f29fe60a1` |
| src/provider.mjs | `5569dc938044a7f8f4c65ca03267a13f12d42408cd6bc5e37582caa754613dab` |
| plugin/harness-provider.mjs | `19ed2a89decb0e18aad1029aab7f64035f59e5862a7192b60af7d13658415981` |
| docs/task3-execution-mechanisms.md | `5b446f36300ff3e55dd8f606b1e47fe34fd2ad5b10efc7d50c592500fd456052` |

## 验证边界与后续

真实SQLite与queue验证预算、状态、持久输入清理及普通/年度回滚。安装库测试挂真实Context/LLM/SDK，但adapter/授权为合成替身；未运行完整AgentLoop、加载真实profile、获取凭据或调用已注册业务API。空网络调用列表仅说明指定Node API未触发，不能证明整个Host/Chromium/原生模块/子进程无外发。

本轮不改schema/payload，旧queued缺新鲜授权同样拒绝。真实许可数据库仍需将准入正文摘要、来源、scope、purpose、route和目标绑定到job，撤权时abort旧signal；只改版本不唤醒悬挂IO。未执行的queued仍保留输入直到run/生命周期动作清理，本组件没有自动scheduler或撤权后批量清理worker。

可信scheduler、真实grant/scope/批准配置解析、远端结束收据、主对话最终projection/dispatch、03事件消费、管理/证明授权、缺证提醒、模板映射及完整年度导出和全Host出口仍待实现。已提交到历史/模型的召回不能承诺撤回；本阶段只约束记忆提炼请求。完整项目机制文档仍留整体交付。
