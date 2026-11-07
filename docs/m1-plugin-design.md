# M1可安装插件集成设计（v0.2.0）

版本 `MEM-PLUGIN-1`，2026-11-07。范围：把已受审的 Task 1/2/3 组件接成**第一个可安装的DSH记忆插件**，覆盖统一待办 M1（MEM-101..104）、基础管理界面（MEM-501的一部分）和年度工作记录的提醒/报告/本地导出（MEM-401..404的可用子集）。M2 abstract共享与M3非C冷档仍为后续增量，不在本版声称完成。

本文件是实现合同：模块接口、存储、配置、入口、管理API和验收。**2026-11-07状态：本设计已按v0.2.0实现并安装验证**；实现偏差（如`work.evidence.review`的同步dispatch限制、召回后删除的fail-closed代价）记录在[README已知限制](../README.md)与[完整机制](mechanisms.md)。阶段机制沿用Task 2/3文档。

## 0. 已确认的Host接缝（2026-11-07实测）

以下均经`cordis_inspect_query`核对当前安装Harness 0.2.1-rc.5：

| 接缝 | 合同要点 | 本插件用法 |
|---|---|---|
| `ctx.on('session/event',(session,event)=>void)` | emit，post-commit，失败被宿主收敛 | 当前用户消息准入、年度草稿来源、回执确认 |
| `ctx.on('agent/pre-step',(payload,next)=>Promise<PreStepDecision>)` | waterfall；payload含`agent,messages,turn,step,signal`；`enter`返回`messages` | 自动召回注入、缺证提醒注入 |
| `ctx.on('llm/stream',(options,next)=>AsyncIterable<StreamChunk>)` | waterfall，围绕每次流式模型调用；AgentLoop请求深冻结、不可改写 | **MEM-103最终请求门**：dispatch前复核召回投影；非法则返回`finish{kind:'error'}`且不调用`next()` |
| `ctx.llm.prepareCall({provider,model,maxTokens},signal)` | 返回`{config,stream}`，单次dispatch | 经既有`plugin/harness-provider.mjs`桥接复用；本插件不改其内部 |
| `ctx.tools.register(ToolDefinition)` | `name,description,parameters,output{shape,render},execute(args,exec)`；用`ctx.effect`绑定 | 记忆/年度工具 |
| `ctx.commands.register(CommandDefinition)` | `{name,description,handler}`；Remote可执行 | `/memory`用户动作 |
| `ctx.webServer.register({kind:'exact',path,handler})` | Node`req/res`；同源页面可直接`fetch` | 记忆中心管理API |
| `ctx.sessions.get(id)`、`ctx.agents.get(id)` | 活会话/活Agent身份 | 可信调用方解析 |
| `ctx.approval.request({agent,toolName,signal,...})` | 返回`allowed-once/rejected/cancelled/unavailable`，需开放turn | 仅用于显式“读取证明正文”的用户确认 |
| `ctx.effect(fn,label)` | fiber清理 | 所有监听器/定时器/资源的生命周期 |

结论：MEM-103的“最终准备请求与真正dispatch之间”存在**可证明接缝**（`llm/stream`waterfall在适配器真正的`stream()`前执行，且AgentLoop请求深冻结可核完整性）。若运行时版本缺少该事件，插件必须降级为“禁用自动追加、保留手动搜索”，并在状态中明确`recallIntegration:'unavailable'`；不得回退成把pre-step当最终门。

## 1. 包与入口

- 包名：`dsh-local-memory-linqu`（仓库名）；版本`0.2.0`；私有本地bundle。
- Host入口：`exports['.'] = ./plugin/index.mjs`；`apply(ctx, config)` + `export const inject = ['llm','tools','commands','webServer','sessions','agents','approval']`（2026-11-07实现时补齐后三项：准入/身份与证明读取确认需要；Cordis要求声明后才能访问对应服务）。
- Client入口：`exports['./client'] = ./client.js`；`dsh.client = {platform:'web', immediately:true, inject:['@deepseek-ai/dsh-client-locale']}`。
- Bundle patch：`cordis.patch.yml`插入`{id:'dsh-local-memory-linqu', name:'dsh-local-memory-linqu', config:{...}}`。
- 显示资源：`locale/en.json`、`locale/zh.json`（`meta.title`/`meta.description`+UI文案）、`icon.svg`（自绘，无第三方素材）。
- 不新增运行依赖；不使用`node:sqlite`以外的原生模块；不联网下载。

目录（新增文件由Lead与三名实现者按合同分工）：

```
plugin/index.mjs            宿主组装、生命周期、事件接线、工具/命令注册
plugin/configuration.mjs    配置校验、数据根解析、路径安全
plugin/project-registry.mjs 项目/仓库登记、会话→scope解析、store缓存
plugin/host-grants.mjs      准入回执、执行lease、撤权、恢复确认
plugin/scheduler.mjs        轮询调度、重启恢复、取消
plugin/final-projection.mjs llm/stream最终门
plugin/management.mjs       管理API（经验/项目/任务）+ HTTP处理器
plugin/work-management.mjs  管理API（年度/报告/证明）操作扩展
plugin/proof-reminders.mjs  缺证对话提醒（去重/延后）
src/projects.mjs            项目目录SQLite schema/读写（catalog.sqlite）
src/reports.mjs             年度报告草稿/审定/导出
client.js                   记忆中心客户端（无构建、React来自模块表）
```

## 2. 数据根与目录

配置解析后的`dataRoot`（默认`E:/dsh-data/05-local-memory/desktop`，`<base>/<profile>`）：

```
catalog.sqlite            项目目录、偏好、提醒状态、报告修订
catalog.identity.json     catalog身份（与dataRoot绑定）
hot/scopes/<scopeHash>/   openStore()的memory store（authority.sqlite+scope-*.sqlite）
reports/<reportId>/       本地报告导出
staging/                  预留
cold/                     预留（M3；本版不写入）
```

- 路径必须通过`checkedPath`（绝对盘符、固定卷、无符号链接、无网络路径）。生产默认卷为`E:`；C:只用于隔离测试和数据根显式配置。M3要求冷档非C；本版不创建冷档，`cold.status='not_configured'`。
- 每个具体`scopeRef`一个store与一个queue；store仍由`openStore(root,{scopeRef})`保证身份、权威账本和FTS。
- catalog identity缺失/不匹配时拒绝自动导入旧备份（复用Task2规则的精神），只报告`catalog_unavailable`。

## 3. catalog.sqlite schema v1

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects(
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN('active','retired')),
  revision INTEGER NOT NULL CHECK(revision>=1), origin TEXT NOT NULL CHECK(origin IN('config','user')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_reason TEXT);
CREATE TABLE repositories(
  project_id TEXT NOT NULL, repo_id TEXT NOT NULL, canonical_root TEXT NOT NULL, worktree_root TEXT NOT NULL,
  revision TEXT NOT NULL, build_variant TEXT NOT NULL, scope_ref TEXT NOT NULL,
  binding_revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
  PRIMARY KEY(project_id,repo_id), UNIQUE(scope_ref));
CREATE TABLE preferences(project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id,key));
CREATE TABLE reminders(scope_ref TEXT NOT NULL, record_id TEXT NOT NULL, claim_ref TEXT NOT NULL, record_generation INTEGER NOT NULL,
  last_shown_at TEXT NOT NULL, PRIMARY KEY(scope_ref,record_id,claim_ref));
CREATE TABLE reports(report_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN('draft','approved','stale')),
  payload TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE report_revisions(report_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, approved INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(report_id,revision));
CREATE TABLE operations(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
```

- 单writer：所有写操作在同一`DatabaseSync`上以`BEGIN IMMEDIATE`同步执行；`journal_mode=DELETE, synchronous=FULL, secure_delete=ON`。
- `projects.revision`为从1递增的乐观并发版本。所有管理变更带`expectedRevision`，不匹配返回`STALE_REVISION`。
- `repositories.scope_ref`唯一；同一物理scope不允许挂在两个项目。
- 删除/退休不删除memory store；`documented in MEM-203`。M1只实现`retire`（标记+停止绑定），保留查询/管理。

## 4. 配置schema（`plugin/configuration.mjs`）

```js
{
  dataRoot: 'E:/dsh-data/05-local-memory',   // 基础目录；实际根=dataRoot/<profile>
  profile: '',                                // 空=DSH_PROFILE或'default'
  security: {rejectNonLocalPaths: true},
  routes: [                                   // 批准Provider路由（仅用户patch可配置）
    {routeRef:'memory-default', provider:'deepseek-official', model:'deepseek-flash'}
  ],
  extraction: {routeRef:'memory-default', enabled:true, maxMemories:5, minInputChars:1},
  recall: {enabled:true, maxRecords:5, maxChars:4000, maxTokens:4096},
  projects: [                                 // 安装时静态登记（可选；name唯一）
    {name:'example', repositories:[
      {repoId:'main', canonicalRoot:'E:/code/example', worktreeRoot:'E:/code/example',
       revision:'workspace', buildVariant:'win-node24'}
    ]}
  ],
  scheduler: {pollMs:1000, concurrency:1, jobTimeoutMs:10000, recoverOnStart:true},
  limits: {dailyRequests:20, sessionRequests:5, dailyInputChars:80000, dailyOutputTokens:4096, maxOutputTokens:512},
  workSummary: {enabled:true, routeRef:'memory-default', evidenceRoots:[]},
  reminders: {enabled:true, cooldownHours:24, maxItems:3},
  reports: {exportRootRef:null, maxItems:200},
  tools: {namespace:'memory'}
}
```

校验规则：未知顶层键拒绝（fail closed，插件状态`invalid_config`，不注册任何工具/监听器）；`routes`至少1条且`routeRef`唯一；`extraction.routeRef`必须存在；整数上下限见`src/jobs.mjs`CAPS；`dataRoot`必须是`checkedPath`接受的本地绝对路径；`projects`最多64项、每项最多16个仓库；`name/repoId/revision/buildVariant`非空且无秘密模式。默认值集中导出`DEFAULTS`与`normalizeConfig(config)`。

路由描述符`routeApproval(routeRef)`返回`{routeRef,provider,model,routeVersion}`，其中`routeVersion = fingerprint({routeRef,provider,model,configDigest})`，`configDigest`是所有影响路由的配置字段摘要；配置任何变化即版本变化并使在途lease失效。

## 5. 项目与scope（`src/projects.mjs`+`plugin/project-registry.mjs`）

`createProjectCatalog({catalogPath, identityPath})`：

- `open()`/`close()`；`identity()`。
- `listProjects()`→`[{projectId,name,state,revision,origin,createdAt,updatedAt,repositories:[{repoId,canonicalRoot,worktreeRoot,revision,buildVariant,scopeRef,bindingRevision,enabled}]}]`
- `registerProject({name,repositories},{expectedRevision?})`→project view；项目名唯一；物理scope冲突拒绝`SCOPE_CONFLICT`；幂等：相同payload返回原view；差异返回`PROJECT_EXISTS`。
- `updateProject({projectId,expectedRevision,name?,repositories?,reason?})`：仓库集合变化时保留不变binding的`bindingRevision`、更新变化的、新增的、禁用移除的（不物理删除，`enabled=0`，保留历史来源可解释）；不允许把scope分配给另一项目。
- `retireProject({projectId,expectedRevision,reason})`：`state='retired'`，写reason；不删除repo行与memory。
- `getProject(projectId)`；`setPreference(projectId,key,value)`/`getPreference`。
- `resolveCwd({cwd})`：realpath+candidate；选择`enabled=1`且`worktreeRoot`是cwd前缀的**最长**binding；返回`{projectId,repoId,scopeRef,projectRevision,bindingRevision}`；无匹配→`undefined`。项目`retired`不参与解析。
- `recordReminder(...)`/`reminderDue(...)`。

`createProjectRegistry({config, catalog, openStore})`：

- `initialize()`：打开catalog、校验identity、把`config.projects`种子登记（`origin='config'`：同名同binding幂等；同名不同binding → 插件状态`config_conflict`并停止自动记忆，不覆盖用户数据）。
- `list()`/`register()`/`retire()`/`setPreference()`：带单writer与revision检查。
- `bindingForSession(session)`：用`session.header.cwd`→`resolveCwd`→binding；返回冻结对象`{projectId,repoId,scopeRef,projectRevision,bindingRevision,routeRef?}`；未登记返回`undefined`（会话继续普通聊天，记忆暂停）。
- `storeFor(scopeRef)`：按scope打开并缓存`openStore(join(dataRoot,'hot','scopes',digest(scopeRef)),{scopeRef})`，**直接返回MemoryStore对象**；`queueFor(scopeRef)`由entry注入的`createQueue(store)`懒创建并缓存JobQueue（含provider/limits/authorize回调）。辅助：`bindingForScope/activeScopes/allScopes/preferencesForScope/catalog/dataRoot`。
- `closeStores()`：逆序close。
- `projectForScope(scopeRef)`：反向索引。
- `status()`：`{state,projectCount,scopeCount,dataRoot,degraded[]}`。

## 6. 准入、授权与恢复（`plugin/host-grants.mjs`）

`createHostGrants({config, registry, sessions, agents, onDiagnostic})`：

- `admitMessage(request)`：session-hooks调用，`request={action:'extract'|'recall',scopeRef,sessionId,sessionRef,messageId,rpcId,contentHash,inputDigest?,authorizationVersion}`。必须：
  1. 活会话/活agent身份一致（`sessions.get(sessionId)`存在且`agent.id===sessionId`）；
  2. `registry.bindingForSession(session).scopeRef===scopeRef`且项目`active`；
  3. 项目偏好`extract`/`recall`开启；
  4. 路由`approved`且版本未变（实现对所有action校验**提炼路由**；因此路由被撤时召回也一并停用，属有意fail-closed）；
  5. 记录准入回执`receipts.set(key,{scopeRef,sessionRef,messageId,rpcId,contentHash,inputDigest,authorizationVersion,createdAt})`，`key=fingerprint({scopeRef,messageId})`。
  返回`{originRef,contentHash,authorizationVersion}`；任何不符抛错（hooks收敛为admission_refused）。
- `authorizeExecution(metadata)`：同步。检查metadata.scopeRef对应binding active、purpose允许（自动仅`memory_extract`/`work_summary_extract`；`work_summary_merge`只接受用户手动触发标记）、路由`provider.approved(metadata.route,purpose)`、**准入回执匹配**`sourceRef+sessionRef+inputDigest`（回执TTL=24h且同一source只能用一次；执行后标记consumed）、插件未停用。返回`{authorizationVersion,signal}`；signal来自本插件`AbortController`，在撤权/停用/配置变化时abort。失败抛错→queue写`execution_authorization_unavailable`且零调用。
- `authorizeRecovery(args)`：仅当`args.confirmationRef`命中管理API记录的用户确认（`recovery.confirm`，两分钟内、绑定jobId+status）才true；模型/工具不能创建。否则false→unknown保持隔离。
- `revoke(reason)`：abort所有lease、清receipts、版本+1、通知scheduler。
- `noteUserConfirmation({action,...})`：管理API用户动作登记。
- `status()`：`{leases,receipts,recoveryConfirmations,revoked,authorizationVersion}`。

## 7. 调度（`plugin/scheduler.mjs`）

`createScheduler({registry, grants, provider, limits, config, onDiagnostic, now})`：

- `start()`：注册`ctx.effect`或返回dispose；对每个已打开scope：`queue.recoverInterrupted()`（显式调用，按HOST-RECOVER-01）；然后定时tick。
- `tick()`：若在途数≥`concurrency`或已停用则返回；按项目顺序遍历scope，取最早`queued`（需在`src/jobs.mjs`新增只读`pending({limit})`和`list({state,limit})`），`runJob(jobId,{timeoutMs,signal})`；只执行本地`queued`，不重选Provider，不重发unknown；每1000ms轮询（可配置）。
- `status()`：`{state,running,pendingScopes,lastTickAt,lastError}`。
- `stop()`：停止轮询、abort本次活动、等待当前job（有界）后返回；不承诺远端停止。
- 一个scope同一时间最多一个任务；全局默认1个。

## 8. 最终请求门（`plugin/final-projection.mjs`）

`createFinalProjection({registry, sessions, onDiagnostic, now})`：

- `record(projection)`：由session-hooks在注入时调用；`projection={sessionId,messageId,textDigest,scopeRef,generation,revision,authorizationVersion,routeVersion,records:[{id,sourceRef,sourceVersion,generation,revision}],createdAt}`。
- `commit(sessionId,messageId)`/`invalidate(sessionId)`：已提交/失效。
- `install(ctx)`：注册`ctx.on('llm/stream', listener)`并返回disposer；listener：
  - 必须同步返回 `AsyncIterable`，不能声明为 `async` 或将 `next()` 包装为 Promise；Host waterfall 直接把返回值交给 `yield*` / `for await`。2026-11-07 回归修复见 [流接口修复记录](stream-contract-fix.md)。
  1. 从`options.sessionId`与`options.messages`找到本插件注入的消息（按`messageId`+文本摘要精确匹配）；无→`next()`原样（本请求不含插件追加内容）；
  2. 有：逐条复核projection绑定的声明是否仍active、`source/generation/state`一致、scope仍属同一active项目、`projection.authorizationVersion===grants.current()`、路由未变、项目召回偏好仍开；
  3. 复核`options`中该消息文本摘要与projection一致（深冻结请求，防内容替换）；
  4. 全部通过→返回`next()`；任一失败→**不调用`next()`**，返回只含一个chunk的异步可迭代：`{type:'finish',reason:{kind:'error',failure:{code:'memory_projection_stale',message:'...'}}}`，标记投影失效并诊断；此请求不得dispatch记忆内容。
- `verify(options)`：供隔离测试直接调用，不依赖真实LLM（实现命名；设计早期写作`verifyOnly`）。
- 边界：只能撤回本插件追加的整条消息；不撤回用户原消息、工具配对或已发送内容。无法识别AgentLoop请求（无sessionId/无匹配消息）时按“不含插件内容”处理并诊断`projection_unmatched_request`，不改写请求。

## 9. 管理API（`plugin/management.mjs`+`plugin/work-management.mjs`）

同源HTTP：`kind:'exact', path:'/dsh-local-memory/api'`，`POST` JSON：`{schemaVersion:1,operationId,expectedRevision?,input}`；响应`{ok:true,value}`/`{ok:false,error:{code,message}}`。
约束：仅接受`Content-Type: application/json`、`Origin`等于`ctx.webServer.getOrigin()`或缺失（本地Node客户端）、body≤64KiB、operationId≤128且幂等（catalog operations表）；不返回绝对路径/秘密；错误只回reasonCode。同步处理，单请求单写事务，不阻塞事件循环超过100ms（读分页）。

操作（Host服务方法同时供客户端和工具复用，遵循user-actions“一份实现两个调用方”）：

| operation | input | 说明/错误 |
|---|---|---|
| `status` | `{}` | 插件/项目/调度/降级状态 |
| `project.list` | `{}` | 项目与binding、偏好 |
| `project.register` | `{name,repositories}` | 用户动作；校验路径；`SCOPE_CONFLICT`/`PROJECT_EXISTS` |
| `project.update` | `{projectId,expectedRevision,name?,repositories?,reason?}` | |
| `project.retire` | `{projectId,expectedRevision,reason}` | 保留记忆 |
| `project.preference` | `{projectId,expectedRevision,key:'extract'|'recall',value:boolean}` | 项目级开关 |
| `memory.search` | `{projectId?,query,mode:'manual',limit,cursor?}` | 默认10/上限50；cursor绑定revision |
| `memory.list` | `{projectId?,limit,cursor?}` | 管理列表，含归档/失效状态计数 |
| `memory.get` | `{projectId,id}` | 详情+来源+verification |
| `memory.correct` | `{projectId,id,text,expectedGeneration}` | 生成新版本，旧版superseded |
| `memory.archive`/`memory.restore` | `{projectId,id,expectedGeneration}` | 可恢复动作 |
| `memory.delete` | `{projectId,id,expectedGeneration}` | 明确删除即清除；确认框文案由客户端展示 |
| `task.list` | `{scopeRefOrProjectId?,stateFilter?,limit,cursor?}` | 安全状态，含outcome_unknown |
| `task.inspect` | `{projectId,jobId}` | 状态、阶段、原因、actions |
| `task.cancel` | `{projectId,jobId,expectedGeneration}` | 取消=请求本地停止，不声称远端静止 |
| `task.confirmRemoteQuiescence` | `{projectId,jobId,status:'remote_finished'|'remote_cancel_confirmed'}` | **用户动作**，登记后允许卸载unknown锁 |
| `recovery.confirm` | `{projectId,jobId}` | 用户确认，供`authorizeRecovery` |
| `work.list`/`work.get` | `{projectId,limit?,cursor?}`/`{projectId,id}` | 年度记录（独立分区） |
| `work.correct`/`work.confirmClaim`/`work.confirmTime` | 草稿/确认 | 用户动作；模型不能自动确认 |
| `work.evidence.register`/`work.evidence.review` | 登记引用/读取并评估 | 读取正文需`ctx.approval.request`用户确认 |
| `work.merge` | `{projectId,id,draft,expectedGeneration}` | 只增未确认冲突 |
| `report.draft` | `{projectIds,timeRange,workRefs?,templateRef?}` | 生成草稿；源变化→`REPORT_STALE` |
| `report.approve` | `{reportId,reportDigest,sourceRevisions}` | **用户动作**；绑定摘要与源版本 |
| `report.export` | `{reportId,revision,format:'markdown'|'json'}` | 写`dataRoot/reports/...`；未审定只能导出draft标记 |
| `reminder.defer`/`reminder.disable` | `{projectId,recordId,claimRef,hours?}` | 缺证提醒延后/停用 |

客户端与工具共用`operations`对象：`createManagementOperations({...deps})`返回`Object.freeze({dispatch(operation,input,context)})`，`context`由调用来源构造（`{actor:'user'|'model'|'host',agent?,sessionId?}`）；涉及用户确认的操作用`actor!=='user'`直接`USER_ACTION_REQUIRED`。HTTP入口固定`actor:'user'`（同源本地用户手势）；工具入口固定`actor:'model'`。

## 10. 客户端（`client.js`）

无构建的`window.__ModuleLoader__.load`工厂；`require('react')`；`inject:['slots','locale']`。

- 注册`settings.section`页：`id:'local-memory'`, `order`可取10，`label`走locale（中文“记忆中心”/英文“Memory Center”）。页面内三个标签：**经验记忆**、**年度工作记录**、**处理任务**；列表＋右侧详情（窄屏上下布局）。
- 数据通过`fetch('/dsh-local-memory/api',{method:'POST',headers:{'content-type':'application/json'},body})`；5秒轮询仅在页面可见时；手动刷新按钮；错误显示reasonCode文案，不显示内部异常。
- 经验记忆：搜索；详情显示kind/text/来源引用/未核验/state/generation；动作纠正、归档、恢复、删除（删除需二次确认，明示“即清除，不可恢复”）。项目区提供登记（名称+仓库根/revision/build）、启用/停用自动提炼与召回、退休。
- 年度工作记录：列表、详情显示贡献/过程/结果/时间精度/来源/证明状态与待补证清单；动作确认本人贡献/时间、登记证明引用、延后提醒、生成草稿报告、审定、导出。
- 处理任务：状态queued/running/completed/failed/stale/outcome_unknown/quarantined、原因、可用动作；unknown显示“待核”和用户确认入口，不提供盲重试按钮。
- 只用`--dsw-alias-*`主题变量，不自带字号/颜色体系；所有文案经`ctx.locale`；组件卸载时清理轮询定时器；不写`document.body`、不读其他插件DOM。
- 已知限制（本版）：召回命中在聊天中作为一条带来源的“未核验本地记忆”消息显示（不另做可折叠提示卡）；视觉验证依赖安装后在用户页面确认，无浏览器控制时以slot注册与HTTP响应为准。

## 11. 工具与命令（model-facing）

工具（`ctx.tools.register`，参数用JSON Schema，不暴露scope/grant；scope从`exec.agent`→session→registry解析；未绑定项目时返回`UNBOUND`）：

| 工具 | 参数 | 动作 |
|---|---|---|
| `memory_search` | `{query,limit?}` | 当前项目手动检索，含来源/未核验 |
| `memory_remember` | `{text,kind?}` | 用户明确要求记住时手动保存（origin 'user'，source为当前会话消息） |
| `memory_list` | `{limit?}` | 当前项目列表 |
| `memory_get` | `{id}` | 详情 |
| `memory_correct` | `{id,text,newSourceVersion}` | 纠正（需新source version） |
| `memory_archive`/`memory_delete` | `{id,expectedGeneration}` | 归档/明确删除 |
| `memory_tasks` | `{action:'list'|'inspect',jobId?}` | 任务状态；无cancel/confirm（用户动作） |
| `work_list` | `{limit?}` | 年度记录列表 |
| `work_get` | `{id}` | 年度详情与证明状态 |
| `memory_status` | `{}` | 绑定/项目/调度状态 |

命令：`/memory`，`input.hint:'status | search <关键词> | remember <文本> | projects | register <名称> | retire <项目> | forget <id>'`；`register`使用当前会话cwd作为仓库根，是**用户手势**，可创建项目并生成绑定；命令结果返回简短文本。所有操作复用`operations.dispatch({actor:'user'})`。

## 12. 年度工作记录、缺证提醒与报告（本版子集）

- 复用Task 2已受审`src/work-summary.mjs`与`work-summary-evidence.mjs`：自动草稿仍经队列`work_summary_extract`；手动草稿/确认/证据登记走管理API（用户动作）。
- 自动草稿来源：当前会话用户消息入队`work_summary_extract`（独立job purpose）；`plugin/proof-reminders.mjs`在`agent/pre-step`检查当前scope中`pendingEvidence/pendingConfirmation`非空的active年度记录，按`(scopeRef,recordId,claimRef,recordGeneration)`24小时去重，向本轮追加一条简短提醒消息；用户可`reminder.defer`（+24h）或全局停用。提醒失败不得阻止普通聊天。
- 报告：`src/reports.mjs`在catalog层实现draft/approve/export；`draft`固定时间范围、项目集合、选中workRevision、缺证清单与`reportDigest`；源变化→`REPORT_STALE`；`approve`绑定reportDigest+sourceRevisions；`export`产出Markdown+JSON，含来源引用、未核验/缺证标记、时间精度、schema与manifest摘要，默认去除绝对路径；未审定导出文件名/内容标明`draft`。
- 《年终总结维度.md》未提供：`dimensionMapping:{status:'pending_reference'}`；报告不生成评分维度。

## 13. 插件组装与生命周期（`plugin/index.mjs`）

`apply(ctx, config)`顺序（全部资源用`ctx.effect`/disposer绑定；任何一步失败→回滚已注册项并进入`status.state='failed'`，不抛穿事件循环）：

1. `normalizeConfig`→失败则仅注册状态工具/路由（`invalid_config`）并return。
2. 构造`configuration`（routeApproval, policyHash, configDigest）。
3. 构造`catalog`/`registry`→`initialize()`；失败→`catalog_unavailable`降级（不注册提取/召回，保留手动搜索不可用并提示）。
4. 构造`harness-provider`桥接（`createHarnessProviderBridge({ctx,sdk,readApprovedRoute,cleanupBudgetMs})`）→`provider`；失败→`provider_unavailable`降级。
5. `grants`；`scheduler`；`finalProjection`；`management`。
6. 对每个已登记scope：`storeFor(scopeRef)`→`createJobQueue(store,{provider,limits,authorizeExecution,authorizeRecovery})`→scheduler.start()。
7. `installSessionHooks(ctx,{resolveScope,admitMessage,createUserMessage,onDiagnostic,limits})`：`resolveScope`返回`{scopeRef,store,queue,routeRef,generation,authorizationVersion}`；`admitMessage`走grants；`createUserMessage`用`sdk.createUserMessage`；投影通过`finalProjection.record`登记（hook扩展一个可选回调`onRecallProjection`，保持向后兼容）。
8. 注册工具、命令、HTTP路由、`llm/stream`监听器（finalProjection.install）。
9. `status()`暴露`{state,dataRoot,config:legal summary,projects,scheduler,provider,recallIntegration,degraded}`；`dispose()`幂等：停止scheduler→grants.revoke→hooks.dispose→provider.dispose→closeStores→catalog.close。
- 单writer/重复安装：沿用`globalThis[Symbol.for(...)]`owner表；同root重复安装抛错（宿主显示插件失败），不同realm不共享。
- 插件不处理API key；不创建聊天Agent；只走`ctx.llm`；不自动扫描历史会话（只处理当前事件）。

## 14. 验收与测试

| 验收 | 覆盖 | 观察 |
|---|---|---|
| MEM-A01a 项目登记/绑定 | 101/102 | 未登记会话不提取不召回、普通聊天继续；登记后同项目多仓各scope互不串；retire后不再绑定但记忆可读 |
| MEM-A01b 真实准入/撤权 | 101/103 | 无准入回执/错scope/错inputDigest/route变化→零prepare/stream、failed not_dispatched；撤权使旧lease的signal abort；unknown晚到不解锁 |
| MEM-A01c 最终请求门 | 103 | pre-step注入后`llm/stream`复核通过才dispatch；删除/停用/改版本→返回error finish、零stream、投影失效；无插件消息的请求原样通过；深冻结请求不被改写 |
| MEM-A01d 闭环 | 104 | 临时profile/合成源：登记→启用→当前对话入队→scheduler执行（假adapter）→持久保存→新会话召回→查看来源→纠正→删除→重启/晚到结果不复活 |
| MEM-A01e 管理/年度 | 501/401..404 | 管理API读/纠正/归档/删除/任务状态；年度草稿→缺证提醒去重→确认/证明登记→报告草稿→审定→本地Markdown/JSON导出；断模型仍可导出 |

测试形态：Node 26 `node --test tests/*.test.mjs`；FakeHost夹具（真实waterfall语义+假llm/会话），不启动真实profile；真实安装库隔离探针（`tools/test-m1-host.mjs` + `tools/host-api/m1.test.mjs`）验证`llm/stream`waterfall与最终召回门；安装到当前profile后用`cordis_inspect_query`核对插件行、工具、slot与HTTP响应。证据写入`evidence/m1-*.json`与TAP，含命令、退出码、摘要与未证明边界。

## 15. 本版明确不做/降级

- M2 abstract二次压缩与跨项目共享索引（`src/abstracts.mjs`/`src/sharing.mjs`）：不实现；项目目录已为多仓保留接口。
- M3 非C冷档、二次压缩、tier迁移与清理：不创建`cold/`数据，`cold.status='not_configured'`；明确删除仍走权威账本。
- 年度维度模板映射（`MEM-405`）：`pending_reference`。
- 聊天可折叠召回提示卡：本版以带来源消息呈现；视觉优化后置。
- 安装/更新/卸载的完整宿主组件清理（MEM-502）依赖本轮实际安装验证；卸载默认保留`dataRoot`。
