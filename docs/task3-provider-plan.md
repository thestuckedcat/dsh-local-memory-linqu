# Task 3受控Provider桥接：实现约定

日期：2026-11-05。设计输入由独立`/root/design`只读核对；实现为`/root`，代码另交`/root/memory_task2_review`审查。本阶段实现plugin/harness-provider.mjs及单元/实际安装库测试，沿用[宿主核对](task3-host-interfaces.md)和[既有路线](implementation-route.md)。额外对Task 2队列添加可选输入计数hook，不改存储schema；不安装插件、不读取凭据或用户profile、不调用真实模型。

## 来源与采用方式

- 本机锁定Harness 0.2.1-rc.5的真实LlmRuntime.prepareCall/stream、消息工厂和BlockAssembler：直接调用已安装库，通过注入sdk传入，不执行evidence副本。无新上游依赖。
- Task 2的createControlledProvider：保持四字段路由、输入/输出检查及错误语义；现有queue继续拥有预算、事务提交和unknown锁。
- 本组件自行实现激活fence、取消/关闭观察、显式终结判断和purpose提示词；不复制上游同步/自动导入/路由fallback链。

## 窄接口与版本策略

`createHarnessProviderBridge({ctx,sdk,readApprovedRoute,cleanupBudgetMs?}) → {provider,dispose,status}`。sdk只接createUserMessage、createSystemMessage、BlockAssembler；ctx只用llm、on及effect。readApprovedRoute是可信同步本地许可/配置边界，返回routeRef/provider/model/routeVersion，不接收key、模型输出或任意HTTP目标。尚未实现真正Host配置/批准解析器，本组件测试显式注入合成版本。

先注册四类失效监听，再接受路由：llm/adapters-updated、loader/volatile-update、settings/document-updated、app-boot/config-reload。任一事件使旧activation持续失效并请求取消，描述符即使变回原值也不自行复活。路由版本含内部随机activation nonce和许可版本；重建/重启后旧queued任务拒绝续跑，不自动重绑或重发。此方案优先保守拒绝，不提供跨重启稳定路由续跑。事件覆盖不证明无通知的adapter内部/环境变化；真正配置解析和出口验收仍是后续Host适配工作。

prepare前、prepare返回后、dispatch前、最终返回前复核四字段及激活/取消状态。读取异常、Promise结果、字段缺失或注册Provider不可用均拒绝；返回Promise也观察其拒绝，避免未处理异常。监听器与任务归当前fiber所有，dispose幂等。

## 终结和取消状态

只有明确finish.reason.kind=stop、整个iterator自然EOF、协议有效且未取消/失效时，才返回finishReason=stop。不能用assembler.finish的默认stop，不能将本地error/aborted或iterator.return当远端停止证明。max-tokens等其他终结类型本阶段也保守unknown，后续实际adapter证据充分后才细分。

在调用prepareCall之前的纯本地拒绝可用RouteUnavailable/preDispatch；一旦触碰prepareCall，任何失败默认generic unknown，因为prepare可能先访问模型metadata。该后缀阶段不抛ProviderResponseError、不返回finishReason=error。成功结束后文本/schema非法，则由既有受控Provider/queue判已结束但结果无效。

取消、失效、dispose都是持续状态：发生后晚到stop+EOF也不返回成功、不写回、不自动解unknown锁。组件不调用confirmRemoteQuiescence。每条流最多一个pending next；关闭幂等，观察所有pump/return Promise。dispose只在cleanupBudgetMs有界等待，返回pendingCleanup及本地状态，不推断remote stopped；return可能被pending next阻塞。

## 输入/输出与验证

模型请求仅有固定purpose提示和当前有界input；不加完整历史、证明材料、工具声明或认证数据，不创建聊天Agent。text/reasoning/块数/片段数均有硬上限；只返回文本和允许的数字usage，不透传raw错误、opaque replay或reasoning正文。输出仍需Task 2完整schema验证后才能写库。

先写并运行缺finish、stop后无EOF、prepare失败、端点/版本变化、取消后晚到stop、清理拒绝/悬挂及真实Host本地合成error反例；确认失败后再实现。随后Node26正式组件回归、内嵌Node24组件回归和真实Context+假adapter集成，最后独立代码/机制审查。记录失败与最终输出，保持原61项与10项历史输出不变；当前jobs字节已变化，不能继续用旧Task 2摘要认证它。不把本阶段测试当作完整plugin、真实wire重试/出口或模型质量认证。

## 实施时明确的输入计数增量

固定system提示也占模型输入，因此桥接必须提供measureInput({purpose,input})，统计同一份固定prompt+实际user文本的UTF-16 code units，含实际转发的空白，单次总和不超过8000。queue默认raw-input合同不变；若提供hook，必须同步、纯本地、确定性且整数范围为input.length..8000。异常/Promise/非法值在预算事务前拒绝，Promise拒绝也被观察。

inputChars进入持久payload及fingerprint，日预算计该值，执行前重新测量一致才允许调用。缺inputChars的旧queued拒绝，不能事后补算其已预留预算；保留历史状态、不退款、不重绑或自动重发。未修改DB schema或既有completed/unknown恢复权限。此小delta及8000/+1、空白、累计含prompt超80000、重放不重复预留、计数漂移/旧payload负例已获同一独立设计者核对；代码需一并独立复审。
