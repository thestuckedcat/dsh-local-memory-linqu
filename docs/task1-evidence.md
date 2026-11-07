# MEM-01 来源、运行时与本地后端证据

日期：2026-11-04。状态：限定本机的MEM-01组件验收及独立复审通过；**不是完整plugin交付或安装准入**。实施路线与每个来源的具体机制见[开工说明](implementation-route.md)，关闭问题与固定摘要见[复审记录](task1-review.md)。

## 已固定物料

| 物料 | 本次核定 |
|---|---|
| 宿主安装归档 | DSH 0.2.1-rc.5，build `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`；app.asar SHA256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915` |
| 宿主可执行文件 | SHA256 `7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4` |
| 内嵌运行时 | 以Electron Node模式实际探测：Node24.21.0、Electron44.7.0；真实SQLite/FTS测试通过 |
| 独立测试运行物料 | 从本机既有安装复制Node26.13.0，SHA256 `14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5`；不下载、不安装依赖；不是要随插件发布的第二个生产运行时 |
| 唯一vendor | kovey/dsh-memory 0.3.2固定commit的`dist/store/sqlite/cjk.js`，Git blob `b2ad929db70287f2e6b2647955d91df0abb523e4`；正式文件SHA256 `95d0db52226fa4719d679a4a4cc2ed0de7f232cf8e2e0d304c9d752af2b6c8cb` |
| 许可 | 保留上游manifest Apache-2.0声明；本次核根LICENSE仍404。另备标准Apache-2.0文本、取件blob及归属说明，不虚构上游NOTICE |

正式vendor与上游Git blob精确一致。历史实验写入时多了一个末尾换行，正式取件已去除这个序列化差异并重新算SHA256；未修改CJK算法。source-lock与源码门禁均固定正式原字节。

## 实际运行与兼容结论

安装归档与可执行文件只读核定。以`ELECTRON_RUN_AS_NODE=1`启动独立Node探测/测试进程，没有启动Harness UI或用户profile。实际导入安装包的dsh-llm、dsh-tools、dsh-agent入口后，核定`createUserMessage`、`BlockAssembler`、`LlmRuntime`、`defineTool`、`ToolRuntime`及`AgentRegistry`均为function；结果见[evidence/task1-host-runtime.json](../evidence/task1-host-runtime.json)。

**可确认：** 当前实际宿主运行时满足此本地后端的SQLite/FTS和ESM要求，拟用公开导出存在。**尚未确认：** Host服务激活、真实ctx接口/事件载荷、原生钩子、UI、Provider调用及网络出口。安装包manifest声明的types路径未出现在本次读取的归档对应路径中；Task 3须用实际Host检查和lib实现继续核对，不能借另一份alpha源码补兼容结论。

运行导入只检查模块导出，不构造Provider、不读取凭据或真实会话。当前没有业务模型请求、插件安装和真实历史导入。安装包还声明更新服务；这将作为后续出口门禁的实际检查项，当前不宣称整个Harness无外发。

## 正式后端行为

- 每个显式scope使用独立SQLite文件，schema和文件中的scope身份同时核对；createScope由可信调用方提供真实项目/工作树、revision/dirty及构建变体，缺字段拒绝，不运行Git发现或降global。
- 保存来源引用、版本、种类、正文摘要和代次；同一id不能换来源或正文，同源同版本同正文幂等，不积累独立证据。
- 全文、中文查询、get/list和管理导出保持同一scope；所有SQL参数绑定。没有模型/网络服务时仍可检索和重开。
- 未知schema与损坏FTS明确拒绝；固定schema/FTS/三条触发器及索引结构与受信schema指纹核对，缺失或改写拒绝，不自动修复。JSON式秘密标签、常见前缀/camelCase credential名和token模式拒绝；未知字段/模型路径字段拒绝。启发式过滤不是完备的秘密识别系统。
- 快照导出在同一事务内取得一致视图；上限500，溢出明确拒绝，不静默丢记录。本任务未提供恢复、forget或更正入口，权威删除状态由Task 2实现后再开放。
- vendor在执行前通过原字节和封闭集合校验；新增网络文件、源码改写、缺许可、未知宿主/运行时均有拒绝用例。该门禁不声称能抵御有权限者替换整个插件或运行时。

## 测试证据

先执行正式失败用例确认门禁/后端缺实现，再实现。补充JSON秘密标签及501条快照边界时，两项分别复现缺少拒绝的失败。独立初审另发现缺/改触发器、常见复合凭据标签、UNC/映射盘及先访问链接子路径的缺口，均先加失败行为用例再修正；单字CJK查询也已补回归。复审又发现普通赋值吞掉后续凭据标签的扫描缺口，已先复现分号/URL查询参数负例，再改为只消费赋值头、逐个验证字段。收尾时主代理另发现LIKE前缀过滤的通配符缺口；新增sqlitex_extra触发器负例先红，再改为核全部非null SQL对象，已由审查者独立复核。

| 运行方式 | 结果 | 输出 |
|---|---|---|
| `.\runtime\node.exe --test tests/*.test.mjs`，Node26.13.0 | 21通过，0失败，0skip | [task1-node26.tap](../evidence/task1-node26.tap) |
| 安装包Electron Node模式，内嵌Node24.21.0，运行同样两份正式测试文件 | 21通过，0失败，0skip | [task1-host24.tap](../evidence/task1-host24.tap) |

Native测试实际argv：`--expose-internals --test --test-reporter=tap --test-reporter-destination=E:/dsh/plugin/05-local-memory/evidence/task1-host24.tap tests/backend.test.mjs tests/source-lock.test.mjs`；cwd为05目录，Node父进程用spawnSync传argv、`windowsHide:true`、仅对子进程设`ELECTRON_RUN_AS_NODE=1`，不改用户环境或profile。

这些是实际运行时上的组件测试，不是Cordis Host服务/完整插件G2集成测试。Task 2/3、缓存/删除/旧备份、完整出口负例、真实Provider、Windows以外平台及模型记忆质量尚未通过。

## 本地路径准入与验证限制

首先纯词法拒UNC/设备/非盘符绝对路径/额外冒号，再检查已批准固定盘快照；只有之后才从盘根向下逐段lstat，发现link立即拒绝，不先探测整个叶子路径。[本次GetDriveTypeW证据](../evidence/task1-drive-proof.json)核定C、E、H返回3（DRIVE_FIXED）；当前代码只允许这三个盘，其他盘即使实际本地也先拒绝。含义参考[Microsoft官方说明](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew)。

这是当前机器/当前准入的可信快照，**不是跨机器或盘符更改后的持续本地性证明**。Task 3在安装/Host激活前必须重新核定盘型与配置，未能核定不得启用；不能把这层检查当作宿主出口策略。现阶段Windows以外平台明确拒绝路径准入。

真实本地junction创建在当前sandbox返回EPERM。随后仅对OS reparse元数据边界使用受控替身，证明拒绝顺序不会先触碰子路径；其余SQLite/FTS/文件读写均为真实临时资源。没有实际调用网络路径或创建远端junction；真实OS reparse与完整出口旅程仍留Task 3。已有链接按上述顺序检查，不承诺防有权限者并发替换整个目录或插件。
