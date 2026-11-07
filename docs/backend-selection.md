# 05 本地记忆：kovey来源核查与最小复用决定

日期：2026-11-04。范围：只读公开源码、manifest、dist目录与本项目PLAN；本报告未安装包、执行上游、调用模型API、读取凭据配置或修改实现。主代理已确认其选定Node 26.13具备内置SQLite/FTS5；该运行检查不是本报告新执行的结果。实际Harness安装/运行实例仍由集成阶段重核。

## 1. 建议

推荐**固定v0.3.2中两个无依赖纯模块，以及必要的FTS查询构造函数；在本项目权威scope/generation/tombstone/job层下适配**，不加载上游完整插件。最小直接复用的是`cjk.js`和`redact.js`；二者在旧审查commit与当前v0.4.0的对应源码、dist字节内容相同。这样既利用已有中文检索/脱敏规则，又不把Git同步、远端embedding、自动Markdown导入及宽松scope/路由带进首版。

SQLite/FTS可选更大复用闭包，但原版schema与接口不包含本计划所需的scopeRef/sourceVersion/generation/tombstone。若直接用其records表，必须做明确版本迁移和所有读取/写入适配；不能只在外层检索后过滤。对于首版尚无用户库，采用本项目显式schema，并复用查询构造与CJK算法，改动面更小、更容易证明隔离；这不是另造记忆算法或复制整个上游。

Provider路由参考上游`resolveDistillRoute`和`optionalLlm`，用本地薄适配冻结路由再调用DSH服务，不复制整个`distillTurn`/hook链。v0.4.0的水位/pinned/配额可后续按确有需要摘取，不为它升级Host或自动迁移现有用户记忆。

## 2. 固定来源与版本差异

| 项目 | 旧审查基线 | 当前调查HEAD |
|---|---|---|
| commit | `73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c` | `513eff904252f4f91dbeaa787e2062a9bf2c754c` |
| package版本 | 0.3.2 | 0.4.0 |
| 包入口 | dist/index.js | dist/index.js |
| 声明许可 | package.json `Apache-2.0` | package.json `Apache-2.0` |
| Node engines | `^22.19 || >=24` | 相同 |
| DSH peer | `>=0.2.0-rc.2 <0.2.2`；Cordis `~4.0.4` | 相同；发布说明称Host侧零变更 |
| 上游SQLite schema | 5 | 6（增加pinned及相关迁移） |
| 主要新增 | 已有FTS/CJK、受限蒸馏、分层scope | 文本导出水位last_export、rebuild保护未导出记录、召回quota/maxBodyChars、embedding预算、pinned生命周期 |

来源：[v0.3.2 manifest](https://github.com/kovey/dsh-memory/blob/73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c/package.json)、[v0.4.0 manifest](https://github.com/kovey/dsh-memory/blob/513eff904252f4f91dbeaa787e2062a9bf2c754c/package.json)、[固定v0.4.0提交](https://github.com/kovey/dsh-memory/commit/513eff904252f4f91dbeaa787e2062a9bf2c754c)。peer范围只是声明，不代替0.2.1-rc.5真实插件组合/Provider测试。

许可材料缺口：对两个固定commit的根`LICENSE`/`NOTICE`请求返回404，HEAD根目录也未列出这两个文件。因此事实是“manifest声明Apache-2.0”，不能写“已取到完整上游LICENSE/NOTICE”。vendor时保存来源、原注释、commit/文件摘要、Apache声明与修改说明，补核发布物/上游是否附完整许可材料；在分发前落实相应许可文本与归属，不把GitHub blob SHA当安装包摘要。此处不作组织法律适用结论。

## 3. 最小复用清单与运行依赖闭包

下列路径均相对固定上游仓库。TS的type-only import在dist中擦除；实际执行优先锁定现有dist字节并同时留源出处，不能直接把`.ts`改名`.js`或让Node临时下载编译器。

### A. 推荐直接vendor的叶子

| 源码 / dist | 接口 | 运行依赖闭包 | 取舍 |
|---|---|---|---|
| `src/store/sqlite/cjk.ts` / `dist/store/sqlite/cjk.js` | hasCjk、cjkRuns、cjkBigrams、queryBigrams、splitTerm、cjkClause | 无import，无fs/网络/子进程 | 直接复用；两个基线dist blob均`b2ad929db70287f2e6b2647955d91df0abb523e4` |
| `src/learn/redact.ts` / `dist/learn/redact.js` | `redact(text, policy='redacted', maxChars=400)` | 无import | 仅作为过滤链组成件；两个基线dist blob均`6657688d298ad01ed25a366620bd6c537f1bb016` |
| `src/store/sqlite/records.ts` 的`extractTerms` | text→去重检索terms | 函数自身无其他依赖 | 可摘取保持原作者/修改说明；不用为一个函数导入整records模块 |
| 同文件`buildMatchQuery` | terms→quoted FTS MATCH或undefined | hasCjk+cjkClause→上述cjk叶子 | 可摘取作为FTS安全表达式构造；SQL参数仍由本地DB适配绑定，不能拿它替代scope校验 |

上述字节一致性来自本轮直接读取两个commit的源码内容和dist目录blob标识比较，不表示已执行函数/测试。实施source-lock还需记录所落地字节的SHA256，并在装包前核验。

### B. 如果选完整SQLite轻核：闭包必须整体固定

```text
dist/store/sqlite/records.js
  → node:crypto
  → ./cjk.js
  → ./db.js
       → ../../log.js → node:fs + node:path
       → ./cjk.js
       → ./schema.js
       → dynamic import node:sqlite
```

源码还引用`src/store/types.ts`等type-only类型；其对应类型/字段和schema必须一致。`db.ts`导出loadSqliteModule/probeSqlite/openDatabase/migrate/transact/getMeta/setMeta等；`records.ts`导出materialize/upsertRecord/getRecord/listRecords/rawSearch/buildMatchQuery/extractTerms等。该闭包本身未导入sync、semantic或Provider，没有已发现HTTP客户端；但log为文件写入且不做统一秘密过滤，DB迁移和回退语义仍需修改，不能据无fetch就宣称可直接加载。

`src/store/sqlite/schema.ts`负责records/evidence/usage等表与外部内容FTS触发器。删除/更新触发器使用FTS5 delete记录维护索引，这一同步模式值得复用；它不包含本计划的独立删除清单。v0.3.2与v0.4.0的schema/db/records均有差异，禁止交叉混用。首版没有既有库时应显式锁本项目schema，不尝试打开或自动升级用户的上游memory.db。

### C. 可选排序/预算叶子

`dist/recall/rank.js → dist/store/types.js`（后者仅常量LAYER_WEIGHT，类型擦除后无执行依赖）。可复用estimateTokens/normalizeRelevance/fitBudget，但token估计必须标估算；rankRecords排除archived/superseded不等于满足本项目scope/sourceVersion/tombstone约束。SessionState自身无import，然而注入去重仅按sessionId+recordId，预算为进程内状态；不可原样用作跨版本/跨scope有效性或持久作业账本。

## 4. 明确不载入的入口与闭包

| 不直接载入 | 实际依赖/行为 | 为什么不能只写配置false |
|---|---|---|
| `src/index.ts` / dist/index.js | createEmbeddingProvider、ScopeResolver、StoreRegistry、registerTools/registerHooks | 顶层整合扩大模块闭包，并非最小本地store入口 |
| `src/hooks/index.ts` | AutoCommitter、ensureRepo、semantic维护、episodes/metrics/consolidate等 | 静态引入Git链和自动维护；本地控制不靠“没点同步”证明 |
| `src/tools/index.ts` | syncTool、import/rebuild、ensureEmbeddings等 | 工具集合含不需的网络/导入/升级面，注册即提供能力 |
| `src/store/store.ts` StoreRegistry | export/import/bootstrapImport/metrics/versioning、开库后文本导入 | 关闭时/恢复时文本可成为真源，旧Markdown可能重新导入；闭包带Git探测和文件写入 |
| `src/recall/engine.ts` | semanticRecall/blendRelevance + ScopeResolver，默认项目召回可附global | 不能把仅词法首版寄托于semantic.enabled=false；复用叶子，单独实现scope-first查询 |
| `src/recall/semantic.ts` | fetch向`baseUrl/embeddings`；可从配置指定环境变量取key/baseUrl | 首版不需要；不能扫描其他环境key/endpoint，也不能把主模型许可扩大为远端embedding |
| `src/store/rebuild.ts`、import/export链 | 从lessons/metrics/episode重建，v0.4增加水位与force | 水位保护新增记录不等于防删除复活，不能覆盖权威tombstone |
| `src/learn/distill-runner.ts` | 可选ctx.jobs，不可用时inline回落；内存inFlight，不跨进程存活 | 必须改成本地持久job及确定路由/预算/代次；不能复用为“已可靠队列” |

`src/paths.ts`亦有execFileSync作Git根探测，不能把整个路径模块当纯函数依赖；若只需ensureDir/路径归一化，应本地实现严格root检查，避免隐式process.cwd/仓发现或脚本执行。

## 5. 上游必须patch/替换的行为

1. **Scope失败封闭。** `src/scope/resolver.ts`缺session cwd会用process.cwd，无repo则返回global；`recall/engine.ts`默认可加global。新代码必须由可信调用方明确scopeRef，缺失拒绝；global必须显式授权。同仓worktree的路径归并不能抹掉sourceVersion/build variant。
2. **读写身份。** `records.ts`的getRecord只按id，upsert使用id主键，原设计依赖每root独立DB。若本项目采用单DB，必须改为(scopeRef,id)等复合键及所有查询约束；若独立DB，开库路径要由已登记scope映射，不接受模型路径。rowToRecord对缺scope/status的global/active默认不可作为边界。rawSearch的可选filter不是授权，FTS、正文、管理/导出必须同一scope/sourceVersion/state校验。
3. **权威删除。** 两版schema均未提供本计划独立tombstone/generation；memory_forget位于`src/tools/consolidate.ts`，语义是archive而非物理删除。应区分归档、停召回、物理删除并保存独立无正文删除账本；forget/纠正/来源失效在写事务可见前使缓存失效，晚到job持旧代次拒绝。恢复先重放权威删除状态，缺清单拒绝开放，旧备份/Markdown/episodes不能复活内容。
4. **缓存与去重。** QueryVectorCache key为model+query，是查询向量缓存，不是本地召回结果有效性保证。新召回缓存至少带scope/query/policy/index generation，命中仍查权威记录代次/state/sourceVersion；无复核不能回退旧正文。SessionState的已注入id应扩展scope+版本，否则纠正后可能不重召回；重复来源不能累加为独立证据。
5. **秘密过滤。** 上游实际API叫redact，不存在本轮已核实的独立secretFilter模块。redact允许full绕过滤、none丢文本、redacted启发式过滤，并明确偏向保留证据而可能漏判。新secretFilter必须先阻断已知秘密/credential来源及敏感上下文，统一覆盖模型输入/结果、store、audit、错误、导出/备份；不得向模型暴露full开关。不能承诺任意短密码或无上下文秘密都能由regex自动识别。
6. **错误与降级。** db.ts在FTS创建/rebuild失败可能仅记录warn，rawSearch异常可回落LIKE。允许降级只能在同scope且可确认索引/源状态下返回显式lexical/degraded；不能把损坏索引、权限/代次失效吞掉后查更宽范围或旧缓存。新库schema未知或高于支持版本应拒绝；不原样沿用允许继续读取更高schema的开库策略。
7. **SQLite事务。** 上游upsertRecord同时修改record和evidence，调用者负责transact；空evidence时保留旧evidence是文本导入兼容语义，不适合“删除来源证据”的新合同。新事务必须覆盖record/evidence/代次/请求幂等/FTS与缓存可见性，scope删除/备份恢复另有明确顺序，不把事务外文件写入当DB原子提交。
8. **输出与日志。** log.ts是file-only但format(Error)含原始message，字符串原样写；不打印stdout不等于秘密安全。采用本地安全审计接口，只输出事件ID/状态/引用，错误原文经统一过滤。未知费用/用量标未知，timeout不承诺服务端未处理或不计费。

## 6. Provider与DSH 0.2.1-rc.5的薄适配

两版`src/learn/distill.ts:89-96`的resolveDistillRoute优先显式distillModel，否则agent.options.provider/model；无完整route返回undefined。`distillTurn`实际执行时再次读request.agent路由与scope，而不是入队时冻结，不能原样满足A入队后切B的约束。应在enqueue绑定routeRef/provider/model/scope/sourceVersion/generation/purpose/sessionRef，执行前核代次和批准状态，仅用绑定路由或暂停；禁止环境key、CLI和其他Provider回落。

`src/learn/llm-access.ts`使用`ctx.reflect.get('llm',false)`取得可选服务，并以直接属性读取兼容test doubles。正式适配应按锁定Host声明/取得服务，缺失返回unavailable，不让fake ctx.llm的可用性冒充真实Cordis组合。建议不依赖其为测试而设的direct fallback；纯store在无模型时仍可工作。

上游模型调用用`llm.stream({provider,model,messages,system,maxTokens,sessionId,signal,...})`，使用DSH的createUserMessage与BlockAssembler解析，reasoningEffort为可选品牌类型。新适配应核实际安装包导出后使用公开API；模型空回复、finish aborted/error、schema非法、取消与timeout均明确状态，不自动重试产生重复计费。上游estimateTokens仅估算，不能替代实际Provider计费证据。

可借鉴的Host接口来自固定v0.3.2源码：

- tools通过`ctx.tools.register(defineTool(...))`注册并保存disposer；只宣传实际注册成功工具。
- prompt通过`ctx.systemPrompt.section(...)`；agent局部注册使用agent.ctx并在`ctx.effect`卸载。
- `agent/pre-step`是waterfall，原createPreStepHook先await next()，只在decision.kind=enter及messages数组时生成带plugin source的召回消息。必须保持next调用、调用对配和当前用户指令；正文作为资料，不提升为system授权。
- agent/created、agent/turn-stopping、session/disposed按实际Host载荷确认，先fixture测试注册/卸载，再隔离真实profile验证；不能混用本机另一份0.2.2-alpha.2源码类型。

尽管v0.3.2/v0.4.0 peer都覆盖0.2.1-rc.5，是否导出相同createUserMessage/BlockAssembler/工具schema仍须运行时核验。现有Host未运行不是源码接口通过证据。当前报告不调用已注册模型API、不安装插件；主代理在安全本地测试通过后再按用户许可实施真实Harness集成与API测试。

## 7. 本轮选择如何落到05计划

1. `source-lock.json`锁旧commit的cjk/redact原字节与源码映射、提取FTS函数来源/修改记录；若另取v0.4函数必须逐文件锁，不能只写“kovey latest”。记录包许可声明及LICENSE/NOTICE缺口。
2. `src/backend.mjs`保持本项目put/search/close与真实SQLite/FTS，显式schema/scope/sourceVersion/generation；不要import上游dist/index.js、StoreRegistry、hooks/index.js或semantic.js。若采用更大SQLite闭包，按§3B完整锁定并补§5全部patch及测试。
3. `src/provider.mjs`只把已绑定批准route转为真实DSH服务调用；`src/jobs.mjs`与`src/lifecycle.mjs`拥有持久请求身份、预算、unknown、删除账本及缓存失效。上游纯排序/过滤函数不代替这些边界。
4. 源码锁测试除摘要外验证运行import闭包，不出现sync/semantic/child_process/动态安装。导入纯vendor不应创建目录、写日志或发网络；这些均留给本地TDD实际证明，报告不声称已通过。

优先测试缺scope拒绝、A/B同名隔离、热缓存后forget、旧备份删除账本、晚到job、A入队切B、FTS损坏与秘密金丝雀。这些正对应现有PLAN而非新增无界平台。报告完成不等于backend代码、插件安装或API集成完成。

**接下来该怎么做：** 用约20分钟把两个纯vendor文件及FTS构造来源写入source-lock测试，预期在摘要不符或出现sync/semantic闭包时失败；实际vendor与测试由主实现任务完成，本报告不执行。
