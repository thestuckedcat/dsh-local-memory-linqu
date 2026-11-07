# MEM-01独立代码复审与年度工作记忆方案评审

日期：2026-11-04。实现协调：`/root`；年度方案设计：`/root/design`；独立审查：`/root/memory_task1_review`。审查者只读，不修改源码、不安装、不调用业务模型API、不另派Agent。没有Git基线，按源码和证据摘要固定当前字节。

## 两个分别成立的结论

1. **MEM-01本地后端：限定当前Windows机器及已核定固定盘快照，通过组件验收与独立代码复审。** 独立重跑正式21项：21通过、0失败、0skip、exit 0。主代理在独立Node26.13.0和安装包内嵌Node24.21.0均实际运行同一组21项并保存TAP。
2. **年度工作记忆：通过独立方案评审，可进入Task 2/3；尚未实现。** 工作总结collection、贡献/结论/结果/时间/来源、断言级证据状态、缺证提醒、未知年度和显式跨scope完整导出均有设计。未来《年终总结维度.md》尚未提供，保持pending_reference。完整机制说明合同按用户要求服务于后续skill改进。

**不认证完整plugin、安装、Provider请求、Host服务激活或Task 3出口。** Task 1没有DSH bundle入口；模型队列、权威删除及年度工作记录仍待实现。

## 审查发现与关闭证据

| 编号 / 初始级别 | 实际问题 | 修订及复核 |
|---|---|---|
| T1-01 / Important | 删除FTS插入trigger后仍开放；put/get成功但search漏记录，下一次重开才报错 | 核对受信SCHEMA生成的完整schema指纹和FTS内容；缺trigger、改写trigger、错FTS定义均在开库时拒绝；真实临时SQLite回归通过 |
| T1-02 / Important | client_secret、refresh_token、DATABASE_PASSWORD、AWS_SECRET_ACCESS_KEY、OPENAI_API_KEY假凭据可保存/导出 | 扫描赋值字段名，统一常见前缀、下划线和camelCase；假凭据在真实存储前拒绝，导出无记录 |
| T1-03 / Important | UNC/设备/映射盘未在I/O前拒绝；从叶子往上检查会先穿过父链接 | 纯词法检查→已核定C/E/H固定盘快照→从盘根向下逐段lstat；未知盘不探测，遇link先拒；I/O边界负例通过，限制见下文 |
| T1-04 / Minor | 查询最少两字符，丢掉vendor支持的单字CJK | 查询保留单字CJK，真实库“云”召回通过 |
| T1-05 / Important（复审） | 非敏感赋值吞掉后续password/api_key，分号串和URL查询文本漏判 | 改为只消费赋值头，向后检查值而不吞掉后续字段；先红后绿；审查者另用真实临时SQLite重验两个负例均拒绝、导出0条；未访问URL |
| T1-06 / Important（主代理收尾发现） | schema排除条件LIKE中的下划线通配符会忽略sqlitex_extra附加trigger | 新负例先复现绕过，再取消名称过滤，核全部非null SQL对象；独立审查者确认最小delta并重跑21项通过 |

初审及后续复核发现均已修正，最终复核字节内未留Critical、Important或Minor。审查不是仅采信主代理测试数：审查者独立运行正式全套，并额外复现触发器、凭据、单字查询及扫描回归。

## 机制与来源复核

- 独立scope库及正文/FTS/管理查询约束，无global自动回退；来源身份不可覆盖，同源同版本同正文跨重开幂等。
- 事务覆盖记录、代次与FTS写入；快照溢出明确拒绝。Task 1尚未开放恢复或删除操作。
- 唯一vendor为固定kovey CJK叶子模块，无执行依赖；实际Git blob为`b2ad929db70287f2e6b2647955d91df0abb523e4`。完整性门禁先于动态import，篡改vendor无副作用用例通过。
- 许可声明、标准文本与来源说明一致，未冒称上游提供了根LICENSE/NOTICE；未加载上游完整同步/导入/embedding链。
- 年度方案与[机制说明合同](shared/mechanism-document-contract.md)明确场景/触发/判断/工具/状态/证据/失败，以及skill可调策略与代码硬边界。文件存在、用户确认或模型confidence不等于整条成果已证实。

## 未认证边界

- C/E/H是本次[GetDriveTypeW固定盘证明](../evidence/task1-drive-proof.json)的当前机器快照；Host安装/激活前必须重新核定，未知或变更不得自动放行。不是跨机器、盘符变更后或本地管理员并发换目录的持续保证。
- 真实junction创建在sandbox返回EPERM。最终祖先检查测试只替换OS reparse元数据边界，验证先拒父节点再走后代；没有实际网络路径或远端junction探测。真实OS与完整出口仍待Task 3。
- 不认证任意秘密的完备识别、Windows以外平台、模型质量、生命周期/旧备份、年度记录的实际运行效果。
- 内嵌Node测试是组件运行时验证，不等于Cordis Host profile及Provider旅程通过。

## 最终受审实现与证据SHA256

以下相对于05-local-memory。实现文件固定后未再修改；状态文档与任务勾选在审查结论返回后单独收尾，不冒称其旧摘要代表新字节。

| 文件 | SHA256 |
|---|---|
| src/backend.mjs | `1351c08aac51e5ad7e65167b3d79f109a8b0c7aa73af5639ce7612ec2965a0b7` |
| src/scope.mjs | `c0132dc72298afef0e01165a157b95dfed9375ce6c06f05cd30338e95db05335` |
| src/source-lock.mjs | `d255aff3e5b72717bee07a09bf0e2113bb4baa8418063bb6fbc48dd1b30ed57e` |
| tests/backend.test.mjs | `5cc9015bdfe21a699df2049d23273b0ccf74e46dcd1c3e59c0e03053eb84b47c` |
| tests/source-lock.test.mjs | `07211942864697b8c64962623419bec4bef6504bdd89ee3207a26b8d6486a3f7` |
| source-lock.json | `9d732ce280ca6dc9a42315cec4f89040812700765050870a519c50f89f64cd54` |
| vendor/kovey/cjk.js | `95d0db52226fa4719d679a4a4cc2ed0de7f232cf8e2e0d304c9d752af2b6c8cb` |
| licenses/Apache-2.0.txt | `074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff` |
| licenses/kovey-package.json | `7b988c63272cbbe6f1b4ee68c503cdbc5532ce6495ec7b159183881a82caf242` |
| THIRD_PARTY_NOTICES.md | `c055bd796660fc8092de63fd3a32bf5467b40d0dd44106edd745138e701d6433` |
| package.json | `613534c10028128c44a6f1d67cbe58cdaf7d4628815a37765c20b15b64953016` |
| evidence/task1-drive-proof.json | `46710fbde9550604c5d3de8e40e596c08a3bd884eae40a26c9f538cbdf00aa52` |
| evidence/task1-node26.tap | `ccd74a29a52353c97923d6679c245308c7b3382594eaec1e1eec6c3b679f6307` |
| evidence/task1-host24.tap | `f042fe663f70ce3b81a864c50e1b9a6e0d6982ff873e85b2bbd4ae3e28d606c3` |
| evidence/task1-host-runtime.json | `9357cbc98a018a62a833621234367b75a91570fa4416427af4b27e72bcc2184d` |

年度设计受审快照SHA256为`ccd0fbed5d3a60144b0bda263241f8fce6e91f009f2a6c0d8948a221fd3bdd2d`；审查后仅首段改为“已评审、待实现”并链接本报告，当前状态字节SHA256为`355e8d6ee8d80e7fa64f3faf49a5d53db685a9db383ccfc4489a06f4a587a281`。不将方案通过写成新增能力运行通过。

**接下来该怎么做：** 进入Task 2，先用约30分钟建立固定Provider/代次的队列与删除恢复负例，再按已审方案加入独立年度工作记忆结构；先看到错误路由和旧任务写回被拒，才继续Host接入。
