# Task 2组件验收证据

日期：2026-11-04。范围：MEM-02/03及年度工作记忆的存储、受控提炼和生命周期组件。全部使用合成输入、临时本地资源和Provider边界替身；未安装plugin、未调用业务模型API、未读真实会话或凭据。Task 3实际Host、UI、出口及完整年度导出尚待实现。

## 测试结果与复现

| 执行者 / 运行时 | 正式全套结果 | 证据 |
|---|---|---|
| 主代理 / 独立Node26.13.0 | 61通过，0失败，0取消，0skip，exit 0；17960.4216ms | [Node26 TAP](../evidence/task2-node26.tap) |
| 主代理 / 实际Harness Electron44.7.0内嵌Node24.21.0 | 61通过，0失败，0取消，0skip，exit 0；17955.3204ms | [Host24 TAP](../evidence/task2-host24.tap) |
| 独立审查者 / Node26.13.0 | 独立重跑61通过，0失败，0skip；约16.54s | [独立评审](task2-review.md)；审查者另读Host24输出，未独立重跑Host24 |

完整文件集为tests/backend.test.mjs、jobs.test.mjs、lifecycle.test.mjs、migration.test.mjs、source-lock.test.mjs、work-summary.test.mjs，包含Task 1兼容回归。开发过程先看到缺失模块导致失败，再实现；新增超时锁、旧输入恢复、FTS残留、证明撤权、时间冲突等反例也实际先红后绿。TAP只保存最终全套输出，不冒充逐次红灯过程的归档。

在05目录的复现命令（PowerShell，已离线准备运行物料）：

```powershell
.\runtime\node.exe --test --test-reporter=tap tests/*.test.mjs
```

内嵌运行时测试由Node父进程使用spawnSync执行`E:\dsh\DeepSeek Harness.exe`，cwd为05目录，windowsHide为true，仅给子进程设置ELECTRON_RUN_AS_NODE=1；不启动用户UI或profile。可复现argv为：

```text
--expose-internals --test --test-reporter=tap
--test-reporter-destination=E:/dsh/plugin/05-local-memory/evidence/task2-host24.tap
tests/backend.test.mjs tests/jobs.test.mjs tests/lifecycle.test.mjs
tests/migration.test.mjs tests/source-lock.test.mjs tests/work-summary.test.mjs
```

以上换行仅便于阅读，argv中的每个文件独立传参。Host物料的版本/摘要和固定盘准入历史证据沿用[Task 1证据](task1-evidence.md)，不是重新认证所有Host服务。

## 行为覆盖与反例

| 要求 | 实际验证 | 适用限制 |
|---|---|---|
| 路由固定与无fallback | 入队A后活动路由切B仍传A；撤销/版本变化不调用；输出不能覆盖scope/路径 | resolveRoute/invoke为边界替身，实际注册Provider留Task 3 |
| 超时、取消、重启 | 晚到结果不落库；未知在途根级闸门阻止新请求；worker实际process.exit(17)后恢复unknown；可信收据解除不重试 | 不证明模型服务端取消或恰好一次计费 |
| 全根并发和预算 | 不同scope共享单执行锁；外scope不能解锁；旧回调不能解新token；持久日/会话预算；上海跨日旧任务拒绝 | 仅控制本记忆数据根任务，不控制整个Harness用量 |
| 原子写入和秘密过滤 | 非法模型schema、scope/路径覆盖、假秘密拒绝整批提交；raw Provider异常不进入返回；带引号值中的嵌套赋值回归 | 启发式不是任意秘密的完备检测 |
| 删除、更正、归档 | 热查询后删除/纠正/来源失效仍不可读旧正文；更正supersedes；archive与forget分开 | 归档保留本地正文；删除不撤回外部副本 |
| 正文恢复与权威状态 | 快照及整个旧正文文件恢复不回滚tombstone/任务完成态；缺失/损坏账本拒开；旧epoch排队输入清除 | 不认证管理员同时回滚所有控制文件 |
| FTS清理与显式迁移 | 唯一合成词不在影子表块和当前DB字节中；旧不安全FTS和固定schema 1迁移均重建清理；热库策略失效拒绝 | 非SSD介质擦除；无真实断电/硬件损坏测试 |
| 来源失效 | 03事件scope/版本/重放校验；session_removed即使affected_refs为空也失效session自身 | 03模块未实际接入 |
| 独立年度工作记忆 | 手工存取断开模型可用；模型提炼仅候选，普通search不读工作集合；共享预算和生命周期 | 缺证对话提醒、UI、模板映射及正式年度导出留Task 3 |
| 事项和事实去重 | 来源锚跨版本不生新事项；相同合并no-op；贡献、日期、目标/关联冲突保留候选，不覆盖已确认值 | 相似标题不会自动合并，人工身份判断由Host流程负责 |
| 证明可信状态 | 登记不读文件；受控有界读取；quote/digest按claim绑定；材料变化或当前授权撤销降未读；独立spy证实撤权后0次内容读取 | 只支持当前批准本地UTF-8文本，不自动取回URL/附件；授权仍为替身 |

## 实现与物料固定

冻结后主代理逐一核对关键实现摘要，与独立审查者提供的10个最终摘要完全一致。全体29项实现、测试、schema、vendor、许可、运行物料及TAP摘要见[task2-verification.json](../evidence/task2-verification.json)，清单自身SHA256为`9483a13c23e1c87a33203b5080db912658639805eb11792f24031fe8880ad4b0`。

Task 1报告仍为历史快照，不把其中backend/scope旧摘要当作当前代码审查证明。唯一可执行vendor仍为固定kovey CJK叶子模块；Task 2无新增外部依赖或托管服务，具体来源与取舍见[路线](implementation-route.md)及[阶段机制说明](task2-mechanisms.md)。

## 尚未认证

实际Cordis Host服务/钩子、注册Provider和真实网络请求、可信UI授权与收据、完整负向出口、真实junction、重新核盘、Windows以外平台、断电/硬件故障、模型记忆质量及年度完整导出均不由这些测试证明。当前没有DSH bundle入口，不能安装为完整plugin。Task 3应继续用隔离profile及合成数据验证，不能扫描真实历史补材料。
