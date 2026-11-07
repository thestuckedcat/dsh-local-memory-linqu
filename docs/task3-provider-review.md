# Task 3 Provider桥接：测试与独立复审

测试与复审：2026-11-05；归档核对：2026-11-06。独立设计：`/root/design`；实现：`/root`；独立代码/机制审查：`/root/memory_task2_review`。无Git基线，按最终文件摘要核对。只操作本地合成资源，未安装plugin、读取用户profile/凭据或调用真实模型API。

## 验收结论

**Provider桥接、固定提示词输入计数增量及阶段机制说明通过独立复审。无剩余Critical、Important或Minor。** 当前可进入Task 3的消息来源/钩子、可信Host配置与管理集成；完整Task 3及05插件仍部分完成，尚不可安装。

实际行为见[阶段机制说明](task3-provider-mechanisms.md)，设计与来源见[实施约定](task3-provider-plan.md)。实现入口为[plugin/harness-provider.mjs](../plugin/harness-provider.mjs)，队列仅扩展[src/jobs.mjs](../src/jobs.mjs)的输入计数合同，其余Task 2物料未改。旧Task 2评审/manifest保留历史字节，不能认证当前jobs。

## 实际测试证据

| 执行者 / 运行时 | 已执行及结果 | 输出 |
|---|---|---|
| 主代理 / Node26.13.0 | 正式85项：85通过、0失败/取消/skip/todo，exit0，17199.2648ms | [Node TAP](../evidence/task3-provider-node26.tap) |
| 主代理 / Harness内嵌Node24.21.0 | 相同85组件项+8实际Context/SDK桥接项，共93通过、0失败/取消/skip/todo，exit0；TAP23452.066ms | [Host TAP](../evidence/task3-provider-host24.tap)、[执行回执](../evidence/task3-provider-host24.json) |
| 独立审查 / Node26 | 独立重跑85项全过，0失败/skip，约14.82秒 | 审查者最终结论；没有拿主代理运行冒充独立执行 |
| 独立审查 / 内嵌Node24 | 独立重跑8项真实安装库+假adapter：8通过，0失败/取消/skip/todo，exit0；子进程672.318ms，TAP549.1209ms | [独立原生TAP](../evidence/task3-provider-native-independent-review.tap)、[回执](../evidence/task3-provider-native-independent-review.json) |

Node命令：05目录下`.\runtime\node.exe --test --test-reporter=tap tests/*.test.mjs`。内嵌全套由`.\runtime\node.exe tools/test-harness-provider.mjs`执行；父进程先校验exe/app.asar摘要，windowsHide=true，仅对子进程设置ELECTRON_RUN_AS_NODE、隔离DSH_HOME和最小环境，实际argv及源文件摘要保存在回执。

测试计数不与先前独立10项接口探针累加为完整plugin成绩。真实安装库测试挂真实Cordis/LLM/SDK/fiber，使用假adapter与临时SQLite；没有启动完整AgentLoop、持久session profile或真实Provider。回执false字段由已审调用路径支持，不是全系统访问监测结果。网络守卫仅覆盖指定Node API，不能推导全Host、子进程、原生模块或Chromium无外发。

## 先失败、再实现及独立发现

- 初始17项因桥接模块缺失全部失败，保存[初始红灯TAP](../evidence/task3-provider-red.tap)；实现后通过。之后新增协议矛盾、固定prompt/8000、预算累计、非法/漂移meter及旧payload五项，实际先看到失败，再实现通过。后续两项分别补充空白计数和EOF微任务窗口，总桥接单元反例24项。
- 首次原生全套有7项因测试插件遗漏inject:['llm']而在构造时被宿主拒绝；修正注册声明后实际原生8项通过，最终全套93项全部重跑通过。未把那次失败记录成桥接真实请求成功。

| 编号 / 来源 | 问题 | 修订及关闭证据 |
|---|---|---|
| PB-01 / Important，独立审查实证 | EOF后双层微任务触发配置失效或abort，pump检查已结束但公开execute仍fulfilled | await race之后及最外execute await受控Provider之后分别复核，最后同步检查为公开完成边界；原始配置/abort反例由双方重放均拒绝成功。完成边界后的取消不追溯已完成结果 |
| PB-02 / 实施增量 | 固定system prompt未进入旧队列input.length预算；旧payload没有冻结计数 | 增加可信同步measureInput；inputChars纳入payload/hash，入队和执行重测；非法计数/Promise零扣预算，含prompt的累计额度生效，重放不重复占预算，旧queued缺字段拒绝 |
| PB-03 / 实施中发现，独立复核 | measureInput取trim后长度，但直接execute转发原始空白，少算实际输入 | 校验文本后按实际转发的input.length计量，8000/+1与尾空白反例先红后绿，审查者另用大量前置空白重放确认拒绝且未到prepare |
| PB-04 / 协议反例 | 宽容Assembler可能忽略重复start、结束后delta、块类型变化或end文本冲突 | 桥接自行检查块生命周期；不能以Assembler能组合出文本当协议有效，负例先红后绿 |

独立审查另核预算冻结/旧payload、prepare后generic unknown、黏性取消、有界清理及activation nonce，结论与[机制](task3-provider-mechanisms.md)一致。设计和代码审查由不同agent完成，审查者未修改正式实现或安装任何组件。

## 最终固定字节

下列SHA256由独立审查者提供，主代理逐项重算一致；40项实现/测试/schema/vendor/许可/运行物料/证据清单见[task3-provider-verification.json](../evidence/task3-provider-verification.json)，清单自身SHA256为`d981648b2be144f697f28708ce76f79918b044ff7f40c85937852e11119629ff`。本报告和后续状态文档单独收尾，不冒称由受审实现摘要覆盖。

| 文件 | SHA256 |
|---|---|
| plugin/harness-provider.mjs | `f63fc69df3c85a167a85fefc4b7fc552e3fcbd944e049b2c3f9d1cea271e9f32` |
| src/jobs.mjs | `9b1415e0ef8d73ab4dbf50abf357e85d0519b276bcf13d07b5da4139cb603db6` |
| tests/harness-provider.test.mjs | `78153d5a7bccc1b08036d71a5b5fd9098c77e317fed3cec788f20b5db7377244` |
| tools/host-api/provider.test.mjs | `3b1eceda9002751e59b6371278f1d841e7f28622b3037dac002000fc85fdfe70` |
| tools/test-harness-provider.mjs | `98482cb8ff683a6290c7015945a35bf7a08b25d1412ff514ee01d19d38f37095` |
| docs/task3-provider-plan.md | `bdb9b1a8610eb82ea17cdcc3ffca3d653216c3fd8116fcf4c46a4c50bba72f33` |
| docs/task3-provider-mechanisms.md | `07200018b9124c913d0649dc10593384feb60bd4d0a629fd0e058b2e62b96564` |

## 明确留待后续

可信批准配置/凭据引用解析、无通知配置变化、实际wire重试/用量账单、远端停止证明、全Host出口、真实前端来源白名单和完整scope解析尚未认证。自动提炼/召回钩子、权限/证明管理UI、缺证提醒、模板映射及年度完整导出仍待实现。当前package仍是开发组件清单，不是DSH bundle；未发生已注册API的业务调用。

激活改变、重启或旧payload升级时不续跑旧queued；取消/本地错误可能保留unknown锁。恢复必须走后续真正的可信结束收据流程，不能以重启、新建桥接实例、换root或永远true的authorizeRecovery绕过权威账本。
