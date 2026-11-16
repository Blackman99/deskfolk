// Every word in the 0.5.0 release film and its covers, in both languages. Where the film draws an app surface the
// words are the app's own: on the Mac this release ships the native app (apps/desktop-nsh), whose copy is the
// messenger's (apps/messenger/src/lib/copy/*, mirrored in apps/desktop-nsh/app/src/m/copy): the sidebar from
// copy/sidebar.ts (searchShort, botsTab, workspace, tools, settings, statusRunning, statusReplying) and copy/project.ts
// (section); a Bot's direct from copy/chat.ts (replyPrompt, activity.after, activity.verbs, spanPart), copy/stream.ts
// (thinking, streaming), copy/plan.ts (segmentTrace), copy/taskmap.ts (open) and copy/project.ts (modelDefault,
// effortDefault); a project session from copy/project.ts (live, composerPlaceholder) and copy/pane.ts
// (projectFolderOf); the preview's annotations from copy/stream.ts (annotationsTitle, annotationsCount,
// annotationPlaceholder, annotationSaveDraft, annotationSendPending, annotationSendSummary, annotationSend,
// annotationClear, annotationCancel, annotationEdit, annotationDelete, annotationStatusDraft, annotationStatusOpen,
// annotationsFilter*, annotMedia.markHere, annotMedia.endHere). The menu bar's usage lines are
// apps/desktop-nsh/host/src/usage_tray.rs's, whose words are Chinese in both languages (`查看全部用量…`): the en film
// draws them as the app does.
// What the Bots and you say, the names, files, paths, accounts and times are made up for the film; the headlines
// carry the release notes' section titles. Every Bot name is one whose folk (chosen by the name's hash, folkLook in
// packages/protocol/src/folk-avatar.ts) is the character the film says it is.
//
// `platforms` holds every word about platforms, for the opening's line, the end card's fine print and the cover:
// change them there (a chip per platform, its badge, the fine print) and film.js and cover.html follow.
export const STR = {
  zh: {
    word: 'Deskfolk', from: '0.4.0', version: '0.5.0', count: '44 项更新',
    platforms: {
      // the opening's line: one chip each; `new` is the badge after the chip's words, `quiet` greys a preview
      chips: [
        { icon: 'check', text: 'macOS 原生应用', new: '新', tail: '已签名、已公证' },
        { icon: 'check', text: 'Windows 原生应用', new: '新', tail: '预览版' }
      ],
      // the end card's fine print starts with this; the cover's platform line and its headline
      fine: '需要 macOS 14 或更新 · macOS 已签名、已公证 · Windows 预览版',
      cover: 'macOS 与 Windows 原生应用 · macOS 已签名、已公证 · 需要 macOS 14 或更新 · MIT 开源',
      coverHead: 'Deskfolk 现在是原生应用'
    },
    h: {
      native: '原生窗口，没有网页视图',
      usage: 'Claude 额度用完：换你的另一个账号接着做',
      files: '预览里能放视频，项目文件能批注',
      folk: 'Bot 的头像是任务地图上的角色了',
      more: '还有这些'
    },
    sub: {
      native: '⌘B 收起侧边栏：文字和图标各走各的',
      usage: '同一轮换过去接着做，会话里不出一行；都用完了，到点自己接着做',
      files: '大视频一点就开；标出位置写一句，攒一批发给 Agent',
      folk: '由名字决定；思考和回复时，各干各的活'
    },
    slow: '4 倍慢放',
    // the Bots, one per character, in roster order (the name decides the character)
    bots: [
      { name: '剪辑', prev: '字幕对好了', time: '10:58' },
      { name: '文案', prev: '标题写了三版', time: '10:41' },
      { name: '美术', prev: '海报换成暖色了', time: '10:20' },
      { name: '采购', prev: '报价单发你了', time: '09:52' },
      { name: '运维', prev: '备份跑完了', time: '09:30' },
      { name: '资料', prev: '参考资料理好了', time: '昨天' },
      { name: '特效', prev: '片头光效渲好了', time: '昨天' }
    ],
    // the sidebar (copy/sidebar.ts, copy/project.ts) and a pane's header (copy/plan.ts, copy/taskmap.ts)
    search: '搜索', botsTab: 'Bot', section: '项目', workspace: '工作区', tools: '工具', settings: '设置',
    trace: '流程', map: '地图', stThinking: '思考中', stReplying: '回复中', yesterday: '昨天',
    // a Bot's direct (copy/chat.ts replyPrompt + the Bot's name + "..."; copy/stream.ts; activity)
    placeholder: name => `发消息给 ${name}...`,
    thinking: '思考中', streaming: '正在写',
    doing: (verb, what) => `${{ read: '读取', run: '运行' }[verb]} ${what}`,
    done: (verb, what) => `思考中 · ${{ read: '读了', run: '跑完' }[verb]} ${what}`,
    span: (sec) => sec < 60 ? `${sec.toFixed(1)} 秒` : `${Math.floor(sec / 60)} 分 ${Math.floor(sec % 60)} 秒`,
    stepSpan: (sec) => `${Math.floor(sec)}s`,
    modelDefault: '默认模型', effortDefault: '默认思考',
    // 4–10: the direct the fold happens beside
    dmAsk: '预告的字幕帮我对一下时间',
    dmReply: '对好了：第 12 秒那句提前了半秒，已经挪回去。',
    proj: { dir: 'teaser', title: '剪预告片', prev: '初剪好了' },
    // 10–14: a turn on Claude Agent carries on; the menu bar's usage lines (usage_tray.rs)
    usageAsk: '把 v2 的字幕再对一遍，顺便跑一下检查',
    usageFile: 'subs/v2.srt', usageCmd: 'pnpm check:subs',
    usageReply: '对完了：v2 有三处提前了半秒，已改好，检查全过。',
    clock: '11月5日 周三  13:09',
    // 14–19: a project session and its preview (copy/project.ts, copy/pane.ts, copy/stream.ts)
    agentLine: 'Claude Code · ~/teaser',
    live: '在工作',
    agentSay: ['初剪好了，放在 ', '，一分十二秒。'],
    videoFile: 'teaser.mp4',
    projPlaceholder: '和 Claude Code 说点什么…',
    folderTab: name => `${name}项目目录`,
    projAsk: '先把初剪拼出来', plan: '计划',
    srt: ['这个夏天', '一起出发'],
    annotations: '批注', annotationsCount: n => `${n} 条批注`,
    listTabs: ['全部', '待处理', '已处理', '草稿'], draft: '草稿', pending: '待处理',
    markHere: '在此处批注', endHere: '到此为止',
    notePlaceholder: '写一句意见…', note: '这里切得太急，多留半秒', cancel: '取消', saveDraft: '存为草稿',
    sendPending: n => `${n} 条批注待发送`, summary: '再补一句总话（可不填）', summaryText: '按批注改一下', send: '发送批注', clear: '清空',
    edit: '编辑', del: '删除', resolve: '标为已处理',
    absPath: '/Users/me/teaser/cuts/teaser.mp4',
    // 24–26.5: and more (the release notes' other sections)
    // 19–24: the open direct beside the roster
    folkAsk: '海报再出一版冷色的',
    folkReply: '好，冷色这版用深蓝打底，标题换成银白，人物留暖色做对比。',
    more: ['用久了不再每隔几秒卡半秒', '搜索不再卡死窗口', '大文件在预览里打开不再卡住窗口',
      '窗口小了，分屏也都留在窗口里', 'Antigravity 的 Bot 能用 Deskfolk 的工具了', '私聊里的模型选择器从运行方式开始选'],
    // the cover's chips: the film's four scenes
    cover: { chips: ['原生窗口', '额度用完换账号接着做', '预览里放视频、批注项目文件', 'Bot 头像是地图角色'] },
    // the end card
    tagline: '交出去，离开，回来看结果。',
    cta: '下载 0.5.0', url: 'blackman99.github.io/deskfolk',
    fineRest: 'MIT 开源 · 用你自己的模型端点和 agent',
    finer: '界面按真实功能重绘'
  },
  en: {
    word: 'Deskfolk', from: '0.4.0', version: '0.5.0', count: '44 updates',
    platforms: {
      chips: [
        { icon: 'check', text: 'Native on macOS', new: 'new', tail: 'signed and notarized' },
        { icon: 'check', text: 'Native on Windows', new: 'new', tail: 'preview' }
      ],
      fine: 'Needs macOS 14 or later · signed and notarized on macOS · Windows preview',
      cover: 'Native on macOS and Windows · signed and notarized on macOS · macOS 14 or later · MIT',
      coverHead: 'Deskfolk is a native app now'
    },
    h: {
      native: 'Native windows. No web view.',
      usage: 'Out of Claude usage? Your other account goes on',
      files: 'Play videos, annotate project files',
      folk: 'A Bot’s avatar is a task map character',
      more: 'And more'
    },
    sub: {
      native: '⌘B folds the sidebar, words and icons each their own way',
      usage: 'The same turn moves over, with no line in the conversation; all out, it picks up at the reset',
      files: 'A large video opens at once; mark a moment, note it, send a batch to the agent',
      folk: 'Chosen by name; thinking or replying, each works its own way'
    },
    slow: '4× slower',
    bots: [
      { name: 'Script', prev: 'Subtitles are lined up', time: '10:58' },
      { name: 'Schedule', prev: 'Three title drafts', time: '10:41' },
      { name: 'Illustrator', prev: 'Warmer poster colours', time: '10:20' },
      { name: 'Clerk', prev: 'Sent you the quote', time: '09:52' },
      { name: 'Infra', prev: 'Backups are done', time: '09:30' },
      { name: 'Engineer', prev: 'Sources are sorted', time: 'Yesterday' },
      { name: 'Designer', prev: 'The title glow is rendered', time: 'Yesterday' }
    ],
    search: 'Search', botsTab: 'Bots', section: 'Projects', workspace: 'Workspace', tools: 'Tools', settings: 'Settings',
    trace: 'Trace', map: 'Map', stThinking: 'Thinking', stReplying: 'Replying', yesterday: 'Yesterday',
    placeholder: name => `Message ${name}...`,
    thinking: 'Thinking', streaming: 'streaming',
    doing: (verb, what) => `${{ read: 'Reading', run: 'Running' }[verb]} ${what}`,
    done: (verb, what) => `Thinking · ${{ read: 'Read', run: 'Ran' }[verb]} ${what}`,
    span: (sec) => sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`,
    stepSpan: (sec) => `${Math.floor(sec)}s`,
    modelDefault: 'Default model', effortDefault: 'Default thinking',
    dmAsk: 'Line up the teaser’s subtitles for me',
    dmReply: 'Done: the line at 12 seconds came in half a second early; it is back in place.',
    proj: { dir: 'teaser', title: 'Cut the teaser', prev: 'First cut is ready' },
    usageAsk: 'Line up the v2 subtitles again and run the checks',
    usageFile: 'subs/v2.srt', usageCmd: 'pnpm check:subs',
    usageReply: 'Done: three lines in v2 came in half a second early; fixed, and every check passes.',
    clock: 'Wed Nov 5  1:09 PM',
    agentLine: 'Claude Code · ~/teaser',
    live: 'Working',
    agentSay: ['The first cut is in ', ', a minute twelve long.'],
    videoFile: 'teaser.mp4',
    projPlaceholder: 'Say something to Claude Code…',
    folderTab: name => `${name} project folder`,
    projAsk: 'Put the first cut together', plan: 'Plan',
    srt: ['This summer', 'we set off together'],
    annotations: 'Annotations', annotationsCount: n => (n === 1 ? '1 annotation' : `${n} annotations`),
    listTabs: ['All', 'Pending', 'Resolved', 'Drafts'], draft: 'Draft', pending: 'Pending',
    markHere: 'Annotate here', endHere: 'End here',
    notePlaceholder: 'Write a remark…', note: 'This cut comes too fast; hold it half a second', cancel: 'Cancel', saveDraft: 'Save draft',
    sendPending: n => (n === 1 ? '1 annotation to send' : `${n} annotations to send`), summary: 'Add a summary (optional)', summaryText: 'Fix these, please', send: 'Send annotations', clear: 'Clear',
    edit: 'Edit', del: 'Delete', resolve: 'Mark resolved',
    absPath: '/Users/me/teaser/cuts/teaser.mp4',
    folkAsk: 'One more poster, in cool colours',
    folkReply: 'Sure: this one sits on deep blue, the title goes silver, and the people stay warm against it.',
    more: ['No more half-second stalls after weeks of use', 'Search no longer freezes the window', 'Large files open without holding the window',
      'Split panes stay in a small window', 'Antigravity Bots can use Deskfolk’s tools', 'A direct’s model picker starts at what runs the Bot'],
    cover: { chips: ['Native windows', 'Out of usage, another account goes on', 'Videos play; project files take notes', 'Bots look like map characters'] },
    tagline: 'Hand it off. Walk away. Return to results.',
    cta: 'Download 0.5.0', url: 'blackman99.github.io/deskfolk',
    fineRest: 'MIT open source · your own model endpoints and agents',
    finer: 'Screens redrawn from the real app'
  }
};
