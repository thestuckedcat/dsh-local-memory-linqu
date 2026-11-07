# Task 3启动接口核对：独立复审记录

日期：2026-11-05。实现与核对清单：`/root`；独立审查：`/root/memory_task2_review`。没有Git基线，以文件摘要固定范围。审查者只读正式文件，只按授权运行探针生成TAP/JSON；未安装plugin、未加载用户profile、未调用真实Provider或另派Agent。

## 结论及实际执行

**启动接口核对通过独立复审，无剩余阻塞项，两条非阻塞证据标注建议均已关闭。** 结论限定于已锁定安装库的隔离API核对，可以据此编写原生适配器；完整Task 3、实际Host profile、授权UI、真实Provider和出口仍未验收。

- 独立运行`.\runtime\node.exe tools/probe-host-api.mjs`：10通过、0失败、0skip、exit 0；整条命令833ms、TAP内部204.56ms。该次独立TAP摘要为`06a86f10ad957303a069072e68c5912b6a3ea8704abeaa84d5d75408757d4858`，之后主代理为证据标注delta重新生成最终TAP，没有把历史摘要冒充当前字节。
- 独立以实际内嵌Node只读核对两份manifest共30个文件：实际归档字节、证据副本、SHA256和大小全部一致；主代理也独立核对一致。
- 独立调用GetDriveTypeW，C/E/H均为3；仍仅为当前机器/当前盘快照，不是junction、盘符变化后的持续证明。
- 独立核对清单中BlockAssembler默认stop、Runtime本地合成error/aborted、pi-ai registrationFacts不含端点、runtime-context归属、重试和安装接缝等源码判断，未发现把组件/源码判断扩大为完整Host或出口验收。

## 发现、修订与最终复核

| 编号 / 级别 | 建议 | 关闭证据 |
|---|---|---|
| HA-01 / 非阻塞 | 回执的profileLoaded=false、realProviderCalled=false由调用路径支持，不能被误读成文件访问/Provider监测结果；缺少探针物料摘要与运行时间 | JSON新增declarationBasis、入口/测试/守卫三项SHA、startedAtUtc/durationMs，解析TAP计数后设置verified；主代理重跑10/10、0fail/skip、exit0；审查者只读核当前delta、摘要和回执一致 |
| HA-02 / 非阻塞 | 网络测试标题“imports made no attempts”单独阅读可能误认为全部网络路径覆盖 | 标题改为covered connection APIs/covered sinks，接入清单及JSON保持范围限制；最终复核确认关闭 |

本轮delta只增加证据元数据/TAP验证和限定标题，未修改10项测试的实质断言或守卫。主代理实际重跑最终版本，耗时269.6401ms（仅spawn测量，不含父进程安装包摘要核对），最终[回执](../evidence/task3-host-probe.json)的verified=true对应tests/pass=10、fail/cancelled/skipped/todo=0。审查者delta轮未重复运行这些未改断言，如实区分独立实跑与delta静态复核。

## 最终固定字节

下列三份工具摘要由最终回执记录并经审查者复核；接入清单摘要由审查者独立报告并由主代理重算。状态README、registry和本复审记录单独收尾，不冒称由这些摘要覆盖。

| 文件 | SHA256 |
|---|---|
| tools/probe-host-api.mjs | `e53c57d2f2e2290f2b82ec6f15a673f24cd9c4a810a1ce569b2bf3821d4705cf` |
| tools/host-api/probe.test.mjs | `76b2d75bd1007f642a42d25d6802ecd8df302dc91d17f6c28185b9b70f97453f` |
| tools/host-api/deny-network.cjs | `eb6a3c6295f7b95593505768afa0754792e53415cc0d69e7bceb1c5760dcce3e` |
| docs/task3-host-interfaces.md | `f94a282d1a147bbc39bae9d7ba4c0216f1758a127258add2b0c2e1f7d64f7a00` |
| evidence/task3-host-contract.tap | `350b9c00165edc43ac9e6f5f4b79a19a6f1405ba28d26b151631ea2e0c1d2c4f` |

主代理生成的[39项物料摘要清单](../evidence/task3-api-verification.json)包含上述工具、清单、最终TAP/JSON、盘证明、两份manifest及30份源码副本；其自身SHA256为`1fd213e4f3e402393bab65f19367b5146d64f25620fee2a0fc36a08fae1c175a`。原[Task 2物料](../evidence/task2-verification.json)29项摘要保持一致，本轮未重复运行未改的61项或将新探针计为完整plugin成绩。

## 继续实施时的边界

按[接入清单](task3-host-interfaces.md)先为Provider桥接写路由配置变化、无明确finish、合成本地error/aborted等反例；不得以默认stop或合成error释放unknown锁。完整profile与实际selected adapter内部网络/重试、远端完成收据、源码来源白名单、可信scope/授权、离线安装、缺证提醒及年度导出仍需实现和实际验证。网络守卫只覆盖审计进程指定API，没有认证OS、子进程、Desktop浏览器或任意原生网络出口。
