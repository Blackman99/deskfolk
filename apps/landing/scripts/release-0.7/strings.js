// Every word in the 0.7.0 release film and its covers, in both languages. Where the film draws an app surface the
// words are the native app's own (apps/desktop-nsh/app/src, its copy in app/src/m/copy):
// - Git & GitHub pane from copy/git.ts (tabs, dirtyBadge, ahead, projectDirBadge, worktrees.currentBadge,
//   changes.baseWorking, changes.splitView, github.relatedBranchHead, github.branchPrTag, github.stateOpen,
//   github.reviewApproved, github.checksSummary, github.closingIssueTag, github.quoteToComposer)
// - Consultants & context usage from copy/project.ts (consult, consultSwitch, consultAdd, consultedOpened,
//   plan, planMode, planModeDetail, contextLabel, contextHint, contextUsed, contextWindow, contextLeft, contextModel,
//   live, composerPlaceholder)
// - Phone + sheet from copy/composer.ts (more), copy/screen.ts (title, direct, smooth, displayMain, displayNumbered,
//   displayAll, displayAllDetail, displayWhere, displayTitle)
// - Sidebar from copy/sidebar.ts (search, botsTab, liveSection, workspace, tools, settings, statusIdle)
// - Usage from copy/usage.ts
// Every platform word lives in `platforms` (one entry per language).
export const STR = {
  zh: {
    word: 'Deskfolk', from: '0.6.0', version: '0.7.0', count: '24 项更新',
    platforms: {
      chips: [
        { icon: 'check', text: 'macOS', tail: '已签名、已公证' },
        { icon: 'check', text: 'Windows' },
        { icon: 'check', text: 'Linux', tail: '预览版' }
      ],
      fine: '需要 macOS 14 或更新 · macOS 已签名、已公证 · Windows 与 Linux 安装包未签名',
      cover: 'macOS · Windows · Linux（预览） · macOS 已签名、已公证 · MIT 开源',
      coverHead: '项目会话迎来 Git 窗格、参谋协作与手机端全面升级',
      coverChips: ['Git 与 GitHub 窗格', '请其他 Agent 当参谋']
    },
    h: {
      git: '项目会话里直接看 Git 和 GitHub',
      consult: '项目会话里，能请其他 Agent 当参谋',
      phone: '手机端更顺手：上下文、＋面板、单屏远控',
      desk: '侧栏「进行中」置顶，状态与额度一眼看清',
      more: '还有这些'
    },
    sub: {
      git: '工作树原地切换、原生 Diff、提交历史图、关联 PR 与 CI 检查，都在同一个窗格',
      consult: '只看不改，最多选 3 位不同 Agent、账号或模型一起把关',
      phone: '顶栏点开上下文占用；输入框收进「＋」；多显示器 Mac 一次看一块',
      desk: '活跃会话不跳动，草稿自动保存；Antigravity 显示订阅级别与花费估算'
    },
    bots: [
      { name: '剪辑', prev: '字幕对好了', time: '10:58' },
      { name: '文案', prev: '标题写了三版', time: '10:41' },
      { name: '美术', prev: '海报换成暖色了', time: '10:20' },
      { name: '采购', prev: '报价单发你了', time: '09:52' }
    ],
    search: '搜索', botsTab: 'Bot', liveSection: '进行中', section: '项目', workspace: '工作区', tools: '工具', settings: '设置',
    stThinking: '思考中', stIdle: '空闲',
    // 4–10: Git & GitHub pane (copy/git.ts)
    git: {
      tabTitle: 'Git · deskfolk',
      chatTitle: '实现 Git 窗格',
      repo: 'deskfolk',
      branch: 'feat/git-pane',
      dirty: '4', ahead: '2',
      tabs: ['改动', '历史', 'GitHub'],
      base: '未提交改动', split: '分栏对比', readOnly: '只读视图',
      pickerTitle: '选择仓库与工作树',
      reposCount: '1 个仓库',
      wts: [
        { branch: 'main', path: '~/deskfolk', badge: '项目目录', meta: '工作树干净', cur: false },
        { branch: 'feat/git-pane', path: '.worktrees/git-pane', badge: '当前', meta: '4 处改动 · 领先 2', cur: true, session: '实现 Git 窗格' }
      ],
      files: [
        { name: 'GitPane.tsx', dir: 'ui/git', add: '+142', del: '-18', on: true },
        { name: 'GitContextPopover.tsx', dir: 'ui/git', add: '+86', del: '-4' },
        { name: 'GitGraphView.tsx', dir: 'ui/git', add: '+98', del: '-12' },
        { name: 'git.ts', dir: 'm/copy', add: '+54', del: '-0' }
      ],
      commits: [
        { sha: '59356b3', msg: 'feat(git): add project session Git & GitHub pane', who: 'you', when: '12 分钟前', refs: ['HEAD', 'feat/git-pane'], lane: 1, parent: 1 },
        { sha: 'a24ae57', msg: 'ci: add Linux desktop unit tests and push safeguards', who: 'you', when: '2 小时前', refs: [], lane: 1, parent: 0 },
        { sha: '94bf170', msg: 'fix(desktop-nsh): a PDF opens on the phone', who: 'you', when: '昨天', refs: ['main'], lane: 0, parent: 0 },
        { sha: 'b1fa2ed', msg: 'feat(desktop-nsh): sidebar live strip & compact rows', who: 'you', when: '昨天', refs: [], lane: 0, parent: 0 },
        { sha: '8a66c6a', msg: 'chore: release 0.6.0', who: 'you', when: '4 天前', refs: ['v0.6.0'], lane: 0, parent: 0 }
      ],
      graphDetail: { title: 'feat(git): add project session Git & GitHub pane', files: '改动了 4 个文件', copySha: '复制 SHA' },
      gh: {
        relatedHead: '当前分支关联',
        branchPrTag: '当前分支 PR',
        prTitle: '#128 项目会话新增 Git 与 GitHub 窗格',
        stateOpen: '打开',
        reviewApproved: '评审通过',
        checks: '检查通过 6/6',
        closing: '将关闭 #114',
        quote: '引用到输入框',
        openGh: '在 GitHub 打开',
        body: '为每个项目目录提供共用的只读 Git 窗格，支持仓库/工作树原地切换、原生 Diff、Canvas 提交图与经本机 gh 查询关联 PR。'
      }
    },
    // 10–14: Consultants in project sessions (copy/project.ts)
    consult: {
      dir: 'deskfolk', title: '重构多工作树缓存', live: '在工作', plan: '计划', pill: '参谋',
      switchLabel: '每句话先请参谋', addLabel: '添加参谋…',
      members: [
        { agent: 'Codex', model: 'gpt-5.4', level: '高', account: '工作账号' },
        { agent: 'Grok', model: 'grok-4', level: '中', account: '默认账号' }
      ],
      you: '评审这个多工作树缓存方案，重点看锁竞争与失效边界',
      youT: '14:12',
      consultedHead: '请教了',
      running: '运行中',
      chips: [
        { model: 'gpt-5.4', desc: '检查工作树状态缓存并发与 TTL 边界' },
        { model: 'grok-4', desc: '核对跨目录切换时的失效清理路径' }
      ],
      reply: '两位参谋一致建议按 (repo, worktree) 隔离缓存并限制懒加载并发为 2；Codex 还指出失效 worktree 要在切回默认时清掉旧键。已按建议收口方案。',
      placeholder: '说点什么，Claude Code 先请参谋看一眼…'
    },
    // 14–19: Phone upgrades (copy/project.ts, copy/composer.ts, copy/screen.ts)
    phone: {
      clock: '11:02',
      title: '重构多工作树缓存',
      sub: 'Claude Code · ~/deskfolk',
      pct: '62%',
      you: '把缓存失效的边界补齐测试',
      youT: '10:58',
      reply: '补了 6 条单元测试覆盖 worktree 切换与 15 秒 TTL，全部通过。',
      replyT: '11:00',
      placeholder: '和 Claude Code 说点什么…',
      ctxTitle: '上下文占用',
      ctxRows: [['已用', '124k tokens'], ['上下文窗口', '200k tokens'], ['剩余', '76k tokens'], ['模型', 'claude-sonnet-4-6']],
      moreTitle: '更多',
      attach: '添加文件',
      planMode: '计划模式',
      planDetail: '先写计划，你批准之前 Claude Code 只看不改',
      consultLabel: '参谋',
      consultDetail: 'gpt-5.4 · grok-4',
      modelLabel: '模型',
      modelDetail: 'claude-sonnet-4-6 · 高',
      planChip: '计划',
      screenTitle: 'Mac 屏幕',
      direct: '直连',
      smooth: '流畅',
      displayMain: '主屏',
      displayTitle: '显示哪块屏幕',
      displays: [
        { name: '主屏', sub: '1728 × 1117', cur: true },
        { name: '屏幕 2', sub: '在主屏右侧 · 2560 × 1440', cur: false },
        { name: '全部屏幕', sub: '拼在一起显示，每块都会变小', cur: false }
      ],
      screenLabel2: '屏幕 2'
    },
    // 19–24: Sidebar LiveStrip, desktop context ring, draft & Antigravity Usage
    desk: {
      projTitle: '排查用量探针',
      projSub: 'Antigravity · ~/deskfolk',
      usageTab: '用量',
      draftText: '顺便把 Gemini 4 的多模型编排器单价也核对一下',
      ctxPct: '68%',
      ctxTip: '上下文占用：136k / 200k tokens（68%）',
      you: '用量页里补上 Antigravity 的订阅级别',
      reply: '已接通 agy acp 只读查询，用量页和挂件现在会显示订阅档位，不花额度、不新建会话。',
      agyTitle: 'Antigravity',
      agyTier: 'Google AI Ultra',
      agyAuto: '额度用完后到点自动接着做',
      windows: [
        { name: 'Gemini Models', pct: 34, reset: '4 小时后重置' },
        { name: 'Claude and GPT models', pct: 58, reset: '2 小时后重置' }
      ],
      spendNote: '已估算 Gemini 4 与 Claude 5.5 花费'
    },
    more: [
      '手机上点开 PDF 才下载，也能直接打开了',
      'Antigravity 额度用完，到点自动接着做',
      '花费支持估算 Gemini 4 与 Claude 5.5',
      '说一句「停下」，Bot 的日程照常跑',
      '输入框草稿按会话自动保存',
      '桌面与手机多处界面细节打磨'
    ],
    cover: { chips: ['上下文占用与手机「＋」面板', '多显示器远程单屏切换'] },
    tagline: '交出去，离开，回来看结果。',
    cta: '下载 0.7.0', url: 'blackman99.github.io/deskfolk',
    fineRest: 'MIT 开源 · 用你自己的模型端点和 agent',
    finer: '界面按真实功能重绘'
  },
  en: {
    word: 'Deskfolk', from: '0.6.0', version: '0.7.0', count: '24 updates',
    platforms: {
      chips: [
        { icon: 'check', text: 'macOS', tail: 'signed and notarized' },
        { icon: 'check', text: 'Windows' },
        { icon: 'check', text: 'Linux', tail: 'preview' }
      ],
      fine: 'macOS 14 or later, signed and notarized · Windows and Linux packages unsigned',
      cover: 'macOS · Windows · Linux (preview) · signed and notarized on macOS · MIT',
      coverHead: 'Git & GitHub pane, consultants, and a sharper phone app',
      coverChips: ['Git & GitHub pane', 'Consultants in project sessions']
    },
    h: {
      git: 'A Git & GitHub pane in project sessions',
      consult: 'Bring other agents in as consultants',
      phone: 'Sharper on the phone: context, +, one display',
      desk: 'Active strip on top, context & usage at a glance',
      more: 'And more'
    },
    sub: {
      git: 'Switch worktrees in place, read native diffs, trace the commit graph, check PRs and CI',
      consult: 'Read-only second opinions — pick up to 3 agents, accounts or models right in the composer',
      phone: 'Tap the header for context figures, fold controls into +, view one Mac display at a time',
      desk: 'Live sessions stay anchored, drafts persist, and Antigravity shows its tier & estimates spend'
    },
    bots: [
      { name: 'Script', prev: 'Subtitles are lined up', time: '10:58' },
      { name: 'Schedule', prev: 'Three title drafts', time: '10:41' },
      { name: 'Illustrator', prev: 'Warmer poster colours', time: '10:20' },
      { name: 'Clerk', prev: 'Sent you the quote', time: '09:52' }
    ],
    search: 'Search', botsTab: 'Bots', liveSection: 'Active', section: 'Projects', workspace: 'Workspace', tools: 'Tools', settings: 'Settings',
    stThinking: 'Thinking', stIdle: 'Idle',
    git: {
      tabTitle: 'Git · deskfolk',
      chatTitle: 'Build Git pane',
      repo: 'deskfolk',
      branch: 'feat/git-pane',
      dirty: '4', ahead: '2',
      tabs: ['Changes', 'History', 'GitHub'],
      base: 'Uncommitted', split: 'Split', readOnly: 'Read-only',
      pickerTitle: 'Choose repository & worktree',
      reposCount: '1 repo',
      wts: [
        { branch: 'main', path: '~/deskfolk', badge: 'Project dir', meta: 'Working tree clean', cur: false },
        { branch: 'feat/git-pane', path: '.worktrees/git-pane', badge: 'Current', meta: '4 changes · 2 ahead', cur: true, session: 'Build Git pane' }
      ],
      files: [
        { name: 'GitPane.tsx', dir: 'ui/git', add: '+142', del: '-18', on: true },
        { name: 'GitContextPopover.tsx', dir: 'ui/git', add: '+86', del: '-4' },
        { name: 'GitGraphView.tsx', dir: 'ui/git', add: '+98', del: '-12' },
        { name: 'git.ts', dir: 'm/copy', add: '+54', del: '-0' }
      ],
      commits: [
        { sha: '59356b3', msg: 'feat(git): add project session Git & GitHub pane', who: 'you', when: '12m ago', refs: ['HEAD', 'feat/git-pane'], lane: 1, parent: 1 },
        { sha: 'a24ae57', msg: 'ci: add Linux desktop unit tests and push safeguards', who: 'you', when: '2h ago', refs: [], lane: 1, parent: 0 },
        { sha: '94bf170', msg: 'fix(desktop-nsh): a PDF opens on the phone', who: 'you', when: 'Yesterday', refs: ['main'], lane: 0, parent: 0 },
        { sha: 'b1fa2ed', msg: 'feat(desktop-nsh): sidebar live strip & compact rows', who: 'you', when: 'Yesterday', refs: [], lane: 0, parent: 0 },
        { sha: '8a66c6a', msg: 'chore: release 0.6.0', who: 'you', when: '4d ago', refs: ['v0.6.0'], lane: 0, parent: 0 }
      ],
      graphDetail: { title: 'feat(git): add project session Git & GitHub pane', files: '4 files changed', copySha: 'Copy SHA' },
      gh: {
        relatedHead: 'Linked to branch',
        branchPrTag: 'Current branch PR',
        prTitle: '#128 Project session Git & GitHub pane',
        stateOpen: 'Open',
        reviewApproved: 'Approved',
        checks: 'Checks passed 6/6',
        closing: 'Closes #114',
        quote: 'Quote to composer',
        openGh: 'Open on GitHub',
        body: 'Shared read-only Git pane per project folder with repo/worktree switcher, native DiffView, Canvas commit graph, and local gh PR/Issue views.'
      }
    },
    consult: {
      dir: 'deskfolk', title: 'Worktree cache plan', live: 'Working', plan: 'Plan', pill: 'Consult',
      switchLabel: 'Ask them on every line', addLabel: 'Add a consultant…',
      members: [
        { agent: 'Codex', model: 'gpt-5.4', level: 'High', account: 'Work' },
        { agent: 'Grok', model: 'grok-4', level: 'Medium', account: 'Default account' }
      ],
      you: 'Review this multi-worktree cache plan — focus on races and stale eviction',
      youT: '14:12',
      consultedHead: 'Consulted',
      running: 'Running',
      chips: [
        { model: 'gpt-5.4', desc: 'Check worktree status concurrency and TTL edges' },
        { model: 'grok-4', desc: 'Verify stale-key eviction across repo switches' }
      ],
      reply: 'Both consultants recommend scoping cache keys by (repo, worktree) with concurrency capped at 2; Codex also flagged clearing stale keys on fallback. Updated the plan.',
      placeholder: 'Say something; Claude Code asks the consultants first…'
    },
    phone: {
      clock: '11:02',
      title: 'Worktree cache plan',
      sub: 'Claude Code · ~/deskfolk',
      pct: '62%',
      you: 'Add unit tests for stale eviction',
      youT: '10:58',
      reply: 'Added 6 tests covering worktree switches and the 15s TTL — all passing.',
      replyT: '11:00',
      placeholder: 'Say something to Claude Code…',
      ctxTitle: 'Context usage',
      ctxRows: [['Used', '124k tokens'], ['Context window', '200k tokens'], ['Left', '76k tokens'], ['Model', 'claude-sonnet-4-6']],
      moreTitle: 'More',
      attach: 'Attach file',
      planMode: 'Plan mode',
      planDetail: 'Claude Code writes a plan and changes nothing until you approve it',
      consultLabel: 'Consult',
      consultDetail: 'gpt-5.4 · grok-4',
      modelLabel: 'Model',
      modelDetail: 'claude-sonnet-4-6 · High',
      planChip: 'Plan',
      screenTitle: 'Mac screen',
      direct: 'Direct',
      smooth: 'Smooth',
      displayMain: 'Main screen',
      displayTitle: 'Which screen to show',
      displays: [
        { name: 'Main screen', sub: '1728 × 1117', cur: true },
        { name: 'Screen 2', sub: 'to the right of the main screen · 2560 × 1440', cur: false },
        { name: 'All screens', sub: 'Side by side, each one smaller', cur: false }
      ],
      screenLabel2: 'Screen 2'
    },
    desk: {
      projTitle: 'Usage tier probe',
      projSub: 'Antigravity · ~/deskfolk',
      usageTab: 'Usage',
      draftText: 'Also verify Gemini 4 orchestrator spend estimates',
      ctxPct: '68%',
      ctxTip: 'Context usage: 136k / 200k tokens (68%)',
      you: 'Surface Antigravity subscription tier in Usage',
      reply: 'Added read-only agy acp tier probe — Usage and the widget now display the plan tier without spending quota.',
      agyTitle: 'Antigravity',
      agyTier: 'Google AI Ultra',
      agyAuto: 'Picks up automatically when quota resets',
      windows: [
        { name: 'Gemini Models', pct: 34, reset: 'Resets in 4h' },
        { name: 'Claude and GPT models', pct: 58, reset: 'Resets in 2h' }
      ],
      spendNote: 'Spend estimates Gemini 4 & Claude 5.5'
    },
    more: [
      'Phone PDFs open and load on demand',
      'Antigravity picks up when quota resets',
      'Spend estimates Gemini 4 & Claude 5.5',
      'Stopping a Bot no longer pauses routines',
      'Composer drafts persist per conversation',
      'UI polish across desktop and mobile'
    ],
    cover: { chips: ['Context usage & phone + sheet', 'One display at a time on phone'] },
    tagline: 'Hand it off. Walk away. Return to results.',
    cta: 'Download 0.7.0', url: 'blackman99.github.io/deskfolk',
    fineRest: 'MIT open source · your own model endpoints and agents',
    finer: 'Screens redrawn from the real app'
  }
};
