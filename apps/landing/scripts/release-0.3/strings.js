// Every word in the 0.3.0 release film, in both languages. Where the film draws an app surface the words are the
// messenger's own: Roles from copy/routing.ts and copy/playbooks.ts (the engines' names, their lines, the steps,
// the hooks, 「已关」 and the switch's 开/关); the project session from copy/project.ts (plan*, tasksGoing, taskDoing,
// taskStatus, taskCalls, waitingPlan, openDir, openTerminal, newWith) and copy/chat.ts (activity.nowTitle); the
// sidebar from copy/sidebar.ts (botsTab, searchShort, status*, pin) and copy/project.ts (section). What the agents
// and the Bots say, the commands and the plan are made up for the film; the headlines carry the release notes'
// section titles.
export const STR = {
  zh: {
    word: 'Deskfolk', from: '0.2.0', version: '0.3.0', count: '31 项更新',
    mac: 'macOS · 已签名、已公证', win: 'Windows · 预览版',
    h: {
      plain: '自由引擎：这套工作方式可以不用',
      full: '项目会话的计划能全屏看',
      bg: '项目会话能跑后台命令、监视和子代理',
      side: '侧栏只分「Bot」和「项目」两段',
      more: '还有这些'
    },
    sub: {
      plain: '你的话不开事，Bot 直接干，做完算不算数由你看',
      full: '铺满窗口、宽度刚好读，批准和接着改还在下面',
      bg: '干活气泡打开就是正在跑的；子代理点开，看它接到的任务',
      side: '项目会话的行和 Bot 的一样大，悬停就能置顶，+ 里能开目录和终端'
    },
    // 4–10: Roles (copy/routing.ts, copy/playbooks.ts)
    rolesTab: '分工', engines: '引擎',
    engineNames: ['通用', '视频', '代码', '自由'],
    engineLines: [
      '默认。不要书记员和反思：不在你背后记要求、出提议；交付之后照样复盘。',
      '做片子：留着书记员，整理等静下来一分钟，回看间隔长一些，不升级模型，交了 5 次没过就问你。',
      '写代码：不要书记员，其余照默认。',
      '不用这套工作方式：不开规划和任务，不审交付，没人追进度，做完算不算数由你看。应用只管你的批准、叫停和花费。'
    ],
    intro: '应用自己的环节按什么时候跑排成一张图。选一个，看它在这个引擎里跑不跑、带什么数；会调模型的，还能设模型、改提示词。',
    hooks: { line: '你的一句话', group: '群里没点名的一句', turn: 'Bot 的一轮', handed_in: '交上来', accepted: '你接受交付', overturned: '你推翻放行', compose: '你按 ✨' },
    steps: {
      intake: '排队', reader: '读句', jobs: '一件件事', scribe: '书记员', derived_checks: '按你的话加的检查', large_job: '大活先拆',
      judgement: '判断下场', pacing: '跳数节奏', compaction: '压缩上下文', closing: '收尾自检', settle: '整理器', check_backs: 'Bot 自己约的回看',
      pickup: '监督器接手', checks: '验收检查与看图判定', wait_word: '等你放行', escalation: '模型升级', ceiling: '能力天花板',
      retrospective: '完工复盘', reflection: '反思', composer: '输入建议'
    },
    jobsHint: '把你的话归到一件事，开规划和任务、放进工作目录，交付、审查和监督器都跟着它走。关掉就是不用这一套：你的话不开事，Bot 直接干，做完算不算数由你看。',
    turnModel: 'Bot 自己的模型', follows: '跟默认模型', offShort: '已关', on: '开', off: '关', runs: '这个引擎里跑',
    unit: { s: '秒', min: '分钟', hops: '跳', count: '' },
    // 10–19: the window — the sidebar (copy/sidebar.ts, copy/project.ts) and a Claude Code session
    botsTab: 'Bot', section: '项目', search: '搜索',
    botName: '制片', botPrev: '海报定稿了', bot2Name: '剪辑', bot2Prev: '预告剪好了，你看看',
    dir: 'shop', dirPath: '~/shop',
    ccTitle: '登录改成手机号加验证码', cxTitle: '修一下支付回调', cxPrev: '回调的签名校验加上了',
    agentCC: 'Claude Code', agentCX: 'Codex', map: '地图',
    stApproval: '待审批', stRunning: '思考中', stBackground: '后台任务运行中',
    phCC: '和 Claude Code 说点什么…', phPlan: '说要做什么，Claude Code 先出一份计划给你批准…',
    plan: '计划', tune: ['默认模型', '默认思考'],
    // 10–14: the plan, full screen
    waitingPlan: 'Claude Code 在等你批准计划',
    planHead: '计划等你批准', planApprove: '批准，开始做', planKeep: '接着改',
    planHint: '要改哪里，直接在下面说。', planHintFull: '要改哪里，退出全屏后在输入框里说。',
    planFullscreen: '全屏查看', planExitFullscreen: '退出全屏（Esc）',
    planTitle: '手机号验证码登录',
    planIntro: '登录页从账号密码改成手机号加短信验证码，「记住我」照旧。',
    planRows: [['新增 ', 'src/api/sms.ts', '：发验证码，60 秒内不重发'], ['登录页改成手机号、验证码两栏，去掉密码框', '', ''],
      ['', 'src/auth/session.ts', ' 用验证码换登录态'], ['「记住我」照旧：勾上 30 天内不用再登录', '', ''],
      ['补测试 ', 'tests/login.test.ts', '：发码、错码、过期'], ['跑一遍 ', 'pnpm test', '，全过再交给你']],
    planDone: '不动支付和注册流程。',
    // 14–19: background commands, a Monitor and a subagent
    line3: '把 dev server 跑起来盯着报错，再派人查登录测试',
    reply3: 'dev server 在后台跑着（localhost:5173），我用 Monitor 盯着报错；登录测试交给了一个子代理。',
    subName: '查登录测试', running: '运行中', thinking: '思考中',
    tasksGoing: '3 个后台任务运行中', nowTitle: 'Claude Code 正在做的 3 件事',
    taskRows: [['后台运行', 'pnpm dev'], ['监视', 'tail -f dev.log | grep -i error'], ['子代理', '查登录测试']],
    devOut: ['VITE v6.3.5  ready in 412 ms', '➜  Local:   http://localhost:5173/', '10:44:02 [vite] page reload src/pages/Login.tsx', '10:44:09 [vite] hmr update /src/pages/Login.tsx'],
    subFacts: 'general-purpose · 3 次工具调用',
    subAsked: '跑一遍 tests/login.test.ts 里手机号登录的用例，看是不是都过。没过的找出原因，先别改代码，把要改的地方告诉我。',
    subSay: '先跑一遍登录的测试，再对照 src/api/sms.ts 看发码的逻辑。',
    subCalls: '3 次工具调用', subOn: 'pnpm vitest run tests/login.test.ts',
    span: s => `${s} 秒`, spanM: (m, s) => `${m} 分 ${s} 秒`,
    // 19–24: the sidebar's two sections; a session pinned; the folder's +
    pin: '置顶', ccPrev: '加好了，登录页换成了验证码',
    newCC: '新开 Claude Code 会话', newCX: '新开 Codex 会话', openDir: '打开项目目录', openTerminal: '在项目目录打开终端',
    // 24–26.5: and more (the release notes' other sections)
    more: ['GBK 文本按中文显示', '很大的文件打开不再卡死', '手机上一次发多张图', '项目会话的花费进了花费页',
      '第一次启动就能接着终端里的会话', '新 App 图标，两张脸都露出来'],
    // the end card
    tagline: '交出去，离开，回来看结果。',
    cta: '下载 0.3.0', url: 'blackman99.github.io/deskfolk',
    fine: 'macOS 已签名、公证 · Windows 预览版 · MIT 开源 · 用你自己的模型端点和 agent',
    finer: '界面按真实功能重绘'
  },
  en: {
    word: 'Deskfolk', from: '0.2.0', version: '0.3.0', count: '31 updates',
    mac: 'macOS · signed and notarized', win: 'Windows · preview',
    h: {
      plain: 'Plain: do without the way of working',
      full: 'A plan can take the whole window',
      bg: 'Background commands, monitors, subagents',
      side: 'The sidebar: Bots and Projects',
      more: 'And more'
    },
    sub: {
      plain: 'Your lines open no job; Bots just work, and whether it is done is yours to judge',
      full: 'At a reading width, with Approve and Keep planning still under it',
      bg: 'The working bubble opens onto what is running; a subagent shows what it was asked',
      side: 'Session rows as tall as a Bot’s, pinned from the row, a terminal from the folder’s +'
    },
    rolesTab: 'Roles', engines: 'Engine',
    engineNames: ['General', 'Video', 'Coding', 'Plain'],
    engineLines: [
      'The default. No scribe or reflection: nothing written down or proposed behind your back; Bots still look back after a delivery.',
      'For films: keeps the scribe, settles a minute after the work goes quiet, spaces check-backs out, does not step the model up, and asks you after five failed hand-overs.',
      'For code: no scribe; the rest at the defaults.',
      'Not this way of working: no plans or tickets, no reviewed hand-overs, nobody chasing the work, and whether it is done is yours to judge. The app keeps only your approvals, stops and spend.'
    ],
    intro: "The app's own steps, mapped by when they run. Pick one to see whether it runs in this engine and with what numbers; one that calls a model also has its model and prompts.",
    hooks: { line: 'A line of yours', group: 'A group line naming nobody', turn: "A Bot's turn", handed_in: 'A hand-in', accepted: 'You accept a delivery', overturned: 'You overturn an approval', compose: 'You press ✨' },
    steps: {
      intake: 'Intake', reader: 'Reading lines', jobs: 'Jobs', scribe: 'Scribe', derived_checks: 'Checks from your words', large_job: 'Large jobs laid out first',
      judgement: 'Joining in', pacing: 'Hop pacing', compaction: 'Context compaction', closing: 'Closing check', settle: 'Organizer', check_backs: "A Bot's own check-backs",
      pickup: 'Supervisor pick-ups', checks: 'Acceptance and picture checks', wait_word: 'Waiting on your word', escalation: 'Escalation', ceiling: 'Capability ceiling',
      retrospective: 'Retrospective', reflection: 'Reflection', composer: 'Composer suggestions'
    },
    jobsHint: 'Files your line under a job, opens plans and tickets in their work dirs; hand-overs, reviews and the supervisor all follow from it. Off is not using any of this: your lines open no job, Bots just work, and whether it is done is yours to judge.',
    turnModel: "The Bot's own model", follows: 'Follows the default model', offShort: 'Off', on: 'On', off: 'Off', runs: 'Runs in this engine',
    unit: { s: 's', min: 'min', hops: 'hops', count: '' },
    botsTab: 'Bots', section: 'Projects', search: 'Search',
    botName: 'Producer', botPrev: 'The poster is final', bot2Name: 'Editor', bot2Prev: 'The teaser is cut, have a look',
    dir: 'shop', dirPath: '~/shop',
    ccTitle: 'Sign in with a phone number and a code', cxTitle: 'Fix the payment callback', cxPrev: 'The callback checks its signature now',
    agentCC: 'Claude Code', agentCX: 'Codex', map: 'Map',
    stApproval: 'Approval', stRunning: 'Thinking', stBackground: 'Background tasks running',
    phCC: 'Say something to Claude Code…', phPlan: 'Say what to do; Claude Code writes a plan for you to approve first…',
    plan: 'Plan', tune: ['Default model', 'Default thinking'],
    waitingPlan: 'Claude Code is waiting for you to approve its plan',
    planHead: 'A plan for you to approve', planApprove: 'Approve and start', planKeep: 'Keep planning',
    planHint: 'To change something, say it below.', planHintFull: 'To change something, exit full screen and say it in the box.',
    planFullscreen: 'View full screen', planExitFullscreen: 'Exit full screen (Esc)',
    planTitle: 'Sign in with a phone code',
    planIntro: 'The login page moves from a password to a phone number and a text-message code; “Remember me” stays.',
    planRows: [['Add ', 'src/api/sms.ts', ' to send the code, at most once a minute'], ['The login page takes a phone number and a code; no password box', '', ''],
      ['', 'src/auth/session.ts', ' trades the code for a session'], ['“Remember me” as before: ticked, 30 days signed in', '', ''],
      ['Tests in ', 'tests/login.test.ts', ': sending, a wrong code, an expired one'], ['Run ', 'pnpm test', ' and hand it over once all pass']],
    planDone: 'Payments and sign-up stay as they are.',
    line3: 'Start the dev server, watch for errors, and have the login tests checked',
    reply3: 'The dev server is running in the background (localhost:5173) and a Monitor watches for errors; a subagent is checking the login tests.',
    subName: 'Check the login tests', running: 'Running', thinking: 'Thinking',
    tasksGoing: '3 background tasks running', nowTitle: 'Claude Code · 3 things going on',
    taskRows: [['In the background', 'pnpm dev'], ['Monitoring', 'tail -f dev.log | grep -i error'], ['Subagent', 'Check the login tests']],
    devOut: ['VITE v6.3.5  ready in 412 ms', '➜  Local:   http://localhost:5173/', '10:44:02 [vite] page reload src/pages/Login.tsx', '10:44:09 [vite] hmr update /src/pages/Login.tsx'],
    subFacts: 'general-purpose · 3 tool calls',
    subAsked: 'Run the phone sign-in cases in tests/login.test.ts and see whether they all pass. For any that fail, find out why; change no code yet, just tell me what needs changing.',
    subSay: 'First the login tests, then a look at how src/api/sms.ts sends the code.',
    subCalls: '3 tool calls', subOn: 'pnpm vitest run tests/login.test.ts',
    span: s => `${s}s`, spanM: (m, s) => `${m}m ${s}s`,
    pin: 'Pin', ccPrev: 'Done: the login page takes a code now',
    newCC: 'New Claude Code session', newCX: 'New Codex session', openDir: 'Open project folder', openTerminal: 'Open terminal in project folder',
    more: ['GBK text reads in Chinese', 'Very large files open without freezing', 'Several pictures from a phone at once', 'Project sessions’ spend in Spend',
      'Carry on a terminal session from the first launch', 'A new app icon with both faces'],
    tagline: 'Hand it off. Walk away. Return to results.',
    cta: 'Download 0.3.0', url: 'blackman99.github.io/deskfolk',
    fine: 'macOS signed and notarized · Windows preview · MIT open source · your own model endpoints and agents',
    finer: 'Screens redrawn from the real app'
  }
};
