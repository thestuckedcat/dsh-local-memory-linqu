# 当前消息准入与召回钩子 Implementation Plan

> **执行约定：** 用户已授权继续既定方案，沿用主代理原生实现、独立设计与另一agent复审的方式，按TDD逐项执行。本工作区没有Git基线，不创建提交；不增加新的确认流程。

**Goal:** 为当前已批准文本消息持久入队，按当前输入召回普通经验，并阻止重复、伪造来源、自身循环和scope漂移。
**Architecture:** session/event只安排有界准入任务并调用现有queue.enqueue；agent/pre-step先调用next，仅对claimed与最终enter消息的未变交集查当前scope。真实授权回执和scope解析均为可信同步注入边界，默认deny；此阶段不调度模型作业。
**Tech Stack:** 现有Node26/内嵌Node24、SQLite、Harness0.2.1-rc.5的Session/Agent/SDK；无新依赖。
**Spec:** [父计划MEM-04](../PLAN.md)、[已核接口](task3-host-interfaces.md)、[Provider边界](task3-provider-mechanisms.md)。独立设计者`/root/design`已核实际loop/session顺序，代码由另一agent复审。

## Global Constraints

- 只处理当前事件，不枚举/恢复/遍历真实历史、附件、证明或其他scope；本阶段不安装、不读凭据、不调用真实Provider。
- 真实前端源码：dsh-api-session-controller.prompt构造source.kind=user/rpcId；模型切换、runtime-context、工具和本插件来源都不取得许可。kind/rpcId不是不可伪造授权，必须另过可信admitMessage。
- session/event发生在内存log.push之后，非磁盘fsync收据；pre-step claimed仍可被next拒绝或替换，所以不能据claimed直接入队。
- sourceRef保持实际session.id为根以兼容03删除事件；首版仅允许有界、无斜杠的规范ID。内部增加header.version/createdAt派生的Host命名身份摘要，不将它冒充随机或绝对唯一incarnation；同header恢复的冲突保守拒绝。数据身份和scope均由真实服务对象/可信回执绑定。
- queue保留已审预算、路由和unknown；本组件不runJob、不重新绑定或自动重发旧任务，不解除未知锁。dispose不宣称删除已经持久化的queued输入。
- 普通召回不读work_summaries。此前已提交到聊天历史/主模型的召回文本不能承诺撤回；删除只限制之后查询与注入。

## Review Focus

1. next拒绝/改文/删消息，或等待期间scope/权限切换：零旧scope查询/注入。
2. source标签伪造、同消息ID改文/换seq/跨会话重放：无新增重复job，绝不把原文hash加入requestId绕过冲突。
3. 事务内入队后权限变化：回滚输入、预算和job；必须先验证queue与store真实归属相同。
4. 多fiber/同模块多次加载重复安装，以及dispose后迟到事件：一个writer、无新入队/注入、诊断无正文或raw错误。
5. 有界召回重入与删除：只缓存id/hash，未提交重入保持同注入id但重新核库，已提交后不再追加；读失败不回退旧正文。

## Task 1: 当前消息准入与召回组件

**Files:** Create plugin/session-hooks.mjs、tests/session-hooks.test.mjs、tools/host-api/hooks.test.mjs、tools/test-session-hooks.mjs；Modify src/jobs.mjs仅添加queue/store归属判定。机制与最终证据另留本模块docs/evidence。

**Interfaces:**
- `installSessionHooks(ctx,{resolveScope,admitMessage,createUserMessage,onDiagnostic?,limits?}) → {dispose(),drain({timeoutMs?}),status()}`。
- ctx需root及live sessions/agents/get；真实fiber声明inject:['sessions','agents']。同root通过进程共享注册表仅一个writer，重复安装明确拒绝。
- `resolveScope({agent,session})`同步返回`{scopeRef,store,queue,routeRef,generation,authorizationVersion}`；store.scopeRef和generation必须一致，`snapshotQueueRoute(queue,store,routeRef,purpose)`通过私有队列登记验证同store并复制完整四字段路由；缺失/Promise拒绝。
- `admitMessage({action,scopeRef,sessionId,sessionRef,messageId,rpcId,contentHash,eventSeq?,authorizationVersion})`同步返回`{originRef,contentHash,authorizationVersion}`并与请求hash/版本全等，默认拒绝。实现必须查真实Host准入/许可，不把这些可序列化字段当签名或凭据。
- `drain`只等本组件安排的本地准入，不执行模型；`dispose`卸监听、阻断迟到任务并报告已queued仍由queue保留。

- [x] 写当前事件/claimed拒绝/来源伪造/重复身份/scope切换/热召回删除/重复安装/dispose反例，运行`.\runtime\node.exe --test tests/session-hooks.test.mjs`看到缺功能失败。
- [x] 实现纯文本准入：最多16个文本块，总长8000，含附件/秘密/未知块拒整条；requestId锚Host会话命名身份+消息ID+固定memory_extract；sourceVersion绑授权来源与完整原文块摘要。sourceRef含实际event.seq。
- [x] 入队置于既有write/contextOf外层事务，前后重核准入与binding/完整路由，postcheck失败须向外抛出以rollback；异步任务冻结事件时的scope与准入，不能重绑当前B。最多32个pending、累计32000单位正文、最长1000ms本地等待，所有拒绝被观察，诊断仅枚举码。不让队列错误改变Host消息提交流程。
- [x] 实现next仅调用一次、reject原样返回；从claimed∩decision获准文本构造最多2000单位词法query，最多5条/4000单位召回，超预算整条跳过；注入独立memory-recall标签并标为未核验资料。所有原decision字段保留。
- [x] 缓存最多128组id/hash/提交标记，不保留正文；每次重入重新查询并核generation/revision，当前decision中旧的本插件召回被替换/剔除；同一注入已由session/event提交则不再追加。前后scope/权限或版本变化时丢弃本次召回。
- [x] Node正式全套、内嵌组件回归以及真实Context/Session/Agent服务+假Provider集成；测试只在合成临时资源运行，不覆盖旧阶段TAP。
- [x] 不同agent独立复审代码和阶段机制；固定摘要，更新部分进度，完整Task3剩余钩子调度/配置解析/授权UI/导出/出口不得提前勾选。

本窄组件验收通过，Node110/Host126及独立110/8均通过，见[阶段评审](task3-hooks-review.md)。此勾选不表示父Task 3完整完成。

**验证边界：** Source标签与grant替身测试不认证真实认证链；当前组件不执行已queued模型任务，授权撤销后的调度/提交复核必须由下一阶段Host作业接缝补齐。drain的timeout只约束异步等待，不承诺抢占同步SQLite或任意可信回调。pre-step只保证交还decision时有效，其后外层middleware/prepareRequest仍可await；未来须在Host最终投影/dispatch前重核，不能用长SQLite事务跨await。旧历史中的已发召回文本不在可撤回范围。全局注册表只覆盖同realm的module copy，并以owner token防旧dispose清掉新激活。
