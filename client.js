/**
 * Memory Center client half for the DSH Web UI.
 *
 * A dependency-free classic script: the browser module loader calls this factory, React comes from
 * the host module table, and no Harness Client package is imported. The page is registered into
 * `settings.section` as "Memory Center" with three tabs: experiences, annual work records and jobs.
 * Every request goes to the same-origin `POST /dsh-local-memory/api` route; the client never sees a
 * scope string, a grant, a secret or an internal exception (only a reason code).
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-memory-linqu',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'memoryCenter';
    const API_PATH = '/dsh-local-memory/api';
    const POLL_MS = 5000;
    const PAGE_LIMIT = 20;

    /* ------------------------------------------------------------------ */
    /* Dictionaries. The same strings are exported in locale/{zh,en}.json  */
    /* for plugin display metadata; runtime text is registered through     */
    /* ctx.locale so the host language service controls it.                */
    /* ------------------------------------------------------------------ */

    const DICTIONARIES = Object.freeze({
      zh: {
        'nav.label': '记忆中心',
        'page.title': '记忆中心',
        'page.subtitle': '本地经验记忆、年度工作记录与处理任务；未核验内容不会被当作事实。',
        'page.refresh': '刷新',
        'page.loading': '正在读取…',
        'page.retry': '重试',
        'page.noProject': '尚未登记任何项目，请先在“经验记忆”页登记项目。',
        'page.selectProject': '项目',
        'page.refreshed': '已刷新',
        'tabs.memory': '经验记忆',
        'tabs.work': '年度工作记录',
        'tabs.tasks': '处理任务',
        'status.projects': '{n} 个项目',
        'status.scheduler.running': '调度运行中',
        'status.scheduler.idle': '调度空闲',
        'status.scheduler.stopped': '调度已停止',
        'status.scheduler.unavailable': '调度不可用',
        'status.unavailable': '状态不可用',
        'common.confirm': '确认',
        'common.cancel': '取消',
        'common.save': '保存',
        'common.close': '关闭',
        'common.retry': '重试',
        'common.loading': '正在读取…',
        'common.none': '无',
        'common.unknown': '未知',
        'common.more': '加载更多',
        'common.search': '搜索',
        'common.clear': '清除',
        'common.add': '添加',
        'common.remove': '移除',
        'common.refresh': '刷新',
        'common.del': '删除',
        'errors.generic': '操作未完成：{code}',
        'errors.OPERATION_FAILED': '操作未完成，请稍后重试。',
        'errors.NETWORK_UNAVAILABLE': '无法连接本地管理接口，请确认页面与插件同源。',
        'errors.BAD_RESPONSE': '本地管理接口返回了无法识别的响应。',
        'errors.UNKNOWN_OPERATION': '当前版本不认识这个操作。',
        'errors.UNAVAILABLE': '当前构建不支持这个操作。',
        'errors.INVALID_INPUT': '输入内容不符合要求，请修正后重试。',
        'errors.INVALID_REQUEST': '请求格式不正确。',
        'errors.USER_ACTION_REQUIRED': '这个操作必须由你本人发起。',
        'errors.PROJECT_REQUIRED': '请选择一个项目。',
        'errors.PROJECT_NOT_FOUND': '项目未登记。',
        'errors.REPO_NOT_FOUND': '仓库绑定未启用或不存在。',
        'errors.SCOPE_NOT_FOUND': '项目还没有可用的记忆范围。',
        'errors.STALE_REVISION': '项目已被修改，请刷新后重试。',
        'errors.STALE_GENERATION': '记忆范围已变化，请刷新后重试。',
        'errors.STALE_CURSOR': '列表已变化，请刷新后重试。',
        'errors.MEMORY_NOT_FOUND': '找不到这条经验记忆。',
        'errors.MEMORY_NOT_ACTIVE': '只有有效状态的经验记忆可以执行该操作。',
        'errors.MEMORY_NOT_ARCHIVED': '只有已归档的经验记忆可以恢复。',
        'errors.SOURCE_INVALIDATED': '这条记忆的来源已被删除或失效。',
        'errors.TASK_NOT_FOUND': '找不到这个任务。',
        'errors.TASK_STATE_CONFLICT': '任务当前状态不允许该操作。',
        'errors.CANCEL_UNAVAILABLE': '当前构建只能显示任务，不能请求本地取消；不声称远端已停止。',
        'errors.UNAUTHORIZED': '缺少有效的用户确认，或确认已过期。',
        'errors.OPERATION_CONFLICT': '同一 operationId 已用于不同请求。',
        'errors.PROJECT_EXISTS': '同名项目已用不同绑定登记。',
        'errors.SCOPE_CONFLICT': '该仓库范围已被其他项目占用。',
        'errors.DUPLICATE_REPOSITORY': '仓库 ID 重复。',
        'errors.INVALID_REPOSITORIES': '仓库列表不符合要求（1–16 个）。',
        'errors.DUPLICATE_NAME': '项目名已被占用。',
        'errors.INVALID_PREFERENCE': '项目开关取值无效。',
        'errors.REPORT_STALE': '报告所绑定的来源已变化，请重新生成草稿。',
        'errors.REPORT_NOT_FOUND': '找不到这份报告。',
        'errors.REPORT_TOO_LARGE': '报告内容超出上限。',
        'errors.REPORT_CONFLICT': '报告标识冲突。',
        'errors.REPORT_REVISION_MISMATCH': '报告修订已变化，请刷新。',
        'errors.EXPORT_ROOT_NOT_APPROVED': '导出目录未获批准。',
        'errors.WORK_NOT_FOUND': '找不到这条年度工作记录。',
        'errors.PROJECT_NOT_ACTIVE': '项目已退休，记录只读。',
        'errors.PROOF_UNREADABLE': '证明正文不可读。',
        'errors.PROOF_CHANGED': '证明文件版本已变化。',
        'errors.INTERNAL_ERROR': '内部错误，操作未完成。',
        'notice.saved': '已保存。',
        'project.title': '项目',
        'project.register': '登记项目',
        'project.name': '项目名称',
        'project.namePlaceholder': '例如：本地记忆插件',
        'project.repoList': '仓库',
        'project.repoId': '仓库 ID',
        'project.canonicalRoot': '仓库根路径',
        'project.worktreeRoot': '工作树路径（可留空，默认等于仓库根）',
        'project.revision': '版本标识',
        'project.buildVariant': '构建变体',
        'project.buildVariantPlaceholder': '例如：win-node24',
        'project.addRepository': '添加仓库',
        'project.removeRepository': '移除仓库',
        'project.pathHint': '路径只在你的本机校验与保存，不会通过接口返回；本机路径必须真实存在。',
        'project.submit': '登记',
        'project.empty': '还没有登记项目。',
        'project.retire': '退休项目',
        'project.retireReason': '退休原因',
        'project.retireConfirm': '确认退休',
        'project.retireHint': '退休只停止新的自动提炼与召回绑定，已有记忆仍可查看和管理。',
        'project.state.active': '有效',
        'project.state.retired': '已退休',
        'project.pref.extract': '自动提炼',
        'project.pref.recall': '自动召回',
        'project.pref.hint': '项目级开关；关闭后不再自动触发对应动作，手动管理不受影响。',
        'project.repoCount': '{n} 个仓库',
        'project.origin.user': '用户登记',
        'project.origin.config': '配置登记',
        'memory.searchPlaceholder': '手动检索本地经验…',
        'memory.filter.all': '全部',
        'memory.filter.active': '有效',
        'memory.filter.archived': '已归档',
        'memory.counts': '有效 {active} · 归档 {archived} · 已删除 {deleted}',
        'memory.empty': '这个项目还没有经验记忆。',
        'memory.noMatch': '没有匹配的经验记忆。',
        'memory.loadMore': '加载更多',
        'memory.kind.fact': '事实',
        'memory.kind.lesson': '经验',
        'memory.kind.preference': '偏好',
        'memory.kind.decision': '决定',
        'memory.state.active': '有效',
        'memory.state.archived': '已归档',
        'memory.state.stale': '已失效',
        'memory.state.superseded': '已被纠正',
        'memory.state.deleted': '已删除',
        'memory.origin.user': '本人保存',
        'memory.origin.model': '模型提炼',
        'memory.originLabel': '来源方式',
        'memory.verification.unverified': '未核验',
        'memory.source': '来源',
        'memory.generation': '记录版本 {n}',
        'memory.text': '正文',
        'memory.saveCorrection': '保存纠正',
        'memory.correct': '纠正',
        'memory.correctHint': '纠正会生成一条新版本并保留“已被纠正”的旧记录；不会改写旧来源。',
        'memory.archive': '归档',
        'memory.archiveHint': '归档可恢复：内容保留，不参与自动召回。',
        'memory.restore': '恢复',
        'memory.delete': '删除',
        'memory.deleteWarning': '删除即清除：本地正文与索引立即移除，删除后不可恢复。归档才是可恢复动作。',
        'memory.deleteRemoteNote': '删除不会、也无法撤回模型此前已经接收的内容、远端副本或备份。',
        'memory.deleteFinal': '确认删除（不可恢复）',
        'memory.tombstoneHint': '这条记录的本地正文已不可用；不可恢复的删除与可恢复的归档是不同生命周期。',
        'memory.stateChanged': '状态已更新。',
        'work.title': '年度工作记录',
        'work.empty': '这个项目还没有年度工作记录。自动草稿需在聊天的当前项目对话中产生，或手动创建。',
        'work.loadMore': '加载更多',
        'work.itemType.project': '项目',
        'work.itemType.requirement': '需求',
        'work.itemType.problem': '问题探索',
        'work.claim.myContribution': '本人贡献',
        'work.claim.processOrConclusion': '过程 / 结论',
        'work.claim.result': '结果',
        'work.claim.time': '时间',
        'work.goal': '目标',
        'work.confirmClaim': '确认本人贡献',
        'work.confirmTime': '确认时间',
        'work.confirmed': '已确认',
        'work.pending': '待确认',
        'work.support.missing': '缺证明',
        'work.support.unread': '证明未读',
        'work.support.supported': '有证明',
        'work.support.partial': '部分证明',
        'work.support.conflicting': '证明冲突',
        'work.time.precision': '时间精度',
        'work.time.precision.unknown': '未知',
        'work.time.precision.year': '年',
        'work.time.precision.month': '月',
        'work.time.precision.day': '日',
        'work.time.range': '时间范围',
        'work.time.unknownHint': '时间未知时不能自动确认，需要先补全可核对的时间。',
        'work.evidence.title': '证明引用',
        'work.evidence.register': '登记证明引用',
        'work.evidence.displayName': '证明名称',
        'work.evidence.localPath': '本地文件路径',
        'work.evidence.pathHint': '只登记引用；读取正文仍需你届时单独确认，登记本身不提升“有证明”。',
        'work.evidence.submit': '登记引用',
        'work.evidence.claim': '关联断言',
        'work.evidence.none': '尚未登记证明引用。',
        'work.evidence.status.unread': '未读',
        'work.evidence.status.read': '已读',
        'work.evidence.status.current': '当前版本',
        'work.evidence.status.changed': '版本已变化',
        'work.evidence.status.unavailable': '不可用',
        'work.evidence.status.not_retrieved': '未获取',
        'work.pendingEvidence': '待补证清单',
        'work.pendingConfirmation': '待确认清单',
        'work.reminder.defer': '延后提醒 24 小时',
        'work.reminder.disable': '停用该提醒',
        'work.report.draft': '生成报告草稿',
        'work.report.from': '起始年份',
        'work.report.to': '结束年份',
        'work.report.title': '年度报告',
        'work.report.state.draft': '草稿',
        'work.report.state.approved': '已审定',
        'work.report.state.stale': '已过期',
        'work.report.digest': '报告摘要',
        'work.report.pendingProofs': '缺证 {n} 项',
        'work.report.pendingConfirmations': '待确认 {n} 项',
        'work.report.dimensionPending': '年度总结维度模板尚未提供，报告不生成评分维度。',
        'work.report.approve': '审定报告',
        'work.report.approveHint': '审定绑定当前报告摘要与来源版本；来源变化后审定自动过期。',
        'work.report.exportMarkdown': '导出 Markdown',
        'work.report.exportJson': '导出 JSON',
        'work.report.exported': '已导出：{ref}',
        'work.sources': '来源',
        'work.conflicts': '冲突候选',
        'work.precisionNote': '时间精度：{precision}；模型推断的时间不会被自动确认。',
        'task.title': '处理任务',
        'task.empty': '没有处理任务。',
        'task.loadMore': '加载更多',
        'task.state.queued': '排队中',
        'task.state.running': '执行中',
        'task.state.completed': '已完成',
        'task.state.failed': '失败',
        'task.state.stale': '已过期',
        'task.state.outcome_unknown': '待核',
        'task.state.quarantined': '隔离待核',
        'task.phase.queued': '排队',
        'task.phase.in_flight': '已派发',
        'task.phase.unknown': '派发结果未知',
        'task.phase.settled': '已结束',
        'task.purpose': '用途',
        'task.purpose.memory_extract': '经验提炼',
        'task.purpose.work_summary_extract': '年度草稿提炼',
        'task.purpose.work_summary_merge': '年度记录合并',
        'task.reason': '原因',
        'task.costStatus': '费用状态',
        'task.cost.reported': '已报告',
        'task.cost.unknown': '未知',
        'task.cost.not_dispatched': '未派发',
        'task.inspect': '查看',
        'task.cancel': '请求本地取消',
        'task.cancelHint': '取消只请求停止本地执行，不声称远端模型已经静止。',
        'task.unknownTitle': '此任务结果待核',
        'task.unknownHint': '模型调用结果未知：系统不会自动重试，也不会把远端状态当作已停止。请先核实远端已结束或已取消，再登记用户确认。',
        'task.confirmRemote': '登记用户确认',
        'task.confirmFinished': '远端已结束',
        'task.confirmCancelConfirmed': '远端取消已确认',
        'task.noRetry': '不提供盲重试。',
        'task.remoteStopNotClaimed': '未声称远端已停止。',
        'task.quarantined': '派发锁待核',
        'task.job': '任务',
        'task.createdAt': '创建时间',
        'task.repo': '仓库',
        'task.capabilities': '可用动作',
        'footer.hint': '状态未知的任务不会自动重试；删除经验记忆不可恢复，归档可恢复。',
      },
      en: {
        'nav.label': 'Memory Center',
        'page.title': 'Memory Center',
        'page.subtitle': 'Local experiences, annual work records and processing jobs. Unverified items are never presented as facts.',
        'page.refresh': 'Refresh',
        'page.loading': 'Loading…',
        'page.retry': 'Retry',
        'page.noProject': 'No project is registered yet. Register one in the Experiences tab.',
        'page.selectProject': 'Project',
        'page.refreshed': 'Refreshed',
        'tabs.memory': 'Experiences',
        'tabs.work': 'Annual work records',
        'tabs.tasks': 'Processing jobs',
        'status.projects': '{n} projects',
        'status.scheduler.running': 'Scheduler running',
        'status.scheduler.idle': 'Scheduler idle',
        'status.scheduler.stopped': 'Scheduler stopped',
        'status.scheduler.unavailable': 'Scheduler unavailable',
        'status.unavailable': 'Status unavailable',
        'common.confirm': 'Confirm',
        'common.cancel': 'Cancel',
        'common.save': 'Save',
        'common.close': 'Close',
        'common.retry': 'Retry',
        'common.loading': 'Loading…',
        'common.none': 'None',
        'common.unknown': 'Unknown',
        'common.more': 'Load more',
        'common.search': 'Search',
        'common.clear': 'Clear',
        'common.add': 'Add',
        'common.remove': 'Remove',
        'common.refresh': 'Refresh',
        'common.del': 'Delete',
        'errors.generic': 'The operation did not complete: {code}',
        'errors.OPERATION_FAILED': 'The operation did not complete. Please try again.',
        'errors.NETWORK_UNAVAILABLE': 'Cannot reach the local management API. Make sure the page and plugin share one origin.',
        'errors.BAD_RESPONSE': 'The local management API returned an unrecognized response.',
        'errors.UNKNOWN_OPERATION': 'This build does not know this operation.',
        'errors.UNAVAILABLE': 'This operation is unavailable in the current build.',
        'errors.INVALID_INPUT': 'An input value is invalid. Fix it and try again.',
        'errors.INVALID_REQUEST': 'The request format is invalid.',
        'errors.USER_ACTION_REQUIRED': 'This action must be started by you.',
        'errors.PROJECT_REQUIRED': 'Select a project first.',
        'errors.PROJECT_NOT_FOUND': 'The project is not registered.',
        'errors.REPO_NOT_FOUND': 'The repository binding is missing or disabled.',
        'errors.SCOPE_NOT_FOUND': 'This project has no memory scope yet.',
        'errors.STALE_REVISION': 'The project changed; refresh and try again.',
        'errors.STALE_GENERATION': 'The memory scope changed; refresh and try again.',
        'errors.STALE_CURSOR': 'The list changed; refresh and try again.',
        'errors.MEMORY_NOT_FOUND': 'This memory record was not found.',
        'errors.MEMORY_NOT_ACTIVE': 'Only active memory records allow this action.',
        'errors.MEMORY_NOT_ARCHIVED': 'Only archived memory records can be restored.',
        'errors.SOURCE_INVALIDATED': 'This memory record source was deleted or invalidated.',
        'errors.TASK_NOT_FOUND': 'This job was not found.',
        'errors.TASK_STATE_CONFLICT': 'The job state does not allow this action.',
        'errors.CANCEL_UNAVAILABLE': 'This build can show jobs but cannot request a local cancel; no remote stop is claimed.',
        'errors.UNAUTHORIZED': 'A valid user confirmation is missing or expired.',
        'errors.OPERATION_CONFLICT': 'This operationId was already used for a different request.',
        'errors.PROJECT_EXISTS': 'A project with this name is already registered with a different binding.',
        'errors.SCOPE_CONFLICT': 'This repository scope is already owned by another project.',
        'errors.DUPLICATE_REPOSITORY': 'Repository IDs must be unique.',
        'errors.INVALID_REPOSITORIES': 'The repository list is invalid (expected 1–16 entries).',
        'errors.DUPLICATE_NAME': 'The project name is already used.',
        'errors.INVALID_PREFERENCE': 'The project preference value is invalid.',
        'errors.REPORT_STALE': 'Report sources changed; create a new draft.',
        'errors.REPORT_NOT_FOUND': 'This report was not found.',
        'errors.REPORT_TOO_LARGE': 'The report exceeds its size limit.',
        'errors.REPORT_CONFLICT': 'The report identity conflicts with existing content.',
        'errors.REPORT_REVISION_MISMATCH': 'The report revision changed; refresh.',
        'errors.EXPORT_ROOT_NOT_APPROVED': 'The export directory is not approved.',
        'errors.WORK_NOT_FOUND': 'This annual work record was not found.',
        'errors.PROJECT_NOT_ACTIVE': 'The project is retired; records are read-only.',
        'errors.PROOF_UNREADABLE': 'The proof content is unreadable.',
        'errors.PROOF_CHANGED': 'The proof file version changed.',
        'errors.INTERNAL_ERROR': 'An internal error prevented the operation.',
        'notice.saved': 'Saved.',
        'project.title': 'Projects',
        'project.register': 'Register project',
        'project.name': 'Project name',
        'project.namePlaceholder': 'e.g. Local memory plugin',
        'project.repoList': 'Repositories',
        'project.repoId': 'Repository ID',
        'project.canonicalRoot': 'Canonical root path',
        'project.worktreeRoot': 'Worktree path (optional, defaults to the root)',
        'project.revision': 'Revision',
        'project.buildVariant': 'Build variant',
        'project.buildVariantPlaceholder': 'e.g. win-node24',
        'project.addRepository': 'Add repository',
        'project.removeRepository': 'Remove repository',
        'project.pathHint': 'Paths are validated and stored locally and are never returned by the API. They must exist on this machine.',
        'project.submit': 'Register',
        'project.empty': 'No project is registered yet.',
        'project.retire': 'Retire project',
        'project.retireReason': 'Retirement reason',
        'project.retireConfirm': 'Confirm retirement',
        'project.retireHint': 'Retiring only stops new automatic extraction and recall bindings; stored memories stay readable and manageable.',
        'project.state.active': 'Active',
        'project.state.retired': 'Retired',
        'project.pref.extract': 'Automatic extraction',
        'project.pref.recall': 'Automatic recall',
        'project.pref.hint': 'Project-level switches; turning them off keeps manual management available.',
        'project.repoCount': '{n} repositories',
        'project.origin.user': 'User registered',
        'project.origin.config': 'Configured',
        'memory.searchPlaceholder': 'Search local experiences…',
        'memory.filter.all': 'All',
        'memory.filter.active': 'Active',
        'memory.filter.archived': 'Archived',
        'memory.counts': 'Active {active} · Archived {archived} · Deleted {deleted}',
        'memory.empty': 'This project has no memory records yet.',
        'memory.noMatch': 'No memory record matches.',
        'memory.loadMore': 'Load more',
        'memory.kind.fact': 'Fact',
        'memory.kind.lesson': 'Lesson',
        'memory.kind.preference': 'Preference',
        'memory.kind.decision': 'Decision',
        'memory.state.active': 'Active',
        'memory.state.archived': 'Archived',
        'memory.state.stale': 'Stale',
        'memory.state.superseded': 'Superseded',
        'memory.state.deleted': 'Deleted',
        'memory.origin.user': 'Saved by user',
        'memory.origin.model': 'Model extracted',
        'memory.originLabel': 'Origin',
        'memory.verification.unverified': 'Unverified',
        'memory.source': 'Source',
        'memory.generation': 'Record version {n}',
        'memory.text': 'Content',
        'memory.saveCorrection': 'Save correction',
        'memory.correct': 'Correct',
        'memory.correctHint': 'Correction creates a new version and marks the old record superseded; old sources are never rewritten.',
        'memory.archive': 'Archive',
        'memory.archiveHint': 'Archiving is reversible: content is kept and excluded from automatic recall.',
        'memory.restore': 'Restore',
        'memory.delete': 'Delete',
        'memory.deleteWarning': 'Delete means erase: local content and index are removed immediately and it cannot be restored. Archive is the reversible action.',
        'memory.deleteRemoteNote': 'Deletion cannot revoke content already received by a model, remote copies or backups.',
        'memory.deleteFinal': 'Delete permanently',
        'memory.tombstoneHint': 'The local content of this record is unavailable; irreversible deletion and reversible archiving are different lifecycles.',
        'memory.stateChanged': 'State updated.',
        'work.title': 'Annual work records',
        'work.empty': 'This project has no annual work records yet. Automatic drafts come from current-project chat; manual drafts are also possible.',
        'work.loadMore': 'Load more',
        'work.itemType.project': 'Project',
        'work.itemType.requirement': 'Requirement',
        'work.itemType.problem': 'Problem exploration',
        'work.claim.myContribution': 'My contribution',
        'work.claim.processOrConclusion': 'Process / conclusion',
        'work.claim.result': 'Result',
        'work.claim.time': 'Time',
        'work.goal': 'Goal',
        'work.confirmClaim': 'Confirm my contribution',
        'work.confirmTime': 'Confirm time',
        'work.confirmed': 'Confirmed',
        'work.pending': 'Pending',
        'work.support.missing': 'No proof',
        'work.support.unread': 'Proof unread',
        'work.support.supported': 'Supported',
        'work.support.partial': 'Partial proof',
        'work.support.conflicting': 'Proof conflict',
        'work.time.precision': 'Time precision',
        'work.time.precision.unknown': 'Unknown',
        'work.time.precision.year': 'Year',
        'work.time.precision.month': 'Month',
        'work.time.precision.day': 'Day',
        'work.time.range': 'Time range',
        'work.time.unknownHint': 'An unknown time cannot be confirmed; add a verifiable time first.',
        'work.evidence.title': 'Proof references',
        'work.evidence.register': 'Register proof reference',
        'work.evidence.displayName': 'Proof name',
        'work.evidence.localPath': 'Local file path',
        'work.evidence.pathHint': 'Only the reference is registered. Reading the content still needs your later confirmation; registering does not upgrade the claim to supported.',
        'work.evidence.submit': 'Register reference',
        'work.evidence.claim': 'Linked claim',
        'work.evidence.none': 'No proof references yet.',
        'work.evidence.status.unread': 'Unread',
        'work.evidence.status.read': 'Read',
        'work.evidence.status.current': 'Current version',
        'work.evidence.status.changed': 'Version changed',
        'work.evidence.status.unavailable': 'Unavailable',
        'work.evidence.status.not_retrieved': 'Not retrieved',
        'work.pendingEvidence': 'Pending proof',
        'work.pendingConfirmation': 'Pending confirmation',
        'work.reminder.defer': 'Defer reminder 24h',
        'work.reminder.disable': 'Disable this reminder',
        'work.report.draft': 'Create report draft',
        'work.report.from': 'From year',
        'work.report.to': 'To year',
        'work.report.title': 'Annual report',
        'work.report.state.draft': 'Draft',
        'work.report.state.approved': 'Approved',
        'work.report.state.stale': 'Stale',
        'work.report.digest': 'Report digest',
        'work.report.pendingProofs': '{n} pending proofs',
        'work.report.pendingConfirmations': '{n} pending confirmations',
        'work.report.dimensionPending': 'The annual summary dimension reference is not provided yet; no scoring dimensions are generated.',
        'work.report.approve': 'Approve report',
        'work.report.approveHint': 'Approval binds the current report digest and source revisions; it becomes stale when sources change.',
        'work.report.exportMarkdown': 'Export Markdown',
        'work.report.exportJson': 'Export JSON',
        'work.report.exported': 'Exported: {ref}',
        'work.sources': 'Sources',
        'work.conflicts': 'Conflict candidates',
        'work.precisionNote': 'Time precision: {precision}; model-inferred time is never auto-confirmed.',
        'task.title': 'Processing jobs',
        'task.empty': 'No processing jobs.',
        'task.loadMore': 'Load more',
        'task.state.queued': 'Queued',
        'task.state.running': 'Running',
        'task.state.completed': 'Completed',
        'task.state.failed': 'Failed',
        'task.state.stale': 'Stale',
        'task.state.outcome_unknown': 'Needs review',
        'task.state.quarantined': 'Quarantined',
        'task.phase.queued': 'Queued',
        'task.phase.in_flight': 'Dispatched',
        'task.phase.unknown': 'Dispatch outcome unknown',
        'task.phase.settled': 'Settled',
        'task.purpose': 'Purpose',
        'task.purpose.memory_extract': 'Memory extraction',
        'task.purpose.work_summary_extract': 'Annual draft extraction',
        'task.purpose.work_summary_merge': 'Annual record merge',
        'task.reason': 'Reason',
        'task.costStatus': 'Cost status',
        'task.cost.reported': 'Reported',
        'task.cost.unknown': 'Unknown',
        'task.cost.not_dispatched': 'Not dispatched',
        'task.inspect': 'Inspect',
        'task.cancel': 'Request local cancel',
        'task.cancelHint': 'Cancelling only requests a local stop; it does not claim the remote model is quiescent.',
        'task.unknownTitle': 'This job outcome needs review',
        'task.unknownHint': 'The model call outcome is unknown. Nothing is retried automatically and remote state is not assumed stopped. Verify the remote side finished or was cancelled, then record the user confirmation.',
        'task.confirmRemote': 'Record user confirmation',
        'task.confirmFinished': 'Remote finished',
        'task.confirmCancelConfirmed': 'Remote cancel confirmed',
        'task.noRetry': 'No blind retry.',
        'task.remoteStopNotClaimed': 'Remote stop is not claimed.',
        'task.quarantined': 'Dispatch lock needs review',
        'task.job': 'Job',
        'task.createdAt': 'Created',
        'task.repo': 'Repository',
        'task.capabilities': 'Available actions',
        'footer.hint': 'Unknown-outcome jobs are never retried automatically; deleting an experience is irreversible while archiving is reversible.',
      },
    });

    /* ------------------------------------------------------------------ */
    /* Pure helpers                                                        */
    /* ------------------------------------------------------------------ */

    function lookup(dictionary, key) {
      if (Object.prototype.hasOwnProperty.call(dictionary, key)) return dictionary[key];
      const parts = String(key).split('.');
      let current = dictionary;
      for (const part of parts) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
        current = current[part];
      }
      return typeof current === 'string' ? current : undefined;
    }
    function interpolate(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }
    function createTranslator(props) {
      const slotT = typeof props.t === 'function' ? props.t : null;
      const injectedT = typeof props.translate === 'function' ? props.translate : null;
      return function translate(key, params) {
        for (const candidate of [slotT, injectedT]) {
          if (!candidate) continue;
          let value;
          try { value = candidate(key, params); } catch { value = undefined; }
          if (typeof value === 'string' && value !== key) return value;
        }
        const english = lookup(DICTIONARIES.en, key) ?? lookup(DICTIONARIES.zh, key);
        if (typeof english !== 'string') return key;
        return interpolate(english, params);
      };
    }
    function newOperationId() {
      try {
        const crypto = globalThis.crypto;
        if (crypto && typeof crypto.randomUUID === 'function') return `ui-${crypto.randomUUID()}`;
      } catch { /* fall through to the time-based id */ }
      return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }
    function reasonOf(error) {
      const reason = error && typeof error.reasonCode === 'string' ? error.reasonCode : '';
      return /^[A-Z][A-Z0-9_]{1,63}$/.test(reason) ? reason : 'OPERATION_FAILED';
    }
    function operationIdPatternValid(value) {
      return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    }
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }
    function text(value) {
      return typeof value === 'string' ? value : '';
    }
    function numberText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    }
    function truncate(value, size) {
      const source = text(value);
      return source.length > size ? `${source.slice(0, size)}…` : source;
    }
    function reasonCodeLabel(t, code) {
      const key = `errors.${code}`;
      const known = lookup(DICTIONARIES.en, key);
      if (known === undefined) return t('errors.generic', {code});
      return t(key);
    }

    async function postOperation(operation, input, expectedRevision) {
      const body = {schemaVersion: 1, operationId: newOperationId(), operation, input: input === undefined ? {} : input};
      if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
      let response;
      try {
        response = await fetch(API_PATH, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
      } catch {
        throw Object.assign(new Error('local management API is unreachable'), {reasonCode: 'NETWORK_UNAVAILABLE'});
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw Object.assign(new Error('unreadable response'), {reasonCode: 'BAD_RESPONSE'});
      }
      if (!payload || payload.ok !== true) {
        const code = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code : 'OPERATION_FAILED';
        throw Object.assign(new Error('operation failed'), {reasonCode: operationIdPatternValid(code) ? code : 'OPERATION_FAILED'});
      }
      return payload.value;
    }

    function useMounted() {
      const mounted = React.useRef(true);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);
      return mounted;
    }
    function useVisiblePolling(callback, active) {
      const latest = React.useRef(callback);
      latest.current = callback;
      React.useEffect(() => {
        if (!active) return undefined;
        let timer = null;
        const start = () => {
          if (timer !== null) return;
          timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            latest.current();
          }, POLL_MS);
        };
        const stop = () => {
          if (timer !== null) { clearInterval(timer); timer = null; }
        };
        const onVisibility = () => {
          if (document.visibilityState === 'hidden') stop();
          else { start(); latest.current(); }
        };
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') start();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        return () => {
          stop();
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [active]);
    }

    /* ------------------------------------------------------------------ */
    /* Presentational primitives (host look, theme tokens only)            */
    /* ------------------------------------------------------------------ */

    function Button(props) {
      const {variant, disabled, onClick, children, title, type} = props;
      return h('button', {
        type: type || 'button',
        className: 'dshlm-btn',
        'data-variant': variant || 'default',
        disabled: disabled === true,
        title,
        onClick: disabled === true ? undefined : onClick,
      }, children);
    }
    function Field(props) {
      const {label, hint, children} = props;
      return h('label', {className: 'dshlm-field'},
        h('span', {className: 'dshlm-field-label'}, label),
        children,
        hint ? h('span', {className: 'dshlm-field-hint'}, hint) : null);
    }
    function TextInput(props) {
      return h('input', {
        className: 'dshlm-input',
        type: props.type || 'text',
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        onChange: event => props.onChange(event.target.value),
      });
    }
    function TextArea(props) {
      return h('textarea', {
        className: 'dshlm-textarea',
        rows: props.rows || 5,
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        onChange: event => props.onChange(event.target.value),
      });
    }
    function Badge(props) {
      return h('span', {className: 'dshlm-badge', 'data-tone': props.tone || 'neutral', title: props.title}, props.children);
    }
    function Empty(props) {
      return h('div', {className: 'dshlm-empty'}, props.children);
    }
    function Loading(props) {
      return h('div', {className: 'dshlm-muted'}, props.children);
    }
    function ErrorBanner(props) {
      return h('div', {className: 'dshlm-error-banner', role: 'alert'},
        h('span', {className: 'dshlm-error-text'}, props.message),
        h(Button, {variant: 'ghost', onClick: props.onRetry}, props.retryLabel));
    }
    function Notice(props) {
      return h('div', {className: 'dshlm-notice', role: 'status'}, props.children);
    }
    function ListRow(props) {
      return h('button', {
        type: 'button',
        className: 'dshlm-row',
        'data-selected': props.selected === true,
        onClick: props.onClick,
      }, props.children);
    }
    function StateBadge(props) {
      const tone = props.tone || 'neutral';
      return h(Badge, {tone}, props.label);
    }

    /* ------------------------------------------------------------------ */
    /* Project panel: registration, preferences, retirement                */
    /* ------------------------------------------------------------------ */

    function emptyRepository() {
      return {repoId: 'main', canonicalRoot: '', worktreeRoot: '', revision: 'workspace', buildVariant: ''};
    }

    function ProjectPanel(props) {
      const {t, projects, projectId, call, onError, onNotice, onChanged} = props;
      const [open, setOpen] = React.useState(false);
      const [name, setName] = React.useState('');
      const [repositories, setRepositories] = React.useState([emptyRepository()]);
      const [busy, setBusy] = React.useState(false);
      const [retireOpen, setRetireOpen] = React.useState(null);
      const [retireReason, setRetireReason] = React.useState('');

      function updateRepository(index, key, value) {
        setRepositories(current => current.map((entry, entryIndex) => entryIndex === index ? {...entry, [key]: value} : entry));
      }
      function addRepository() {
        setRepositories(current => current.length >= 16 ? current : [...current, emptyRepository()]);
      }
      function removeRepository(index) {
        setRepositories(current => current.length <= 1 ? current : current.filter((entry, entryIndex) => entryIndex !== index));
      }
      async function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          const normalized = repositories.map(entry => ({
            repoId: entry.repoId.trim(),
            canonicalRoot: entry.canonicalRoot.trim(),
            worktreeRoot: entry.worktreeRoot.trim() === '' ? entry.canonicalRoot.trim() : entry.worktreeRoot.trim(),
            revision: entry.revision.trim() === '' ? 'workspace' : entry.revision.trim(),
            buildVariant: entry.buildVariant.trim() === '' ? 'unknown' : entry.buildVariant.trim(),
          }));
          await call('project.register', {name: name.trim(), repositories: normalized});
          setName('');
          setRepositories([emptyRepository()]);
          setOpen(false);
          onNotice(t('notice.saved'));
          onChanged();
        } catch (error) {
          onError(reasonOf(error));
        } finally {
          setBusy(false);
        }
      }
      async function togglePreference(project, key) {
        try {
          await call('project.preference', {projectId: project.projectId, key, value: !project.preferences[key]}, project.revision);
          onChanged();
        } catch (error) {
          onError(reasonOf(error));
        }
      }
      async function retire(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!retireOpen || busy) return;
        setBusy(true);
        try {
          await call('project.retire', {projectId: retireOpen.projectId, reason: retireReason.trim()}, retireOpen.revision);
          setRetireOpen(null);
          setRetireReason('');
          onNotice(t('notice.saved'));
          onChanged();
        } catch (error) {
          onError(reasonOf(error));
        } finally {
          setBusy(false);
        }
      }

      return h('section', {className: 'dshlm-card dshlm-project'},
        h('div', {className: 'dshlm-card-header'},
          h('h3', {className: 'dshlm-card-title'}, t('project.title')),
          h(Button, {variant: 'ghost', onClick: () => setOpen(value => !value)}, open ? t('common.cancel') : t('project.register'))),
        asArray(projects).length === 0 ? h(Empty, null, t('project.empty')) : null,
        h('div', {className: 'dshlm-project-list'},
          asArray(projects).map(project => h('div', {key: project.projectId, className: 'dshlm-project-row', 'data-selected': project.projectId === projectId},
            h('div', {className: 'dshlm-row-line'},
              h('span', {className: 'dshlm-strong'}, project.name),
              h(StateBadge, {tone: project.state === 'active' ? 'success' : 'neutral', label: t(`project.state.${project.state}`)}),
              h('span', {className: 'dshlm-muted'}, t('project.repoCount', {n: asArray(project.repositories).length}))),
            h('div', {className: 'dshlm-row-line dshlm-muted'},
              asArray(project.repositories).map(repository => h('span', {key: repository.repoId, className: 'dshlm-chip'},
                `${repository.repoId} · ${repository.canonicalRootName || t('common.unknown')} · ${repository.revision}`))),
            project.state === 'active' ? h('div', {className: 'dshlm-row-line'},
              h(Button, {variant: 'ghost', onClick: () => togglePreference(project, 'extract')},
                `${t('project.pref.extract')}: ${project.preferences.extract ? t('common.confirm') : t('common.none')}`),
              h(Button, {variant: 'ghost', onClick: () => togglePreference(project, 'recall')},
                `${t('project.pref.recall')}: ${project.preferences.recall ? t('common.confirm') : t('common.none')}`),
              h(Button, {variant: 'danger', onClick: () => { setRetireOpen(project); setRetireReason(''); }}, t('project.retire'))) : null,
            retireOpen && retireOpen.projectId === project.projectId ? h('form', {className: 'dshlm-inline-form', onSubmit: retire},
              h(TextInput, {value: retireReason, placeholder: t('project.retireReason'), onChange: setRetireReason}),
              h(Button, {variant: 'danger', type: 'submit', disabled: busy || retireReason.trim() === ''}, t('project.retireConfirm')),
              h(Button, {variant: 'ghost', onClick: () => setRetireOpen(null)}, t('common.cancel'))) : null))),
        h('p', {className: 'dshlm-hint'}, t('project.pref.hint')),
        open ? h('form', {className: 'dshlm-form', onSubmit: submit},
          h(Field, {label: t('project.name')}, h(TextInput, {value: name, placeholder: t('project.namePlaceholder'), onChange: setName})),
          asArray(repositories).map((repository, index) => h('div', {key: index, className: 'dshlm-repo-block'},
            h('div', {className: 'dshlm-row-line'},
              h('span', {className: 'dshlm-strong'}, `${t('project.repoList')} ${index + 1}`),
              repositories.length > 1 ? h(Button, {variant: 'ghost', onClick: () => removeRepository(index)}, t('project.removeRepository')) : null),
            h('div', {className: 'dshlm-grid-2'},
              h(Field, {label: t('project.repoId')}, h(TextInput, {value: repository.repoId, onChange: value => updateRepository(index, 'repoId', value)})),
              h(Field, {label: t('project.revision')}, h(TextInput, {value: repository.revision, onChange: value => updateRepository(index, 'revision', value)})),
              h(Field, {label: t('project.canonicalRoot')}, h(TextInput, {value: repository.canonicalRoot, placeholder: 'E:/code/project', onChange: value => updateRepository(index, 'canonicalRoot', value)})),
              h(Field, {label: t('project.worktreeRoot')}, h(TextInput, {value: repository.worktreeRoot, placeholder: 'E:/code/project', onChange: value => updateRepository(index, 'worktreeRoot', value)})),
              h(Field, {label: t('project.buildVariant')}, h(TextInput, {value: repository.buildVariant, placeholder: t('project.buildVariantPlaceholder'), onChange: value => updateRepository(index, 'buildVariant', value)}))
            )
          )),
          h('p', {className: 'dshlm-hint'}, t('project.pathHint')),
          h('div', {className: 'dshlm-row-line'},
            h(Button, {variant: 'ghost', onClick: addRepository}, t('project.addRepository')),
            h(Button, {variant: 'primary', type: 'submit', disabled: busy || name.trim() === ''}, t('project.submit')))) : null);
    }

    /* ------------------------------------------------------------------ */
    /* Experiences tab                                                     */
    /* ------------------------------------------------------------------ */

    function MemoryTab(props) {
      const {t, projectId, call, onError, onNotice, onChanged, refreshSignal} = props;
      const mounted = useMounted();
      const [items, setItems] = React.useState([]);
      const [counts, setCounts] = React.useState({active: 0, archived: 0, deleted: 0});
      const [nextCursor, setNextCursor] = React.useState(null);
      const [stateFilter, setStateFilter] = React.useState('all');
      const [query, setQuery] = React.useState('');
      const [searching, setSearching] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [selectedId, setSelectedId] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [editText, setEditText] = React.useState('');
      const [deleteOpen, setDeleteOpen] = React.useState(false);
      const [loadError, setLoadError] = React.useState(null);
      const searchInput = React.useRef('');

      const loadPage = React.useCallback(async (options) => {
        const settings = options || {};
        if (!projectId) { setItems([]); return; }
        if (!settings.silent) setBusy(true);
        try {
          const input = {projectId, limit: PAGE_LIMIT, stateFilter};
          if (settings.cursor) input.cursor = settings.cursor;
          const value = await call('memory.list', input);
          if (!mounted.current) return;
          setItems(current => settings.append ? [...current, ...asArray(value.items)] : asArray(value.items));
          setCounts({active: value.counts?.active ?? 0, archived: value.counts?.archived ?? 0, deleted: value.counts?.deleted ?? 0});
          setNextCursor(value.nextCursor || null);
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          if (!settings.silent) onError(reasonOf(error));
          setLoadError(reasonOf(error));
        } finally {
          if (mounted.current && !settings.silent) setBusy(false);
        }
      }, [projectId, stateFilter]);
      const runSearch = React.useCallback(async (options) => {
        const settings = options || {};
        const term = settings.term !== undefined ? settings.term : searchInput.current;
        if (!projectId || !term || term.trim() === '') { setSearching(false); await loadPage(settings); return; }
        if (!settings.silent) setBusy(true);
        try {
          const input = {projectId, query: term.trim(), mode: 'manual', limit: PAGE_LIMIT};
          if (settings.cursor) input.cursor = settings.cursor;
          const value = await call('memory.search', input);
          if (!mounted.current) return;
          setItems(current => settings.append ? [...current, ...asArray(value.items)] : asArray(value.items));
          setNextCursor(value.nextCursor || null);
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          if (!settings.silent) onError(reasonOf(error));
          setLoadError(reasonOf(error));
        } finally {
          if (mounted.current && !settings.silent) setBusy(false);
        }
      }, [projectId]);
      const reload = React.useCallback(async (options) => {
        const settings = options || {};
        if (searching) await runSearch(settings);
        else await loadPage(settings);
      }, [searching, runSearch, loadPage]);
      const reloadRef = React.useRef(reload);
      reloadRef.current = reload;
      const loadDetail = React.useCallback(async (id, silent) => {
        if (!projectId || !id) { setDetail(null); return; }
        try {
          const value = await call('memory.get', {projectId, id});
          if (!mounted.current) return;
          setDetail(value);
          setEditText(text(value.item?.text));
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          if (!silent) onError(reasonOf(error));
          setDetail(null);
        }
      }, [projectId]);
      const detailRef = React.useRef(loadDetail);
      detailRef.current = loadDetail;

      React.useEffect(() => {
        setItems([]); setCounts({active: 0, archived: 0, deleted: 0}); setNextCursor(null); setSelectedId(null); setDetail(null);
        if (projectId) reload({silent: false});
      }, [projectId, stateFilter, refreshSignal]);
      React.useEffect(() => {
        if (selectedId) detailRef.current(selectedId, true);
      }, [selectedId, projectId, refreshSignal]);
      useVisiblePolling(() => {
        if (!projectId) return;
        reloadRef.current({silent: true});
        if (selectedId) detailRef.current(selectedId, true);
      }, Boolean(projectId) && !busy);

      function submitSearch(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setSearching(true);
        runSearch({term: searchInput.current || query, silent: false});
      }
      function clearSearch() {
        searchInput.current = '';
        setQuery('');
        setSearching(false);
        loadPage({silent: false});
      }
      async function mutate(operation, input, expectedRevision) {
        setBusy(true);
        try {
          const value = await call(operation, input, expectedRevision);
          if (!mounted.current) return undefined;
          onNotice(t('memory.stateChanged'));
          await reload({silent: true});
          if (selectedId) await detailRef.current(selectedId, true);
          return value;
        } catch (error) {
          if (mounted.current) onError(reasonOf(error));
          return undefined;
        } finally {
          if (mounted.current) setBusy(false);
        }
      }
      async function saveCorrection() {
        if (!detail || editText.trim() === '') return;
        const value = await mutate('memory.correct', {projectId, id: detail.item.id, text: editText.trim(), expectedGeneration: detail.currentGeneration});
        if (value) { setSelectedId(value.item.id); setDeleteOpen(false); }
      }
      async function archiveItem() {
        if (!detail) return;
        const value = await mutate('memory.archive', {projectId, id: detail.item.id, expectedGeneration: detail.currentGeneration});
        if (value) setDeleteOpen(false);
      }
      async function restoreItem() {
        if (!detail) return;
        const value = await mutate('memory.restore', {projectId, id: detail.item.id, expectedGeneration: detail.currentGeneration});
        if (value) setDeleteOpen(false);
      }
      async function deleteItem() {
        if (!detail) return;
        const value = await mutate('memory.delete', {projectId, id: detail.item.id, expectedGeneration: detail.currentGeneration});
        if (value) { setDeleteOpen(false); setSelectedId(null); setDetail(null); }
      }

      const stateFilters = ['all', 'active', 'archived'];
      const item = detail ? detail.item : null;
      const showLoadError = loadError && items.length === 0;
      return h('div', {className: 'dshlm-layout'},
        h('div', {className: 'dshlm-column'},
          h('section', {className: 'dshlm-card'},
            h('form', {className: 'dshlm-search', onSubmit: submitSearch},
              h(TextInput, {value: query, placeholder: t('memory.searchPlaceholder'), onChange: value => { setQuery(value); searchInput.current = value; }}),
              h(Button, {variant: 'primary', type: 'submit', disabled: busy || !projectId}, t('common.search')),
              searching ? h(Button, {variant: 'ghost', onClick: clearSearch}, t('common.clear')) : null),
            h('div', {className: 'dshlm-row-line'},
              stateFilters.map(filter => h(Button, {
                key: filter, variant: stateFilter === filter ? 'primary' : 'ghost',
                onClick: () => { setStateFilter(filter); setSearching(false); },
              }, t(`memory.filter.${filter}`))),
              h(Button, {variant: 'ghost', onClick: () => reload({silent: false}), disabled: busy || !projectId}, t('page.refresh'))),
            h('div', {className: 'dshlm-muted'}, t('memory.counts', counts)),
            showLoadError ? h(ErrorBanner, {message: reasonCodeLabel(t, loadError), retryLabel: t('common.retry'), onRetry: () => reload({silent: false})}) : null,
            !projectId ? h(Empty, null, t('page.noProject')) : null,
            projectId && !busy && items.length === 0 && !showLoadError ? h(Empty, null, searching ? t('memory.noMatch') : t('memory.empty')) : null,
            h('div', {className: 'dshlm-list'},
              items.map(entry => h(ListRow, {
                key: entry.id,
                selected: selectedId === entry.id,
                onClick: () => { setSelectedId(entry.id); setDeleteOpen(false); },
              },
              h('div', {className: 'dshlm-row-line'},
                h(StateBadge, {tone: entry.state === 'active' ? 'success' : 'neutral', label: t(`memory.state.${entry.state}`)}),
                h(Badge, {tone: 'neutral', title: t(`memory.origin.${entry.origin}`)}, entry.kind ? t(`memory.kind.${entry.kind}`) : t('common.unknown')),
                h('span', {className: 'dshlm-muted'}, t(`memory.origin.${entry.origin}`))),
              h('div', {className: 'dshlm-row-text'}, truncate(entry.text, 110))))),
            nextCursor ? h(Button, {
              variant: 'ghost',
              onClick: () => reload({cursor: nextCursor, append: true}),
              disabled: busy,
            }, t('memory.loadMore')) : null),
          h(ProjectPanel, {t, projects: props.projects, projectId, call, onError, onNotice, onChanged})),
        h('div', {className: 'dshlm-column'},
          h('section', {className: 'dshlm-card dshlm-detail'},
            item ? h('div', null,
              h('div', {className: 'dshlm-row-line'},
                h(StateBadge, {tone: item.state === 'active' ? 'success' : item.state === 'deleted' ? 'danger' : 'neutral', label: t(`memory.state.${item.state}`)}),
                h(Badge, {tone: 'neutral'}, item.kind ? t(`memory.kind.${item.kind}`) : t('common.unknown')),
                h(Badge, {tone: 'warn', title: t('memory.verification.unverified')}, t('memory.verification.unverified')),
                h('span', {className: 'dshlm-muted'}, t('memory.generation', {n: numberText(item.generation)}))),
              h('p', {className: 'dshlm-detail-text'}, item.textUnavailable === true ? t(`memory.state.${item.state}`) : item.text),
              h('dl', {className: 'dshlm-meta'},
                h('div', null, h('dt', null, t('memory.source')), h('dd', null, `${item.source?.sourceRef || t('common.unknown')} · ${item.source?.sourceVersion || ''}`)),
                h('div', null, h('dt', null, t('memory.originLabel')), h('dd', null, item.origin ? t(`memory.origin.${item.origin}`) : t('common.unknown'))),
                h('div', null, h('dt', null, t('task.repo')), h('dd', null, item.repoId || t('common.unknown')))),
              item.state === 'active' ? h('div', {className: 'dshlm-actions'},
                h('div', {className: 'dshlm-form'},
                  h(Field, {label: t('memory.correct'), hint: t('memory.correctHint')},
                    h(TextArea, {value: editText, onChange: setEditText})),
                  h(Button, {variant: 'primary', disabled: busy || editText.trim() === '' || editText.trim() === text(item.text), onClick: saveCorrection}, t('memory.saveCorrection'))),
                h('div', {className: 'dshlm-row-line'},
                  h(Button, {variant: 'ghost', disabled: busy, onClick: archiveItem, title: t('memory.archiveHint')}, t('memory.archive')),
                  h(Button, {variant: 'danger', disabled: busy, onClick: () => setDeleteOpen(true)}, t('memory.delete')))) : null,
              item.state === 'archived' ? h('div', {className: 'dshlm-actions'},
                h('div', {className: 'dshlm-row-line'},
                  h(Button, {variant: 'primary', disabled: busy, onClick: restoreItem}, t('memory.restore')),
                  h(Button, {variant: 'danger', disabled: busy, onClick: () => setDeleteOpen(true)}, t('memory.delete'))),
                h('p', {className: 'dshlm-hint'}, t('memory.archiveHint'))) : null,
              (item.state === 'deleted' || item.state === 'superseded' || item.state === 'stale') ? h('p', {className: 'dshlm-hint'}, t('memory.tombstoneHint')) : null,
              deleteOpen ? h('div', {className: 'dshlm-danger-zone', role: 'alertdialog'},
                h('p', {className: 'dshlm-error-text'}, t('memory.deleteWarning')),
                h('p', {className: 'dshlm-hint'}, t('memory.deleteRemoteNote')),
                h('div', {className: 'dshlm-row-line'},
                  h(Button, {variant: 'danger', disabled: busy, onClick: deleteItem}, t('memory.deleteFinal')),
                  h(Button, {variant: 'ghost', onClick: () => setDeleteOpen(false)}, t('common.cancel')))) : null) : h(Empty, null, t('memory.empty')))));
    }

    /* ------------------------------------------------------------------ */
    /* Annual work records tab                                             */
    /* ------------------------------------------------------------------ */

    const CLAIM_REFS = ['myContribution', 'processOrConclusion', 'result'];
    const WORK_ROW_LIMIT = 50;

    function WorkTab(props) {
      const {t, projectId, call, onError, onNotice, refreshSignal} = props;
      const mounted = useMounted();
      const [items, setItems] = React.useState([]);
      const [nextCursor, setNextCursor] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [selectedId, setSelectedId] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [loadError, setLoadError] = React.useState(null);
      const [evidenceOpen, setEvidenceOpen] = React.useState(false);
      const [evidenceName, setEvidenceName] = React.useState('');
      const [evidencePath, setEvidencePath] = React.useState('');
      const [evidenceClaim, setEvidenceClaim] = React.useState('myContribution');
      const [report, setReport] = React.useState(null);
      const [exportRef, setExportRef] = React.useState('');
      const currentYear = new Date().getFullYear();
      const [reportFrom, setReportFrom] = React.useState(String(currentYear));
      const [reportTo, setReportTo] = React.useState(String(currentYear));
      const generationOf = record => {
        if (record && Number.isSafeInteger(record.generation)) return record.generation;
        if (record && Number.isSafeInteger(record.expectedGeneration)) return record.expectedGeneration;
        return undefined;
      };

      const loadList = React.useCallback(async (options) => {
        const settings = options || {};
        if (!projectId) { setItems([]); return; }
        if (!settings.silent) setBusy(true);
        try {
          const input = {projectId, limit: WORK_ROW_LIMIT};
          if (settings.cursor) input.cursor = settings.cursor;
          const value = await call('work.list', input);
          if (!mounted.current) return;
          setItems(current => settings.append ? [...current, ...asArray(value.items)] : asArray(value.items));
          setNextCursor(value.nextCursor || null);
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          const code = reasonOf(error);
          setLoadError(code);
          if (!settings.silent) onError(code);
        } finally {
          if (mounted.current && !settings.silent) setBusy(false);
        }
      }, [projectId]);
      const loadDetail = React.useCallback(async (id, silent) => {
        if (!projectId || !id) { setDetail(null); return; }
        try {
          const value = await call('work.get', {projectId, id});
          if (!mounted.current) return;
          setDetail(value);
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          if (!silent) onError(reasonOf(error));
          setDetail(null);
        }
      }, [projectId]);
      const listRef = React.useRef(loadList);
      listRef.current = loadList;
      const detailRef = React.useRef(loadDetail);
      detailRef.current = loadDetail;

      React.useEffect(() => {
        setItems([]); setNextCursor(null); setSelectedId(null); setDetail(null);
        if (projectId) loadList({silent: false});
      }, [projectId, refreshSignal]);
      React.useEffect(() => {
        if (selectedId) detailRef.current(selectedId, true);
      }, [selectedId, projectId, refreshSignal]);
      useVisiblePolling(() => {
        if (!projectId) return;
        listRef.current({silent: true});
        if (selectedId) detailRef.current(selectedId, true);
      }, Boolean(projectId) && !busy);

      async function run(operation, input, expectedRevision) {
        setBusy(true);
        try {
          const value = await call(operation, input, expectedRevision);
          if (!mounted.current) return undefined;
          return value;
        } catch (error) {
          if (mounted.current) onError(reasonOf(error));
          return undefined;
        } finally {
          if (mounted.current) setBusy(false);
        }
      }
      async function refreshWork(jobId) {
        await loadList({silent: true});
        if (jobId) await loadDetail(jobId, true);
      }
      async function confirmClaim(claimRef) {
        if (!detail) return;
        const value = await run('work.confirmClaim', {projectId, id: detail.id, claimRef, expectedGeneration: generationOf(detail)});
        if (value) { onNotice(t('notice.saved')); await refreshWork(detail.id); }
      }
      async function confirmTime() {
        if (!detail) return;
        const value = await run('work.confirmTime', {projectId, id: detail.id, expectedGeneration: generationOf(detail)});
        if (value) { onNotice(t('notice.saved')); await refreshWork(detail.id); }
      }
      async function registerEvidence(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!detail) return;
        const reference = {displayName: evidenceName.trim()};
        if (evidencePath.trim() !== '') reference.localPath = evidencePath.trim();
        const value = await run('work.evidence.register', {
          projectId, id: detail.id, reference, claimRefs: [evidenceClaim], expectedGeneration: generationOf(detail),
        });
        if (value) {
          setEvidenceOpen(false); setEvidenceName(''); setEvidencePath('');
          onNotice(t('notice.saved'));
          await refreshWork(detail.id);
        }
      }
      async function deferReminder(claimRef) {
        if (!detail) return;
        const value = await run('reminder.defer', {projectId, recordId: detail.id, claimRef, hours: 24});
        if (value) onNotice(t('notice.saved'));
      }
      async function disableReminder(claimRef) {
        if (!detail) return;
        const value = await run('reminder.disable', {projectId, recordId: detail.id, claimRef});
        if (value) onNotice(t('notice.saved'));
      }
      async function draftReport(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setBusy(true);
        try {
          const value = await call('report.draft', {projectIds: [projectId], timeRange: {from: reportFrom, to: reportTo, precision: 'year'}});
          if (!mounted.current) return;
          setReport(value);
          setExportRef('');
        } catch (error) {
          if (mounted.current) onError(reasonOf(error));
        } finally {
          if (mounted.current) setBusy(false);
        }
      }
      async function approveReport() {
        if (!report) return;
        const value = await run('report.approve', {reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: report.sourceRevisions});
        if (value) { setReport({...report, ...value}); onNotice(t('notice.saved')); }
      }
      async function exportReport(format) {
        if (!report) return;
        setBusy(true);
        try {
          const value = await call('report.export', {reportId: report.reportId, revision: report.revision, format});
          if (!mounted.current) return;
          setExportRef(value.ref || '');
          onNotice(t('work.report.exported', {ref: value.ref || ''}));
        } catch (error) {
          if (mounted.current) onError(reasonOf(error));
        } finally {
          if (mounted.current) setBusy(false);
        }
      }

      const detailRecord = detail || items.find(entry => entry.id === selectedId) || null;
      const claimLabel = claimRef => t(`work.claim.${claimRef}`);
      const supportLabel = support => t(`work.support.${support}`);
      const precisionLabel = precision => t(`work.time.precision.${precision}`);
      const reportState = report ? (report.state || 'draft') : 'draft';
      const pendingEvidence = asArray(detailRecord?.pendingEvidence);
      const pendingConfirmation = asArray(detailRecord?.pendingConfirmation);
      return h('div', {className: 'dshlm-layout'},
        h('div', {className: 'dshlm-column'},
          h('section', {className: 'dshlm-card'},
            h('div', {className: 'dshlm-row-line'},
              h('h3', {className: 'dshlm-card-title'}, t('work.title')),
              h(Button, {variant: 'ghost', disabled: busy || !projectId, onClick: () => loadList({silent: false})}, t('page.refresh'))),
            loadError && items.length === 0 ? h(ErrorBanner, {message: reasonCodeLabel(t, loadError), retryLabel: t('common.retry'), onRetry: () => loadList({silent: false})}) : null,
            !projectId ? h(Empty, null, t('page.noProject')) : null,
            projectId && !busy && items.length === 0 && !loadError ? h(Empty, null, t('work.empty')) : null,
            h('div', {className: 'dshlm-list'},
              items.map(entry => h(ListRow, {
                key: entry.id,
                selected: selectedId === entry.id,
                onClick: () => setSelectedId(entry.id),
              },
              h('div', {className: 'dshlm-row-line'},
                h(Badge, {tone: 'neutral'}, t(`work.itemType.${entry.itemType}`)),
                h('span', {className: 'dshlm-strong'}, truncate(entry.title, 80)),
                h('span', {className: 'dshlm-muted'}, precisionLabel(entry.time?.precision || 'unknown'))),
              h('div', {className: 'dshlm-row-text dshlm-muted'}, truncate(entry.myContribution?.text, 100))))),
            nextCursor ? h(Button, {variant: 'ghost', disabled: busy, onClick: () => loadList({cursor: nextCursor, append: true})}, t('work.loadMore')) : null),
          h('section', {className: 'dshlm-card'},
            h('h3', {className: 'dshlm-card-title'}, t('work.report.title')),
            h('form', {className: 'dshlm-inline-form', onSubmit: draftReport},
              h(Field, {label: t('work.report.from')}, h(TextInput, {value: reportFrom, placeholder: '2026', onChange: setReportFrom})),
              h(Field, {label: t('work.report.to')}, h(TextInput, {value: reportTo, placeholder: '2026', onChange: setReportTo})),
              h(Button, {variant: 'primary', type: 'submit', disabled: busy || !projectId}, t('work.report.draft'))),
            report ? h('div', {className: 'dshlm-report'},
              h('div', {className: 'dshlm-row-line'},
                h(StateBadge, {tone: reportState === 'approved' ? 'success' : reportState === 'stale' ? 'danger' : 'neutral', label: t(`work.report.state.${reportState}`)}),
                h('span', {className: 'dshlm-muted'}, `${report.reportId} · r${numberText(report.revision)}`),
                h('span', {className: 'dshlm-muted'}, t('work.report.pendingProofs', {n: numberText(report.pendingProofs?.length ?? 0)})),
                h('span', {className: 'dshlm-muted'}, t('work.report.pendingConfirmations', {n: numberText(report.pendingConfirmations?.length ?? 0)}))),
              h('div', {className: 'dshlm-row-line'},
                h(Button, {variant: 'primary', disabled: busy || reportState === 'approved', onClick: approveReport}, t('work.report.approve')),
                h(Button, {variant: 'ghost', disabled: busy, onClick: () => exportReport('markdown')}, t('work.report.exportMarkdown')),
                h(Button, {variant: 'ghost', disabled: busy, onClick: () => exportReport('json')}, t('work.report.exportJson'))),
              h('p', {className: 'dshlm-hint'}, t('work.report.approveHint')),
              h('p', {className: 'dshlm-hint'}, t('work.report.dimensionPending')),
              exportRef ? h('p', {className: 'dshlm-muted'}, t('work.report.exported', {ref: exportRef})) : null) : h(Empty, null, t('work.empty')))),
        h('div', {className: 'dshlm-column'},
          h('section', {className: 'dshlm-card dshlm-detail'},
            detailRecord ? h('div', null,
              h('div', {className: 'dshlm-row-line'},
                h(Badge, {tone: 'neutral'}, t(`work.itemType.${detailRecord.itemType}`)),
                h('h3', {className: 'dshlm-card-title'}, detailRecord.title)),
              h('p', {className: 'dshlm-hint'}, t('work.goal') + ': ' + text(detailRecord.goal)),
              h('dl', {className: 'dshlm-meta'},
                CLAIM_REFS.map(claimRef => {
                  const claim = detailRecord[claimRef] || {};
                  return h('div', {key: claimRef},
                    h('dt', null,
                      claimLabel(claimRef),
                      ' ',
                      h(Badge, {tone: claim.confirmation === 'user_confirmed' ? 'success' : 'warn'},
                        claim.confirmation === 'user_confirmed' ? t('work.confirmed') : t('work.pending')),
                      ' ',
                      h(Badge, {tone: claim.support === 'missing' ? 'warn' : 'neutral'}, supportLabel(claim.support || 'missing'))),
                    h('dd', null, text(claim.text)),
                    claim.confirmation !== 'user_confirmed' ? h('div', {className: 'dshlm-row-line'},
                      h(Button, {variant: 'ghost', disabled: busy, onClick: () => confirmClaim(claimRef)}, t('work.confirmClaim'))) : null);
                })),
              h('div', {className: 'dshlm-row-line'},
                h('span', {className: 'dshlm-muted'}, t('work.time.precision') + ': ' + precisionLabel(detailRecord.time?.precision || 'unknown')),
                h('span', {className: 'dshlm-muted'}, `${text(detailRecord.time?.start) || t('common.unknown')} → ${text(detailRecord.time?.end) || t('common.unknown')}`),
                detailRecord.time?.confirmation === 'user_confirmed' ? h(StateBadge, {tone: 'success', label: t('work.confirmed')}) :
                  (detailRecord.time?.precision !== 'unknown' && detailRecord.time?.start ? h(Button, {variant: 'ghost', disabled: busy, onClick: confirmTime}, t('work.confirmTime')) : null)),
              detailRecord.time?.precision === 'unknown' ? h('p', {className: 'dshlm-hint'}, t('work.time.unknownHint')) : null,
              h('h4', {className: 'dshlm-section-title'}, t('work.evidence.title')),
              asArray(detailRecord.evidenceRefs).length === 0 ? h('p', {className: 'dshlm-hint'}, t('work.evidence.none')) : h('ul', {className: 'dshlm-plain-list'},
                asArray(detailRecord.evidenceRefs).map(reference => h('li', {key: reference.id},
                  `${reference.displayName} · ${asArray(reference.claimRefs).map(claimLabel).join(', ')} · ${t(`work.evidence.status.${reference.accessStatus || 'unread'}`)}`))),
              evidenceOpen ? h('form', {className: 'dshlm-form', onSubmit: registerEvidence},
                h(Field, {label: t('work.evidence.displayName')}, h(TextInput, {value: evidenceName, onChange: setEvidenceName})),
                h(Field, {label: t('work.evidence.localPath'), hint: t('work.evidence.pathHint')}, h(TextInput, {value: evidencePath, placeholder: 'E:/docs/proof.md', onChange: setEvidencePath})),
                h(Field, {label: t('work.claim.myContribution')}, h('select', {
                  className: 'dshlm-select', value: evidenceClaim, onChange: event => setEvidenceClaim(event.target.value),
                }, CLAIM_REFS.map(claimRef => h('option', {key: claimRef, value: claimRef}, claimLabel(claimRef))))),
                h('div', {className: 'dshlm-row-line'},
                  h(Button, {variant: 'primary', type: 'submit', disabled: busy || evidenceName.trim() === ''}, t('work.evidence.submit')),
                  h(Button, {variant: 'ghost', onClick: () => setEvidenceOpen(false)}, t('common.cancel')))) :
                h(Button, {variant: 'ghost', onClick: () => setEvidenceOpen(true)}, t('work.evidence.register')),
              pendingEvidence.length > 0 ? h('div', null,
                h('h4', {className: 'dshlm-section-title'}, t('work.pendingEvidence')),
                h('ul', {className: 'dshlm-plain-list'},
                  pendingEvidence.map(entry => h('li', {key: `proof-${entry.claimRef}`},
                    `${claimLabel(entry.claimRef)} · ${supportLabel(entry.support || 'missing')} `,
                    h(Button, {variant: 'ghost', disabled: busy, onClick: () => deferReminder(entry.claimRef)}, t('work.reminder.defer')),
                    h(Button, {variant: 'ghost', disabled: busy, onClick: () => disableReminder(entry.claimRef)}, t('work.reminder.disable')))))) : null,
              pendingConfirmation.length > 0 ? h('div', null,
                h('h4', {className: 'dshlm-section-title'}, t('work.pendingConfirmation')),
                h('ul', {className: 'dshlm-plain-list'},
                  pendingConfirmation.map(claimRef => h('li', {key: `confirm-${claimRef}`}, claimLabel(claimRef))))) : null,
              asArray(detailRecord.sources).length > 0 ? h('div', null,
                h('h4', {className: 'dshlm-section-title'}, t('work.sources')),
                h('ul', {className: 'dshlm-plain-list'},
                  asArray(detailRecord.sources).map(source => h('li', {key: `${source.sourceRef}/${source.sourceVersion}`}, `${source.sourceRef} · ${source.sourceVersion}`)))) : null,
              asArray(detailRecord.conflicts).length > 0 ? h('div', null,
                h('h4', {className: 'dshlm-section-title'}, t('work.conflicts')),
                h('ul', {className: 'dshlm-plain-list'},
                  asArray(detailRecord.conflicts).map((conflict, index) => h('li', {key: `conflict-${index}`}, `${claimLabel(conflict.claimRef)}: ${truncate(conflict.text, 120)}`)))) : null) : h(Empty, null, t('work.empty')))));
    }

    /* ------------------------------------------------------------------ */
    /* Processing jobs tab                                                 */
    /* ------------------------------------------------------------------ */

    function TasksTab(props) {
      const {t, projectId, call, onError, onNotice, refreshSignal} = props;
      const mounted = useMounted();
      const [items, setItems] = React.useState([]);
      const [nextCursor, setNextCursor] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [selectedId, setSelectedId] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [loadError, setLoadError] = React.useState(null);
      const [confirmOpen, setConfirmOpen] = React.useState(false);

      const loadList = React.useCallback(async (options) => {
        const settings = options || {};
        if (!projectId) { setItems([]); return; }
        if (!settings.silent) setBusy(true);
        try {
          const input = {projectId, limit: PAGE_LIMIT};
          if (settings.cursor) input.cursor = settings.cursor;
          const value = await call('task.list', input);
          if (!mounted.current) return;
          setItems(current => settings.append ? [...current, ...asArray(value.items)] : asArray(value.items));
          setNextCursor(value.nextCursor || null);
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          const code = reasonOf(error);
          setLoadError(code);
          if (!settings.silent) onError(code);
        } finally {
          if (mounted.current && !settings.silent) setBusy(false);
        }
      }, [projectId]);
      const loadDetail = React.useCallback(async (jobId, silent) => {
        if (!projectId || !jobId) { setDetail(null); return; }
        try {
          const value = await call('task.inspect', {projectId, jobId});
          if (!mounted.current) return;
          setDetail(value);
          setLoadError(null);
        } catch (error) {
          if (!mounted.current) return;
          if (!silent) onError(reasonOf(error));
          setDetail(null);
        }
      }, [projectId]);
      const listRef = React.useRef(loadList);
      listRef.current = loadList;
      const detailRef = React.useRef(loadDetail);
      detailRef.current = loadDetail;

      React.useEffect(() => {
        setItems([]); setNextCursor(null); setSelectedId(null); setDetail(null); setConfirmOpen(false);
        if (projectId) loadList({silent: false});
      }, [projectId, refreshSignal]);
      React.useEffect(() => {
        if (selectedId) detailRef.current(selectedId, true);
      }, [selectedId, projectId, refreshSignal]);
      useVisiblePolling(() => {
        if (!projectId) return;
        listRef.current({silent: true});
        if (selectedId) detailRef.current(selectedId, true);
      }, Boolean(projectId) && !busy);

      async function run(operation, input) {
        setBusy(true);
        try {
          const value = await call(operation, input);
          if (!mounted.current) return undefined;
          onNotice(t('notice.saved'));
          return value;
        } catch (error) {
          if (mounted.current) onError(reasonOf(error));
          return undefined;
        } finally {
          if (mounted.current) setBusy(false);
        }
      }
      async function cancelJob() {
        const job = detail ? detail.job : null;
        if (!job) return;
        const expected = Number.isSafeInteger(job.expectedGeneration) ? job.expectedGeneration : undefined;
        const value = await run('task.cancel', {projectId, jobId: job.jobId, expectedGeneration: expected});
        if (value) { onNotice(t('task.cancelHint')); loadDetail(job.jobId, false); loadList({silent: true}); }
      }
      async function confirmQuiescence(status) {
        const job = detail ? detail.job : null;
        if (!job) return;
        const operation = actions.includes('confirmRemoteQuiescence') ? 'task.confirmRemoteQuiescence' : 'recovery.confirm';
        const value = await run(operation, {projectId, jobId: job.jobId, status});
        if (value) { setConfirmOpen(false); loadDetail(job.jobId, false); loadList({silent: true}); }
      }

      const job = detail ? detail.job : null;
      const actions = asArray(job?.actions);
      const canCancel = actions.includes('cancel');
      const canConfirm = actions.includes('confirmRemoteQuiescence') || actions.includes('recovery.confirm');
      return h('div', {className: 'dshlm-layout'},
        h('div', {className: 'dshlm-column'},
          h('section', {className: 'dshlm-card'},
            h('div', {className: 'dshlm-row-line'},
              h('h3', {className: 'dshlm-card-title'}, t('task.title')),
              h(Button, {variant: 'ghost', disabled: busy || !projectId, onClick: () => loadList({silent: false})}, t('page.refresh'))),
            loadError && items.length === 0 ? h(ErrorBanner, {message: reasonCodeLabel(t, loadError), retryLabel: t('common.retry'), onRetry: () => loadList({silent: false})}) : null,
            !projectId ? h(Empty, null, t('page.noProject')) : null,
            projectId && !busy && items.length === 0 && !loadError ? h(Empty, null, t('task.empty')) : null,
            h('div', {className: 'dshlm-list'},
              items.map(entry => h(ListRow, {
                key: entry.jobId,
                selected: selectedId === entry.jobId,
                onClick: () => { setSelectedId(entry.jobId); setConfirmOpen(false); },
              },
              h('div', {className: 'dshlm-row-line'},
                h(StateBadge, {
                  tone: entry.state === 'completed' ? 'success' : entry.state === 'outcome_unknown' || entry.state === 'failed' ? 'danger' : 'neutral',
                  label: t(`task.state.${entry.state}`),
                }),
                h('span', {className: 'dshlm-muted'}, t(`task.purpose.${entry.purpose}`)),
                entry.quarantined ? h(Badge, {tone: 'danger'}, t('task.quarantined')) : null),
              h('div', {className: 'dshlm-row-text dshlm-muted'}, `${entry.jobId} · ${text(entry.createdAt)}`)))),
            nextCursor ? h(Button, {variant: 'ghost', disabled: busy, onClick: () => loadList({cursor: nextCursor, append: true})}, t('task.loadMore')) : null),
          h('p', {className: 'dshlm-hint'}, t('footer.hint'))),
        h('div', {className: 'dshlm-column'},
          h('section', {className: 'dshlm-card dshlm-detail'},
            job ? h('div', null,
              h('div', {className: 'dshlm-row-line'},
                h(StateBadge, {
                  tone: job.state === 'completed' ? 'success' : job.state === 'outcome_unknown' || job.state === 'failed' ? 'danger' : 'neutral',
                  label: t(`task.state.${job.state}`),
                }),
                h('span', {className: 'dshlm-muted'}, t(`task.phase.${job.phase}`)),
                job.quarantined ? h(Badge, {tone: 'danger'}, t('task.quarantined')) : null),
              h('dl', {className: 'dshlm-meta'},
                h('div', null, h('dt', null, t('task.job')), h('dd', null, job.jobId)),
                h('div', null, h('dt', null, t('task.purpose')), h('dd', null, t(`task.purpose.${job.purpose}`))),
                h('div', null, h('dt', null, t('task.reason')), h('dd', null, job.reason || t('common.none'))),
                h('div', null, h('dt', null, t('task.costStatus')), h('dd', null, t(`task.cost.${job.costStatus}`))),
                h('div', null, h('dt', null, t('task.createdAt')), h('dd', null, text(job.createdAt) || t('common.unknown'))),
                h('div', null, h('dt', null, t('task.repo')), h('dd', null, job.repoId || t('common.unknown')))),
              job.state === 'outcome_unknown' ? h('div', {className: 'dshlm-danger-zone'},
                h('p', {className: 'dshlm-strong'}, t('task.unknownTitle')),
                h('p', {className: 'dshlm-hint'}, t('task.unknownHint')),
                h('p', {className: 'dshlm-hint'}, t('task.noRetry')),
                canConfirm ? h('div', null,
                  confirmOpen ? h('div', {className: 'dshlm-form'},
                    h(Button, {variant: 'primary', disabled: busy, onClick: () => confirmQuiescence('remote_finished')}, t('task.confirmFinished')),
                    h(Button, {variant: 'primary', disabled: busy, onClick: () => confirmQuiescence('remote_cancel_confirmed')}, t('task.confirmCancelConfirmed')),
                    h(Button, {variant: 'ghost', onClick: () => setConfirmOpen(false)}, t('common.cancel')),
                    h('p', {className: 'dshlm-hint'}, t('task.remoteStopNotClaimed'))) :
                    h(Button, {variant: 'primary', disabled: busy, onClick: () => setConfirmOpen(true)}, t('task.confirmRemote'))) : h('p', {className: 'dshlm-hint'}, t('task.remoteStopNotClaimed'))) : null,
              h('div', {className: 'dshlm-row-line'},
                canCancel ? h(Button, {variant: 'danger', disabled: busy, onClick: cancelJob}, t('task.cancel')) : null),
              canCancel ? h('p', {className: 'dshlm-hint'}, t('task.cancelHint')) : null,
              h('p', {className: 'dshlm-hint'}, t('task.noRetry'))) : h(Empty, null, t('task.empty')))));
    }

    /* ------------------------------------------------------------------ */
    /* Root page                                                           */
    /* ------------------------------------------------------------------ */

    function MemoryCenter(props) {
      const t = createTranslator(props);
      const mounted = useMounted();
      const call = props.call;
      const [projects, setProjects] = React.useState([]);
      const [status, setStatus] = React.useState(null);
      const [projectId, setProjectId] = React.useState('');
      const [section, setSection] = React.useState('memory');
      const [errorCode, setErrorCode] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [refreshSignal, setRefreshSignal] = React.useState(0);

      const loadBootstrap = React.useCallback(async (silent) => {
        try {
          const [projectValue, statusValue] = await Promise.all([
            call('project.list', {}),
            call('status', {}).catch(() => null),
          ]);
          if (!mounted.current) return;
          const list = asArray(projectValue.projects);
          setProjects(list);
          setStatus(statusValue);
          setProjectId(current => {
            if (current && list.some(project => project.projectId === current)) return current;
            const preferred = list.find(project => project.state === 'active') || list[0];
            return preferred ? preferred.projectId : '';
          });
        } catch (error) {
          if (!mounted.current) return;
          if (!silent) setErrorCode(reasonOf(error));
        }
      }, []);
      const bootstrapRef = React.useRef(loadBootstrap);
      bootstrapRef.current = loadBootstrap;

      React.useEffect(() => { loadBootstrap(false); }, [refreshSignal]);
      useVisiblePolling(() => { bootstrapRef.current(true); }, true);

      React.useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => { if (mounted.current) setNotice(null); }, 4000);
        return () => clearTimeout(timer);
      }, [notice]);

      function onError(code) {
        if (!mounted.current) return;
        setErrorCode(code);
        setNotice(null);
      }
      function onNotice(message) {
        if (!mounted.current) return;
        setNotice(message);
        setErrorCode(null);
      }
      function onChanged() {
        if (!mounted.current) return;
        setRefreshSignal(current => current + 1);
      }
      function manualRefresh() {
        setErrorCode(null);
        setNotice(t('page.refreshed'));
        setRefreshSignal(current => current + 1);
        bootstrapRef.current(true);
      }

      const schedulerState = status && status.scheduler && typeof status.scheduler.state === 'string' ? status.scheduler.state : 'unavailable';
      const schedulerKey = `status.scheduler.${schedulerState}`;
      const schedulerLabel = lookup(DICTIONARIES.en, schedulerKey) !== undefined ? t(schedulerKey) : t('status.scheduler.unavailable');
      const sections = ['memory', 'work', 'tasks'];
      const hasProject = projectId !== '';
      let body;
      if (section === 'work') body = h(WorkTab, {key: 'work', t, projectId, call, onError, onNotice, refreshSignal});
      else if (section === 'tasks') body = h(TasksTab, {key: 'tasks', t, projectId, call, onError, onNotice, refreshSignal});
      else body = h(MemoryTab, {key: 'memory', t, projectId, call, onError, onNotice, onChanged, refreshSignal, projects});

      return h('div', {className: 'dshlm-root'},
        h('style', null, CSS_TEXT),
        h('header', {className: 'dshlm-header'},
          h('div', null,
            h('h2', {className: 'dshlm-title'}, t('page.title')),
            h('p', {className: 'dshlm-subtitle'}, t('page.subtitle'))),
          h('div', {className: 'dshlm-header-actions'},
            h('span', {className: 'dshlm-muted'}, t('status.projects', {n: asArray(projects).length})),
            h('span', {className: 'dshlm-muted'}, schedulerLabel),
            h(Button, {variant: 'ghost', onClick: manualRefresh}, t('page.refresh')))),
        h('nav', {className: 'dshlm-tabs', role: 'tablist'},
          sections.map(name => h('button', {
            key: name,
            type: 'button',
            role: 'tab',
            'aria-selected': section === name,
            className: 'dshlm-tab',
            'data-active': section === name,
            onClick: () => { setSection(name); setErrorCode(null); },
          }, t(`tabs.${name}`)))),
        h('div', {className: 'dshlm-toolbar'},
          h('label', {className: 'dshlm-toolbar-label'}, t('page.selectProject'),
            h('select', {
              className: 'dshlm-select',
              value: projectId,
              disabled: asArray(projects).length === 0,
              onChange: event => setProjectId(event.target.value),
            },
            asArray(projects).length === 0 ? h('option', {value: ''}, t('page.noProject')) : null,
            asArray(projects).map(project => h('option', {key: project.projectId, value: project.projectId},
              `${project.name} (${t(`project.state.${project.state}`)})`))))),
        !hasProject && asArray(projects).length === 0 ? h(Empty, null, t('page.noProject')) : null,
        errorCode ? h(ErrorBanner, {
          message: reasonCodeLabel(t, errorCode),
          retryLabel: t('page.retry'),
          onRetry: manualRefresh,
        }) : null,
        notice ? h(Notice, null, notice) : null,
        body,
        h('footer', {className: 'dshlm-footer'},
          h('span', {className: 'dshlm-muted'}, t('memory.deleteRemoteNote'))));
    }

    const CSS_TEXT = `
      .dshlm-root { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); min-height: 100%; }
      .dshlm-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .dshlm-title { margin: 0; font-size: 1.15em; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dshlm-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 0.92em; }
      .dshlm-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--dsw-alias-label-tertiary); }
      .dshlm-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dshlm-tab { background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; }
      .dshlm-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .dshlm-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dshlm-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dshlm-toolbar-label { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
      .dshlm-layout { display: grid; grid-template-columns: minmax(240px, 360px) minmax(0, 1fr); gap: 12px; align-items: start; }
      .dshlm-column { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .dshlm-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .dshlm-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .dshlm-card-title { margin: 0; font-size: 0.98em; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dshlm-section-title { margin: 8px 0 2px; font-size: 0.92em; font-weight: 600; color: var(--dsw-alias-label-secondary); }
      .dshlm-detail { min-height: 160px; }
      .dshlm-detail-text { white-space: pre-wrap; word-break: break-word; margin: 0; color: var(--dsw-alias-label-primary); }
      .dshlm-list { display: flex; flex-direction: column; gap: 4px; max-height: 460px; overflow: auto; }
      .dshlm-row { display: flex; flex-direction: column; gap: 3px; text-align: start; width: 100%; padding: 7px 8px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      .dshlm-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dshlm-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-hover-solid); border-color: var(--dsw-alias-border-l2); }
      .dshlm-row-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
      .dshlm-row-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dshlm-project { max-height: 420px; overflow: auto; }
      .dshlm-project-row { display: flex; flex-direction: column; gap: 3px; padding: 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); }
      .dshlm-project-row[data-selected="true"] { border-color: var(--dsw-alias-state-business-primary); }
      .dshlm-chip { display: inline-block; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 0.86em; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dshlm-badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; font-size: 0.82em; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .dshlm-badge[data-tone="success"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .dshlm-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .dshlm-badge[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .dshlm-btn { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); cursor: pointer; }
      .dshlm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dshlm-btn:disabled { opacity: 0.55; cursor: default; }
      .dshlm-btn[data-variant="primary"] { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
      .dshlm-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .dshlm-btn[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: transparent; }
      .dshlm-btn[data-variant="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
      .dshlm-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .dshlm-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dshlm-input, .dshlm-textarea, .dshlm-select { box-sizing: border-box; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; color: var(--dsw-alias-label-primary); font: inherit; padding: 3px 7px; min-width: 0; }
      .dshlm-input, .dshlm-textarea { width: 100%; }
      .dshlm-textarea { resize: vertical; }
      .dshlm-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .dshlm-field-label { color: var(--dsw-alias-label-secondary); font-size: 0.9em; }
      .dshlm-field-hint { color: var(--dsw-alias-label-tertiary); font-size: 0.84em; }
      .dshlm-form { display: flex; flex-direction: column; gap: 8px; }
      .dshlm-inline-form { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
      .dshlm-search { display: flex; gap: 6px; }
      .dshlm-search .dshlm-input { flex: 1 1 auto; }
      .dshlm-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; }
      .dshlm-repo-block { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 6px; }
      .dshlm-actions { display: flex; flex-direction: column; gap: 8px; }
      .dshlm-danger-zone { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
      .dshlm-error-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px; color: var(--dsw-alias-state-error-primary); }
      .dshlm-notice { padding: 5px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .dshlm-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 0.87em; }
      .dshlm-muted { color: var(--dsw-alias-label-tertiary); }
      .dshlm-strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dshlm-empty { color: var(--dsw-alias-label-tertiary); padding: 10px 2px; }
      .dshlm-error-text { color: var(--dsw-alias-state-error-primary); }
      .dshlm-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px; margin: 0; }
      .dshlm-meta dt { color: var(--dsw-alias-label-tertiary); font-size: 0.84em; }
      .dshlm-meta dd { margin: 0; word-break: break-all; }
      .dshlm-plain-list { margin: 0; padding-inline-start: 18px; display: flex; flex-direction: column; gap: 3px; }
      .dshlm-report { display: flex; flex-direction: column; gap: 6px; }
      .dshlm-footer { padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 0.84em; }
      @media (max-width: 760px) {
        .dshlm-layout { grid-template-columns: minmax(0, 1fr); }
        .dshlm-list { max-height: none; }
        .dshlm-project { max-height: none; }
      }
    `;

    /* ------------------------------------------------------------------ */
    /* Client plugin entry                                                 */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {zh: DICTIONARIES.zh, en: DICTIONARIES.en}), 'local-memory: locale dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'local-memory',
          order: 10,
          label: () => t('nav.label'),
          locale: NS,
          inject: () => ({translate: t, call: postOperation}),
        }, MemoryCenter));
      },
    };
  },
});
