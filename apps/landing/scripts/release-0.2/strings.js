// Every word in the 0.2.0 release film, in both languages. Where the film draws an app surface the words are the
// messenger's own (copy/project.ts for the project session, its sheet, cards and composer; copy/sidebar.ts
// statusRunning; copy/taskmap.ts); the command rows are what Claude Code and Codex list for themselves (Codex's
// three from apps/daemon/src/agents/codex-commands.ts), so they stay in English in both films; the headlines
// carry the release notes' section titles.
export const STR = {
  zh: {
    word: 'Deskfolk', from: '0.1.0', version: '0.2.0', count: '49 项更新',
    mac: 'macOS · 已签名、已公证', win: 'Windows · 预览版',
    h: {
      proj: '项目会话：Claude Code 进到你的项目里',
      plan: '计划模式：先出计划，你批准再动手',
      cmds: '打 / 出命令，Codex 也能来干活',
      map: '任务地图：干活的过程画成小镇',
      more: '还有这些'
    },
    sub: {
      proj: '在电脑上的文件夹里直接对话，改文件前按你的权限来问你',
      plan: '批准之前只看不改，Shift+Tab 一键切换',
      cmds: 'Claude Code、Codex 的命令和你的 skill，打 / 就列出来',
      map: '一个目录一栋楼，谁在哪做什么一眼看到，天色跟着时间走'
    },
    // the window: a Bot above, the 项目 section with a folder and its sessions
    botName: '制片', botPrev: '海报定稿了',
    section: '项目', dir: 'shop', dirPath: '~/shop',
    newCC: '新开 Claude Code 会话', newCX: '新开 Codex 会话', importSession: '导入终端会话…',
    untitled: '新会话', cxTitle: '修一下支付回调',
    agentCC: 'Claude Code', agentCX: 'Codex',
    phCC: '和 Claude Code 说点什么…', phCX: '和 Codex 说点什么…', phPlan: '说要做什么，Claude Code 先出一份计划给你批准…',
    plan: '计划', tune: ['默认模型', '默认思考'], map: '地图',
    // 4–10: a session in the folder, and its first change asked of you
    line1: '登录页加一个「记住我」',
    thinking: '思考中', waiting: 'Claude Code 在等你批准', waitingPlan: 'Claude Code 在等你批准计划', waitingCX: 'Codex 在等你批准',
    approvalHead: '这一步要先问你', allow: '允许', deny: '拒绝',
    approvalBody: 'file-write /Users/me/shop/src/pages/Login.tsx',
    reply1: '加好了：登录页多了「记住我」，勾上后 30 天内不用再登录。',
    reply1File: 'Login.tsx',
    // 10–14: plan mode
    keys: ['Shift', 'Tab'],
    line2: '登录改成手机号加验证码',
    planHead: '计划等你批准',
    planRows: [['新增 ', 'src/api/sms.ts', '：发验证码'], ['登录页改成手机号 + 验证码', '', ''], ['补测试 ', 'tests/login.test.ts', '']],
    planApprove: '批准，开始做', planKeep: '接着改', planHint: '要改哪里，直接在下面说。',
    // 14–19: the / list, Claude Code's then Codex's
    cmdsCC: [['compact', '', 'Clear conversation history but keep a summary in context'], ['init', '', 'Initialize a new CLAUDE.md file with codebase documentation'],
      ['review', '', 'Review a pull request'], ['security-review', '', 'Complete a security review of the pending changes'], ['deploy-preview', '', 'Deploy this branch to a preview URL']],
    cmdsCX: [['compact', '', 'summarize conversation to prevent hitting the context limit'], ['review', '[instructions]', 'review my current changes and find issues'],
      ['new', '', 'start a new chat during a conversation'], ['deploy-preview', '', 'Deploy this branch to a preview URL']],
    cmdKeys: ['选择', '补全', '执行', '关闭'],
    // /review under ask first: one card before the review (apps/daemon/src/project-runner-codex.ts)
    reviewBody: 'review 未提交的改动\n审查时 Codex 自己跑只看不改的命令（只读沙盒），不再逐条问你',
    // 19–24: the task map (the town itself is the app's render, map/story.js)
    mapTitle: '这件事 · 新品海报和预告', live: '实时',
    // 24–26.5: and more (the release notes' other sections)
    more: ['项目会话能发图片', '打开的文件带着项目文件树', '账号、模型、思考等级一个选择器',
      '手机上 Bot 和项目分成两页', '手机上浏览电脑上的文件夹', '当前窗格浮起来，其余退后'],
    // the end card
    tagline: '交出去，离开，回来看结果。',
    cta: '下载 0.2.0', url: 'blackman99.github.io/deskfolk',
    fine: 'macOS 已签名、公证 · Windows 预览版 · MIT 开源 · 用你自己的模型端点和 agent',
    finer: '界面按真实功能重绘；任务地图是应用自己的渲染'
  },
  en: {
    word: 'Deskfolk', from: '0.1.0', version: '0.2.0', count: '49 changes',
    mac: 'macOS · signed and notarized', win: 'Windows · preview',
    h: {
      proj: 'Project sessions: Claude Code in your project',
      plan: 'Plan mode: a plan before any change',
      cmds: 'Type / for commands; Codex works here too',
      map: 'Task maps: the work, drawn as a town',
      more: 'And more'
    },
    sub: {
      proj: 'Talk to it in a folder on your computer; it asks before a change, as your permission mode says',
      plan: 'It only looks until you approve; Shift+Tab switches it',
      cmds: "Claude Code's and Codex's commands and your skills, listed as you type /",
      map: 'A building per folder, who is where doing what, under the hour’s sky'
    },
    botName: 'Producer', botPrev: 'The poster is final',
    section: 'Projects', dir: 'shop', dirPath: '~/shop',
    newCC: 'New Claude Code session', newCX: 'New Codex session', importSession: 'Import a terminal session…',
    untitled: 'New session', cxTitle: 'Fix the payment callback',
    agentCC: 'Claude Code', agentCX: 'Codex',
    phCC: 'Say something to Claude Code…', phCX: 'Say something to Codex…', phPlan: 'Say what to do; Claude Code writes a plan for you to approve first…',
    plan: 'Plan', tune: ['Default model', 'Default thinking'], map: 'Map',
    line1: 'Add “Remember me” to the login page',
    thinking: 'Thinking', waiting: 'Claude Code is waiting for your approval', waitingPlan: 'Claude Code is waiting for you to approve its plan', waitingCX: 'Codex is waiting for your approval',
    approvalHead: 'Asks you first', allow: 'Allow', deny: 'Deny',
    approvalBody: 'file-write /Users/me/shop/src/pages/Login.tsx',
    reply1: 'Done: the login page has “Remember me”; ticked, it keeps you signed in for 30 days.',
    reply1File: 'Login.tsx',
    keys: ['Shift', 'Tab'],
    line2: 'Sign in with a phone number and a code instead',
    planHead: 'A plan for you to approve',
    planRows: [['Add ', 'src/api/sms.ts', ' to send the code'], ['The login page takes a phone number + code', '', ''], ['Tests in ', 'tests/login.test.ts', '']],
    planApprove: 'Approve and start', planKeep: 'Keep planning', planHint: 'To change something, say it below.',
    cmdsCC: [['compact', '', 'Clear conversation history but keep a summary in context'], ['init', '', 'Initialize a new CLAUDE.md file with codebase documentation'],
      ['review', '', 'Review a pull request'], ['security-review', '', 'Complete a security review of the pending changes'], ['deploy-preview', '', 'Deploy this branch to a preview URL']],
    cmdsCX: [['compact', '', 'summarize conversation to prevent hitting the context limit'], ['review', '[instructions]', 'review my current changes and find issues'],
      ['new', '', 'start a new chat during a conversation'], ['deploy-preview', '', 'Deploy this branch to a preview URL']],
    cmdKeys: ['Move', 'Fill in', 'Run', 'Close'],
    reviewBody: 'review the uncommitted changes\nWhile it reviews, Codex runs its own commands in a read-only sandbox, without asking for each',
    mapTitle: 'This job · A launch poster and teaser', live: 'Live',
    more: ['Pictures in project sessions', 'Files open with the project’s tree', 'Account, model and thinking in one picker',
      'On a phone: Bots and Projects, two pages', 'Browse the computer’s folders from a phone', 'The current pane stands forward'],
    tagline: 'Hand it off. Walk away. Return to results.',
    cta: 'Download 0.2.0', url: 'blackman99.github.io/deskfolk',
    fine: 'macOS signed and notarized · Windows preview · MIT open source · your own model endpoints and agents',
    finer: 'Screens redrawn from the real app; the task map is the app’s own render'
  }
};
