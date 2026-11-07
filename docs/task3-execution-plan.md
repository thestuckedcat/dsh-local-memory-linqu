# 作业执行授权 Implementation Plan

> 执行约定：用户已授权继续既定路线，主代理原生实现，独立agent设计、另一agent复审；计划沿用本项目docs布局。不创建Git提交，不另加确认流程。

**Goal:** 阻止入队后撤权的任务发送模型请求，阻止执行中或提交前撤权的结果写入普通/年度集合。
**Architecture:** 在queue.runJob内部默认拒绝；同步authorizeExecution返回版本和真实AbortSignal，捕获后只复核同一lease。受控Provider透传assertExecution至Harness prepare/stream前后；signal撤销黏性取消，结果事务前后再核验，未知执行不自动重试。
**Tech Stack:** 既有Node26/Host24、SQLite、ESM；无新依赖或托管服务，无schema/payload迁移。
**Spec:** [父计划](../PLAN.md)MEM-04、[钩子缺口](task3-hooks-mechanisms.md)MEM-HOOK-WINDOW-01、[Provider边界](task3-provider-mechanisms.md)。独立设计`/root/execution_design`确认合同可落地，主模型最终projection与后台调度并非本组件。

## 来源和实施顺序

直接复用本项目已审jobs事务/预算/unknown账本和Provider桥接；新增授权合同自行实现。Harness固定0.2.1-rc.5/build d4db512a969fccf0c5cc7ec8fe38e9c1d27af916的prepareCall/stream仍由现有桥接调用，使用原SDK，不复制源码。kovey固定commit73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c没有新增复用；其他上游未合入。

先以本地真实SQLite+替身模型跑撤权反例，再补队列/Provider/桥接接缝和真实安装库假adapter测试，最后双运行时回归、独立评审、机制说明与固定摘要。首个验收是未提供执行许可的完好queued任务零模型调用、清输入且预算不退款。

## Global Constraints

- 不读取真实profile/凭据/历史，不安装插件、不调真实API；所有模型和许可为合成替身，网络守卫仅证明覆盖的API。
- callback默认deny，不接受true、Promise、空版本或伪造signal。Host必须按冻结身份查真正许可，不能永远true或由模型发回授权。
- 不改已有payload身份，不给旧queued自动补授权。新鲜Host许可可按同jobId/fingerprint授权已有任务；缺映射一律拒绝。
- scope/source/epoch/route、预算及可信恢复入口保持；permission不取代这些检查。
- unknown恢复比旧实现更保守：不因晚到settle自动解锁，仅可信结束确认放行；授权/路由回调只读，不作为Host生命周期写入口。

## Interfaces / Files

- 修改src/jobs.mjs：createJobQueue(store,{provider,authorizeExecution=()=>undefined,...})。callback接收不可变{phase,jobId,scopeRef,payloadFingerprint,purpose,sessionRef,sourceRef,sourceVersion,fragmentRef,inputClass,inputDigest,generation,route,itemRef}，不含正文/inputRef；返回{authorizationVersion,signal}。phase为claim/dispatch/commit/commit-complete；后续版本和signal对象必须与claim相同。
- 修改src/provider.mjs：execute透传可选assertExecution同步函数给invoke；调用前检查。queue总是传入，直接Provider探针仍为可信底层组件调用。
- 修改plugin/harness-provider.mjs：checkpoint调用assertExecution，覆盖prepare前/后、stream前/后及最终完成；prepare开始后失败保守unknown。
- tests/execution-authorization.test.mjs新反例；既有queue调用显式提供合成许可，并保留缺许可拒绝测试，不能用默认放行兼容旧测试。
- tools/host-api/execution.test.mjs和tools/test-execution-authorization.mjs保存新阶段TAP/回执，不覆盖旧证据。

## Review Focus

1. queued后撤权：零execute/prepare/stream，终态failed/not_dispatched，清输入且预算保留。
2. prepare await或stream期间撤权：不续stream、不提交晚到输出，不凭本地abort解除未知闸门。
3. callback版本/signal改变、异常/Promise/返回值变形：黏性拒绝，无raw异常泄漏；必须观察拒绝Promise。
4. 回调/Provider同步抛错、claim到dispatch之间signal变化：没有挂住timer、running/锁孤儿或未观察拒绝。
5. 普通及年度提交后核失败：事务全rollback，再终结stale；不能只核结果写入前，也不能污染已有年度记录。

- [x] 初始6项及细化6项真实运行失败，保留各自red TAP。
- [x] 实现默认deny、冻结metadata和同lease复核，dispatch与commit前后检查。
- [x] signal撤权及时停止本地等待，持续拒绝晚到结果；Provider同步异常也进入unknown清理。
- [x] 真实安装库验证prepare-await撤权零stream、正常许可和执行中撤权。
- [x] 显式更新合成测试权限，运行Node全套和Host全套，固定实际数字与摘要。
- [x] 另一agent独立复审，交付阶段机制/验收报告；完整Task3维持未完成。

本窄组件已独立验收，最终Node125/Host146通过；独立Node125、安装库5及附加断言3均通过，见[阶段评审](task3-execution-review.md)。完整Task3仍有真实grant映射、scheduler、主模型final projection、管理和年度导出等未完成项。
