// Every word in the 0.4.0 release film, in both languages. Where the film draws an app surface the words are the
// messenger's own: a Bot's direct from copy/chat.ts (replyPrompt, activity.verbs.call, activity.after, copyCode),
// copy/stream.ts (thinking, streaming), copy/sidebar.ts (status, botModelDefault, thinkingLevels), copy/top.ts (pin),
// copy/plan.ts (trace), copy/taskmap.ts (map) and copy/composer.ts (tuneEndpoint, tuneAutomaticHint); the interface
// change from copy/ui.ts (chip.changed, chip.undo, toast.changedBy) with the chip's middle as interfaceChanges()
// (packages/protocol/src/interface.ts) writes it, in English keys in both languages; Roles from copy/routing.ts and
// copy/playbooks.ts (the engines, hooks, steps, `own.*`); the picker's columns from copy/composer.ts and
// copy/project.ts (modelLabel, effortLabel); the custom endpoint's mark from copy/connectors.ts (customMark).
// What the Bots and you say, the code, the endpoint and model names are made up for the film; the headlines carry
// the release notes' section titles.
export const STR = {
  zh: {
    word: 'Deskfolk', from: '0.3.0', version: '0.4.0', count: '22 项更新',
    mac: 'macOS · 已签名、已公证', win: 'Windows · 预览版', linux: 'Linux · 预览版', isNew: '新',
    h: {
      look: '让 Bot 改应用的样子和用法',
      code: '代码配色可以自己选',
      steps: '引擎里能加你自己的环节',
      model: '在 Bot 私聊的输入框里换模型',
      more: '还有这些'
    },
    sub: {
      look: '强调色、内容区的毛玻璃，说一句就改；撤销就在回复下面',
      code: '浅色、深色各挑一个，连同底色；屏幕上已有的代码就地重画',
      steps: '挂在应用已有的时机上，按你的命令、规则或模型判',
      model: '和项目会话的一样一级一级展开：端点、模型、思考等级'
    },
    // the window: the sidebar (copy/sidebar.ts), the pane's tabs and header (copy/top.ts, plan.ts, taskmap.ts)
    botsTab: 'Bot', section: '项目', search: '搜索',
    botA: '布丁', botAPrev: '周报初稿放好了', botB: '制片', botBPrev: '海报定稿了', botC: '剪辑', botCPrev: '预告剪好了，你看看',
    dir: 'shop', ccTitle: '登录改成手机号加验证码', cxTitle: '修一下支付回调', cxPrev: '回调的签名校验加上了',
    pin: '置顶', trace: '流程', map: '地图',
    stThinking: '思考中', stReplying: '回复中',
    // a Bot's direct (copy/chat.ts replyPrompt + the Bot's name + "..."; copy/stream.ts; activity.verbs.call)
    placeholder: name => `发消息给 ${name}...`,
    thinking: '思考中', streaming: '正在写',
    calling: '调用 edit_interface', called: '思考中 · 调用了 edit_interface',
    auto: '自动',
    span: s => `${s} 秒`,
    // 4–10: you ask for a purple accent and frosted glass content
    earlier: '周报初稿放在 docs/weekly.md 了，数字我又核了一遍。',
    askLook: '强调色换成紫色，内容区要毛玻璃',
    replyLook: '改好了：强调色换成紫色，内容区透出窗口的毛玻璃。不喜欢就点下面的撤销。',
    chipLabel: '界面已改', chipUndo: '撤销',
    chipLook: 'light --accent: #6d4ae0', chipCode: 'code_theme: {"dark":"dracula"}',
    toast: name => `${name} 改了界面`,
    // 10–14: code colours, in the dark look
    greetA: '早上好，', greetB: '你好，',
    copyCode: '复制代码',
    askCode: '深色下代码用 Dracula',
    replyCode: '换好了，深色下的代码现在是 Dracula，连同它的底色。',
    // 14–19: Roles (copy/routing.ts, copy/playbooks.ts)
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
    closingHint: 'Bot 说「结论随后」或交文件时，对照这件事自己的检查看一眼，没兑现的退回给它。',
    turnModel: 'Bot 自己的模型', follows: '跟默认模型', offShort: '已关', on: '开', off: '关', runs: '这个引擎里跑',
    unit: { s: '秒', min: '分钟', hops: '跳', count: '' },
    own: {
      add: '加一个环节', templatesTitle: '起步模板', blank: '空白环节', mine: '你的', mineTitle: '你自己加的环节', draft: '还没存',
      tests: '收尾前跑测试', testsHint: '一轮收尾时：跑 pnpm test，不过就退回接着做。',
      rules: '照我的规矩看一遍', rulesHint: '一轮收尾时：让模型对照你写的规矩看回复，不守就退回。',
      name: '名字', nameHint: '最多 40 字', on: '开着',
      moment: '什么时候跑', momentValue: '一轮收尾时', momentHint: 'Bot 的一轮要收尾的时候，在收尾前。',
      looksAt: '看哪些', paths: '路径', pathsHint: '每行一个，相对工作区，可以带 * 和 **，例如 src/**/*.ts。 这一轮写过的文件。',
      judges: '怎么判', kinds: ['规则', '命令', '模型'], kindHint: '跑你写的命令，退出码 0 算过，其他算不过，输出的末尾当理由。',
      command: '命令', commandHint: '在工作区里跑，不带应用的环境变量。它拿到：stdin 一份 JSON；环境变量 DESKFOLK_EVENT（时机）、DESKFOLK_STEP（这个环节）、DESKFOLK_PATHS（路径，一行一个）、DESKFOLK_COMMAND（被检查的命令）、DESKFOLK_WORKSPACE（工作区）。退出码 0 算过。',
      folder: '在哪个文件夹跑', folderHint: '相对工作区；不写就是工作区本身。', timeout: '最多跑', timeoutNote: '秒 · 1 到 600 秒',
      thenTitle: '不过时', thenValue: '退回接着做', thenHint: '这一轮接着做，不收尾。和结束契约共用每段两次退回，用完就收尾并告诉你。',
      tryTitle: '拿样例试一次', tryHint: '不拦、不退回、不告诉任何人，也不记进流程。什么都不填就用最近的一个。', tryReply: '回复的文字', tryRun: '试一次',
      save: '保存', cancel: '不加了', del: '删除这个环节',
      said: '一轮收尾时 · 不过就退回'
    },
    // 19–24: the picker (copy/composer.ts, copy/project.ts, copy/sidebar.ts, copy/connectors.ts)
    earlierPick: '预告剪好了，放在 cuts/teaser-v3.mp4，你看看节奏。',
    colEndpoint: '端点', colModel: '模型', colThinking: '思考等级',
    autoHint: '每条消息由应用挑模型',
    endpoints: ['工作端点', '本机模型'],
    models: ['large-2', 'large-2-mini', 'fast-1', 'fast-1-mini', 'code-1'],
    levels: ['不思考', '低', '中', '高'],
    custom: 'Custom',
    // 24–26.5: and more (the release notes' other sections)
    more: ['Linux 预览版：AppImage 和 deb', '提示挪到右上角，带倒计时圈', '卡在天花板的任务可以「忽略，接着做」',
      '输入框里待发的图片能放大看', '项目列表不再跟着新会话换顺序', '官网首页成了六章能玩的特性'],
    // the end card
    tagline: '交出去，离开，回来看结果。',
    cta: '下载 0.4.0', url: 'blackman99.github.io/deskfolk',
    fine: 'macOS 已签名、公证 · Windows、Linux 预览版 · MIT 开源 · 用你自己的模型端点和 agent',
    finer: '界面按真实功能重绘'
  },
  en: {
    word: 'Deskfolk', from: '0.3.0', version: '0.4.0', count: '22 updates',
    mac: 'macOS · signed and notarized', win: 'Windows · preview', linux: 'Linux · preview', isNew: 'new',
    h: {
      look: 'Ask a Bot to change how the app looks',
      code: 'Code colours of your own',
      steps: 'Steps of your own in an engine',
      model: 'Change a Bot’s model from its direct',
      more: 'And more'
    },
    sub: {
      look: 'The accent, frosted glass content: one line changes it, and Undo sits under the reply',
      code: 'One theme for each look, its background too; code on screen is painted again',
      steps: 'At the moments the app already has, judged by your command, rule or model',
      model: 'It opens a level at a time, as a project session’s does: endpoint, model, thinking level'
    },
    botsTab: 'Bots', section: 'Projects', search: 'Search',
    botA: 'Pudding', botAPrev: 'The weekly draft is in', botB: 'Producer', botBPrev: 'The poster is final', botC: 'Editor', botCPrev: 'The teaser is cut, have a look',
    dir: 'shop', ccTitle: 'Sign in with a phone number and a code', cxTitle: 'Fix the payment callback', cxPrev: 'The callback checks its signature now',
    pin: 'Pin', trace: 'Trace', map: 'Map',
    stThinking: 'Thinking', stReplying: 'Replying',
    placeholder: name => `Message ${name}...`,
    thinking: 'Thinking', streaming: 'streaming',
    calling: 'Calling edit_interface', called: 'Thinking · Called edit_interface',
    auto: 'Automatic',
    span: s => `${s}s`,
    earlier: 'The weekly draft is in docs/weekly.md, and I checked the numbers again.',
    askLook: 'Make the accent purple and the content frosted glass',
    replyLook: 'Done: the accent is purple and the content lets the window’s frosted glass through. Undo is right below if you don’t like it.',
    chipLabel: 'Interface changed', chipUndo: 'Undo',
    chipLook: 'light --accent: #6d4ae0', chipCode: 'code_theme: {"dark":"dracula"}',
    toast: name => `${name} changed the interface`,
    greetA: 'Good morning, ', greetB: 'Hello, ',
    copyCode: 'Copy code',
    askCode: 'Dracula for code in dark mode',
    replyCode: 'Done: code in the dark look is Dracula now, its background too.',
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
    closingHint: 'When a Bot says results will follow or hands over files, the job\'s own checks are looked at, and a promise not kept goes back to it.',
    turnModel: "The Bot's own model", follows: 'Follows the default model', offShort: 'Off', on: 'On', off: 'Off', runs: 'Runs in this engine',
    unit: { s: 's', min: 'min', hops: 'hops', count: '' },
    own: {
      add: 'Add a step', templatesTitle: 'Starting points', blank: 'Blank step', mine: 'Yours', mineTitle: 'A step you added', draft: 'Not saved',
      tests: 'Run the tests before ending', testsHint: 'As a turn ends: runs pnpm test, and a fail sends the turn back to go on.',
      rules: 'Check the reply against my rules', rulesHint: 'As a turn ends: a model reads the reply against rules you write, and a break sends it back.',
      name: 'Name', nameHint: '40 characters at most', on: 'On',
      moment: 'When it runs', momentValue: 'As a turn ends', momentHint: "When a Bot's turn is about to end, before it does.",
      looksAt: 'Looks at', paths: 'Paths', pathsHint: 'One per line, relative to the workspace; * and ** work, like src/**/*.ts. The files this turn wrote.',
      judges: 'Judges by', kinds: ['Rule', 'Command', 'Model'], kindHint: 'Runs your command; exit 0 is a yes, anything else a no, and the tail of its output is the reason.',
      command: 'Command', commandHint: "Runs in the workspace without the app's environment. It gets a JSON on stdin and the environment variables DESKFOLK_EVENT (the moment), DESKFOLK_STEP (this step), DESKFOLK_PATHS (the paths, one per line), DESKFOLK_COMMAND (the command being looked at) and DESKFOLK_WORKSPACE. Exit 0 is a yes.",
      folder: 'Run in folder', folderHint: 'Relative to the workspace; empty is the workspace itself.', timeout: 'Runs at most', timeoutNote: 's · 1 to 600 s',
      thenTitle: 'When it is a no', thenValue: 'Send it back to go on', thenHint: "The turn goes on instead of ending. It shares the end contract's two send-backs per segment; after those it ends and you are told.",
      tryTitle: 'Try it on a sample', tryHint: 'Nothing is refused, sent back or told to anyone, and nothing is recorded on the flow. Left empty, the newest one is used.', tryReply: 'Reply text', tryRun: 'Try',
      save: 'Save', cancel: "Don't add", del: 'Remove this step',
      said: 'As a turn ends · a no sends it back'
    },
    earlierPick: 'The teaser is cut, in cuts/teaser-v3.mp4; see what you think of the pace.',
    colEndpoint: 'Endpoint', colModel: 'Model', colThinking: 'Thinking level',
    autoHint: 'The app picks a model per message',
    endpoints: ['Work endpoint', 'Local models'],
    models: ['large-2', 'large-2-mini', 'fast-1', 'fast-1-mini', 'code-1'],
    levels: ['None', 'Low', 'Medium', 'High'],
    custom: 'Custom',
    more: ['A Linux preview: AppImage and deb', 'Notices top right, with a countdown ring', 'A ceiling card can say “Ignore, carry on”',
      'A picture waiting in the composer enlarges', 'Projects keep their order as sessions start', 'A home page of six features to play with'],
    tagline: 'Hand it off. Walk away. Return to results.',
    cta: 'Download 0.4.0', url: 'blackman99.github.io/deskfolk',
    fine: 'macOS signed and notarized · Windows and Linux previews · MIT open source · your own model endpoints and agents',
    finer: 'Screens redrawn from the real app'
  }
};
