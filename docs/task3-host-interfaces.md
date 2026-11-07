# Task 3启动核对：已安装Harness的接入清单

日期：2026-11-05。范围是用户要求先核对的插件注册、Provider及会话事件三个接缝，并补充与本地路径、出口相关的已知约束。沿用[已说明的路线与来源](implementation-route.md)，没有引入新框架。**本阶段是已安装库的隔离API验证，不是完整Host profile、正式plugin、真实Provider或出口验收。** Task 3原计划六项仍未完成。

## 基线与实际运行

- 重新计算安装包SHA256，与Task 1/2锁定值一致：exe为`7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4`；app.asar为`e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915`。
- 通过安装包Electron Node模式实际导入原包的Cordis、LLM、Session、Agent、Scope、AppBoot；不是运行证据目录内的复制代码。运行时Node24.21.0、Electron44.7.0，boot读取运行版本0.2.1-rc.5。
- 挂载真实Context及服务，只有本地假adapter和内存Session；未启动Desktop UI，未加载用户profile，未读取凭据、已注册Provider配置或真实会话；未调用模型API。
- 执行[probe-host-api.mjs](../tools/probe-host-api.mjs)，[10项TAP](../evidence/task3-host-contract.tap)全部通过、0失败、0skip。启动参数、安装摘要及该次TAP摘要见[实际回执](../evidence/task3-host-probe.json)。本文件不是将原61项重复累计为“71项完整插件测试”；原Task 2实现未改。
- 子进程只传必要环境和独立DSH_HOME，预加载[网络拒绝器](../tools/host-api/deny-network.cjs)。测试确认覆盖的连接API在发送前被拒，库导入和之前九项没有触发这些API。它只是本次审计进程的已覆盖API防线，不是OS级策略，不认证子进程、Desktop Chromium、原生模块或实际Provider出口。

回执中的profileLoaded=false及realProviderCalled=false由已审探针的调用路径支持，并非文件访问或Provider调用监测结果；JSON单独标注declarationBasis，并记录入口/测试/守卫摘要、UTC开始时间、耗时和TAP计数。TAP的网络用例也限定为受守卫覆盖的API，不声称覆盖全部网络路径。

从安装归档读取的新增18份包清单/入口只作源码证据，[manifest](../evidence/task3-host-api/source-manifest.json)记录路径、原字节摘要和归档身份；不导入这些复制件、不作为新增vendor交付。原六份包入口证据仍在[evidence/host-api](../evidence/host-api/source-manifest.json)。主代理及独立审查者分别只读复核两份manifest共30个文件的size、SHA256及副本与实际归档字节一致。独立执行、发现和最终摘要见[核对复审记录](task3-host-audit-review.md)。

## 可以直接使用的接口

| 接缝 | 已确认的接口/行为 | 具体采用方式及尚待验证 |
|---|---|---|
| Cordis插件生命周期 | `await ctx.plugin(plugin)`等待fiber加载；`fiber.dispose()`及fiber自有effect清理；测试真实监听器卸载后不再收到事件 | 入口声明所需服务，单writer；注册幂等与整体插件重复安装仍需自己的合同测试。该版没有ctx.start()/stop()，不能套其他Cordis版本示例 |
| 现有LLM服务 | `ctx.llm.listProviders()`、`prepareCall({provider,model,maxTokens},signal)`、prepared.config/stream；prepared config冻结、单次dispatch、usage可读 | 直接复用已注册服务，插件不处理API key。真实批准路由、实际adapter与端点尚未读取/运行，不等于已经可向任意列出的Provider发请求 |
| 单次调用绑定 | 已prepare的请求在adapter注册被替换后仍调用原adapter；修改maxTokens或重复dispatch拒绝 | 用于执行阶段冻结；持久队列从enqueue到prepare之间的路由版本仍由本插件负责 |
| Agent钩子 | `agentEvents(ctx,agent).waterfall('agent/pre-step',payload,next)`注入agent；payload含messages、turn、step、signal；不相干scope监听器被过滤 | 接受并保留next的enter/reject决定，不能覆盖其他中间件。实际loop驱动与完整上下文注入旅程仍未运行 |
| Session事件 | `ctx.on('session/event',(session,event)=>...)`；内存事件有稳定seq、原消息id及冻结data；session.header.cwd存在 | 来源锚可组合session.id+event.seq+message.id；只处理当前获准输入。测试消息producer tag是合成值，真实前端来源白名单待核，不能把自定义测试tag当生产约定 |
| bundle入口 | AppBoot的dsh.bundle.patch、bundlePatchPaths及engines.dsh兼容门；插件管理器能识别绝对本地路径 | 正式package需补dsh.bundle/导出/精确兼容声明，现package仍不是bundle；实际Loader加载、Host UI远程管理及离线安装未验 |

## 必须自行适配的机制与原因

| 编号 | 实际发现 | 接入规则 | 最小后续验证 |
|---|---|---|---|
| HOST-ROUTE-01 | prepareCall只固定单次调用，不能代替队列入队时的routeVersion；pi-ai的registrationFacts仅列provider/displayName/retryPolicy | 检测完整的批准路由配置变化；不能只监听llm/adapters-updated就宣称能察觉baseURL/凭据引用变化。可先对loader配置更新保守失效，稳定持久版本策略须明确 | 同名provider/model改端点或凭据引用、未发出任务必须拒绝；在途请求不改端点；不能回显秘密 |
| HOST-FINISH-01 | BlockAssembler.finish在没有finish片段时也默认kind=stop；探针已直接复现 | 另行记录明确终结片段、流是否结束和signal状态；不能直接从assembler.finish填Provider成功响应 | 有text却无finish、finish后流不结束、取消后晚到stop均不得误提交或误解闸 |
| HOST-FINISH-02 | LlmRuntime.adapterStream会把本地构造/迭代异常转成error/aborted finish；probe故意让adapter抛错，流仍给finish | error/aborted本身不证明远端已停止。不得一概映射成Task 2 ProviderResponseError；传输失败保留unknown和锁 | 本地连接异常/取消只执行一次，不重发，不以合成终结片段当远端完成收据 |
| HOST-RETRY-01 | dsh-llm-retry接agent/request-error；pi-ai入口的请求选项写maxRetries:0 | 记忆调用走LLM服务，不创建聊天Agent来绕预算；所选实际adapter的内部重试/其他llm/stream中间件仍须验 | 一次记忆job只形成一次允许的wire dispatch；主动制造异常，不只数桥接函数调用 |
| HOST-SOURCE-01 | agent/pre-step消息并非天然都是用户输入；loop将source.kind=runtime-context当成自己的快照 | 消息producer白名单、唯一来源锚与插件自身标识分开；不要冒用runtime-context标签；不重新提炼召回、系统提示、工具/认证内容 | 自身注入/模型切换提示/重复event不再入队；真实前端输入可提炼且只一次 |
| HOST-SCOPE-01 | Session cwd只说明目录，未提供05所需worktree/revision/buildVariant完整身份 | 可信Host配置或已审本地身份解析补齐；缺字段拒绝，不能用cwd或聊天标题代替完整scope | 同目录不同revision/build与同名项目不串记录；跨scope管理/导出拒绝 |
| HOST-RECOVER-01 | 已审组件要求Host确认旧worker退出后显式recoverInterrupted，未知远端完成尚无本次探针可用收据接口 | 启动恢复按获准scope处理；重开DB不声称已清输入；无可靠结束收据就保持闸门，不实现永远true的authorizeRecovery | 真进程退出后输入清理和unknown保持；没有证据时UI显示待核，不提供盲重发 |
| HOST-GRANT-01 | Task 2 authorize为可信注入边界；本次没有装配真实用户授权服务 | 用户确认/证明根/可撤销读取grant和原始epoch须绑定当前操作；模型不能产生许可 | 撤权后零材料内容读取；旧预览不换成最新epoch再执行 |

SOURCE/Agent判断依据：[Agent分发](../evidence/host-api/dsh-agent/lib/index.js)、[loop预处理与runtime-context](../evidence/task3-host-api/dsh-agent-loop/lib/index.js)。LLM判断依据：[Runtime](../evidence/host-api/dsh-llm/lib/index.js)、[pi-ai](../evidence/task3-host-api/dsh-llm-pi-ai/lib/index.js)、[retry](../evidence/task3-host-api/dsh-llm-retry/lib/index.js)。这些均绑定本次安装摘要，其他alpha/主分支不替代此基线。

## 安装、网络和本地性仍需验证

1. **本地安装也要核实际包管理行为。** plugin manager的installBundle最终走pnpm add；绝对本地路径可被识别，不代表依赖解析、peer补齐和脚本一定离线。正式构件准备后需验证offline、禁止脚本与完整依赖闭包，不运行registry/Git安装路径来探测。当前没有调用安装器、修改用户profile或添加新依赖。
2. **遥测开关的已知范围。** AppBoot.resolveTelemetryPatch针对session-telemetry-otel行，DSH_TELEMETRY_DISABLED非空会生成disabled patch；本次测试核对这一函数。归档还含host telemetry和client analytics包，是否装载、开关覆盖及更新组件行为均未认证。不能以这一个patch或本次guard推导整个Harness无外发。
3. **当前盘快照。** 本次重新调用GetDriveTypeW，C/E/H均为3，见[证明](../evidence/task3-drive-proof.json)。这不是junction/TOCTOU/映射变化的持续保证；正式激活时仍要重新核定。真实junction及全宿主/子进程/浏览器出口旅程未执行。

## 交付顺序与证据边界

接口核对后先实现受控Provider桥接，先写HOST-ROUTE/FINISH/RETRY反例；再接当前消息提炼和召回、可信管理/证明授权、缺证提醒、版本化维度与完整年度导出。年度模板未提供仍为pending_reference，不阻塞粗粒度记录与标注导出。最后做隔离完整Host及负向出口、独立评审，满足门禁后再按用户已有授权安装和调用注册API。

本次10项通过只证明表中已实际运行的安装库API；没有启动完整AgentLoop或真实session persistence，测试flush返回false也明确说明未挂持久层。完整插件重复安装、召回去重、UI授权、进程恢复、真实Provider wire次数、完整年度导出、OS出口与模型质量均为待验证。Task 2原61项及源锁没有因本次探针被改写或重新认证。
