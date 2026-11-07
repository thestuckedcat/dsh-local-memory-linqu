# MEM-STREAM-01：Harness 流接口修复

日期：2026-11-07。范围为已安装本地记忆插件的缺陷修复，不代表完整05产品验收。

## 场景与根因

普通聊天、召回请求及其他插件的模型请求都会经过 `llm/stream`。本机 Harness `0.2.1-rc.5` 的 `LlmRuntime.streamWithRegistration()` 直接返回 Cordis waterfall 的结果；调用方立即以 `yield*` 或 `for await` 消费。

`plugin/final-projection.mjs` 原监听器声明为 `async`，正常分支 `return await next()`、拒绝分支 `return blockChunk()` 都返回 Promise，破坏 `AsyncIterable` 合同。新增直接 `yield*` 回归在修复前复现用户原错；实际安装库探针同样报 `stream is not async iterable`。旧单元夹具对监听器结果先做 `await`，掩盖了错误。

## 触发、判断、动作与恢复

1. 输入仍是宿主的请求 `options` 和同步返回异步可迭代流的 `next`。
2. 同步监听器调用原有 `verify`；普通请求或有效召回直接 `return next()`，不包装、不消费、不改写流。下游异常及消费者提前结束沿原迭代器传播。
3. 召回失效时仍不调用 `next()`，直接返回只产生一个 `memory_projection_stale` 终止块的异步可迭代对象。授权、路由、删除和来源检查保持原判断。
4. 桌面 profile 的 `dsh-local-memory-linqu` 是指向本目录的 junction；源码修复无需重装。已加载进程需重新加载插件或重启才能使用新函数。未在本次操作中终止用户会话。

这是 plugin/Host 接口硬合同，skill 无可调阈值，修改 skill 不能让 Promise 成为可迭代流。没有新增依赖或复用来源，沿用既有本机宿主接口；实现仅修正监听器返回类型。

## 验证与证据

- [修复前实际安装库探针](../evidence/stream-contract-before.tap)：3项中1项因流接口错误失败。
- [最终组件回归](../evidence/stream-contract-components-short-temp.tap)：253/253，0失败。
- [最终实际安装库回归](../evidence/stream-contract-host24-final.tap)：34/34，0失败；使用内嵌 Node24、实际 Cordis/LLM 库、合成适配器和隔离数据，不调用真实模型。
- `tests/final-projection.test.mjs` 直接消费监听器返回值，覆盖 `yield*`、普通聊天、有效召回、删除/归档后拒绝发送等；去掉此次同步修复会再次失败。
- Windows 默认沙箱临时目录过长导致首次全量组件回归42项数据库路径失败；仅将测试进程 TEMP/TMP 改为工作区较短路径后，完整 `npm test` 及同命令的TAP回归均通过。未为此改产品数据库逻辑。
- 实际安装库测试原先先删除目录、后关闭 SQLite，Windows 清理报 EPERM。测试现先关闭 SQLite 再删除目录；这是测试清理调整。

当前证据没有覆盖运行中完整桌面 profile 的真实模型请求。用户重启后发送一条普通消息，收到正常流式回复，才补足这次现场复验；结果待验证。宠物插件日志也存在流不可迭代错误，但本次未触发其真实后台请求，不单独宣称其现场恢复。

**2026-11-07现场复验更新**：桌面 Harness 已重启（新Web原点），记忆插件连同修复后的同步监听器重新加载；随后多条普通对话轮次均正常返回流式回复，安装侧的`llm/stream`监听器不再破坏普通请求。同时`POST /dsh-local-memory/api`返回`state:ready`，客户端`settings.section`注册项`local-memory`为active，说明修复后的模块已在实际进程生效。仍未用真实业务Provider跑“召回命中后的放行/阻断”现场旅程，不得把普通聊天成功扩大解释为MEM-103真实Provider验收。

## 后续最小验证

以后调整此监听器，至少直接 `yield*` 消费普通请求和失效召回两条路径，再跑实际安装库探针。不要在测试消费者中预先 `await` 监听器返回值。未来若宿主改变合同，先核实际版本和调用链，不在此处猜测兼容。
