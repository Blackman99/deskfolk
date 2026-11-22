// Every word in the 0.6.0 release film and its covers, in both languages. Where the film draws an app surface the
// words are the native app's own (apps/desktop-nsh/app/src, its copy in app/src/m/copy): the sidebar from
// copy/sidebar.ts (search, botsTab, workspace, tools, settings, statusRunning, statusIdle, backToSessions) and
// copy/project.ts (section, live, waitingAnswer, askingMany, askedMany, askNext, askSubmit, composerPlaceholder);
// a Bot's direct from copy/chat.ts (replyPrompt, activity, spanPart) and copy/stream.ts (thinking, streaming, askPickOne,
// askWriteOwn, askAnswered, annotationMode, annotationsTitle); settings from copy/settings.ts (title, tab*, remoteSection,
// remoteSubtitleHost) and copy/remote.ts (statusOnline, hostPair*); the phone from copy/terminal.ts, copy/calendar.ts,
// copy/usage.ts, m/spend/spend-copy.ts and copy/routing.ts; a drop from copy/composer.ts (dropFiles).
// Words that are not the app's but the system's or another program's are said where they come from: the Windows Hello
// sentence is apps/desktop-nsh/host/src/local_confirm.rs's (English only), the toast's words are
// apps/daemon/src/notifications.ts's (Chinese only), so both films draw them as the app writes them.
// What the Bots and you say, the names, files, paths, codes, fingerprints and times are made up for the film; the
// headlines carry the release notes' section titles. Every Bot name is one whose folk (chosen by the name's hash,
// folkLook in packages/protocol/src/folk-avatar.ts) is the character the 0.5.0 film checked.
//
// `platforms` holds every word about platforms: the opening's line, the three-desktop scene's headline, subline and
// desk labels, the Windows taskbar's clock, the end card's fine print and the cover's headline, platform line and
// platform chips. Change them there and film.js and cover.html follow.
export const STR = {
  zh: {
    word: 'Deskfolk', from: '0.5.1', version: '0.6.0', count: '60 项更新',
    platforms: {
      // the opening's line: one chip each; `new` is the badge after the chip's words, `tail` after a dot
      chips: [
        { icon: 'check', text: 'macOS', tail: '已签名、已公证' },
        { icon: 'check', text: 'Windows' },
        { icon: 'check', text: 'Linux', new: '新', tail: '预览版' }
      ],
      // 4–10: the scene's headline and subline, and the label on each desk
      head: '同一个原生应用，三个桌面',
      sub: 'Linux 有 deb 和 AppImage 了；Windows 上用 Windows Hello 配对手机，关上窗口留在托盘',
      desks: { mac: 'macOS', win: 'Windows', linux: 'Linux · deb · AppImage' },
      // the Windows taskbar's clock (made up)
      clock: ['13:09', '2026/11/5'],
      // the end card's fine print starts with this; the cover's platform line, headline and first chips
      fine: '需要 macOS 14 或更新 · macOS 已签名、已公证 · Windows 与 Linux 安装包未签名',
      cover: 'macOS · Windows · Linux（预览） · macOS 已签名、已公证 · MIT 开源',
      coverHead: '一个原生应用，Mac、Windows、Linux 都能用',
      coverChips: ['Linux 有 deb 和 AppImage', 'Windows Hello 配对手机']
    },
    h: {
      ask: '项目会话的 Agent 能问你问题了',
      phone: '手机页面换成了桌面应用自己的',
      send: '发出去的消息从输入框飞进对话',
      more: '还有这些'
    },
    sub: {
      ask: '问题放在对话最后；一次问的几个合成一张卡，一题一题答',
      phone: '终端接回已经开着的那条；文件盖满屏幕打开；左滑返回，底下是要回去的那一页',
      send: '文件也能拖进对话了：PDF、表格、压缩包、视频都行'
    },
    slow: '4 倍慢放',
    // the Bots (0.5.0's roster; the name decides the character)
    bots: [
      { name: '剪辑', prev: '字幕对好了', time: '10:58' },
      { name: '文案', prev: '标题写了三版', time: '10:41' },
      { name: '美术', prev: '海报换成暖色了', time: '10:20' },
      { name: '采购', prev: '报价单发你了', time: '09:52' }
    ],
    // the sidebar (copy/sidebar.ts, copy/project.ts) and a pane's header (copy/plan.ts, copy/taskmap.ts)
    search: '搜索', botsTab: 'Bot', section: '项目', workspace: '工作区', tools: '工具', settings: '设置',
    trace: '流程', map: '地图', stThinking: '思考中', stReplying: '回复中', stIdle: '空闲',
    placeholder: name => `发消息给 ${name}...`,
    thinking: '思考中', streaming: '正在写',
    span: (sec) => sec < 60 ? `${sec.toFixed(1)} 秒` : `${Math.floor(sec / 60)} 分 ${Math.floor(sec % 60)} 秒`,
    modelDefault: '默认模型', effortDefault: '默认思考',
    proj: { dir: 'teaser', title: '剪预告片', prev: '初剪好了' },
    // 4–10: 剪辑's direct in every window: your line, then 剪辑 at work while the window is put away, its reply after
    dmAsk: '预告的字幕帮我对一下时间',
    dmReply: '对好了：第 12 秒那句提前了半秒，已经挪回去。',
    // settings › remote access, the pairing's third step (copy/settings.ts, copy/remote.ts; Windows says 电脑)
    set: {
      title: '设置', remote: '远程控制',
      tabs: ['通用', '界面', '模型服务', 'Agent', 'MCP 扩展', '提示词', '通知', '远程控制', '关于'],
      section: '中继连接', subtitle: '手机或另一台电脑经你自己部署的中继连回这里，端到端加密。实验性功能，默认关闭。', online: '远控在线',
      paste: '在设备上打开中继地址，把这段粘进配对页。它带一次性密钥，十分钟后失效，别写进日志或聊天记录。', copy: '复制内容',
      check: '核对设备上显示的主机指纹，对得上再继续。',
      arrived: name => `${name} 请求配对。`, compare: '这串要和设备上显示的一致。', approve: '批准这台设备', cancel: '取消',
      done: '已配对。设备现在可以连上这台电脑。', close: '关闭'
    },
    // the toast (apps/daemon/src/notifications.ts: the default preview, a reply)
    toast: { title: 'Deskfolk', body: '有新回复，打开查看' },
    // 10–14: a Claude Code project session asks three questions at once
    ask: {
      dir: 'landing', title: '改落地页', time: '13:06', answeredAt: '13:08', live: '在工作', plan: '计划',
      you: '首页按新文案改一版，动手前先问我', said: '新文案读完了。动手前有三处想先跟你确认。',
      head: n => `Claude Code 有 ${n} 个问题要问你`, asked: n => `Claude Code 问了 ${n} 个问题`,
      waiting: 'Claude Code 在等你回答', pickOne: '选一个', own: '自己写，或补充一句…', next: '下一个', submit: '提交回答',
      answered: '已回答',
      qs: [
        { q: '首屏用哪种布局？', o: [['左字右图', '标题和按钮在左，产品截图在右'], ['居中大标题', '一句标题，下面一张大图']], pick: 0 },
        { q: '主色用哪一套？', o: [['品牌青绿', '和应用里的一样'], ['暖橙', '更醒目，和现在的海报一致']], pick: 0 },
        { q: '这次做深色模式吗？', o: [['要', '跟着系统切换'], ['先不做', '下个版本再说']], pick: 1 }
      ],
      after: '好：左字右图，品牌青绿，深色模式先不做。开始改首屏。',
      placeholder: '和 Claude Code 说点什么…'
    },
    // 14–19: the phone page (the narrow layout)
    phone: {
      clock: '11:02', bot: 2, you: '海报终稿发我看看', youT: '10:59',
      earlier: ['封面先出两版看看', '10:41', '出好了：暖色、冷色各一版，冷色那版更接近你说的感觉。', '10:44'],
      say: ['终稿在这：', 'poster-final.png', '，冷色那版。'], sayT: '11:00', model: 'claude-sonnet-4-6',
      back: '返回', annotate: '批注模式', annotations: '批注',
      tools: '工具', toolItems: [['folder', '工作区'], ['calendar', '日程图'], ['dollar', '花费'], ['gauge', '用量'], ['terminal', '终端'], ['nodes', '分工']],
      archived: '已归档会话', tabs: ['Bot', '项目', '设置'], search: '搜索',
      term: { name: 'teaser', cwd: '~/teaser' },
      swipe: '左滑返回'
    },
    // 19–24: a line flies; files dropped onto the composer (copy/composer.ts dropFiles)
    send: {
      bot: 2, ask: '海报再出一版冷色的', askT: '10:20', reply: '好，冷色这版用深蓝打底，标题换成银白。', replyT: '10:21',
      line: '人物也换成冷色光', lineT: '10:22', drop: '松开即添加为附件',
      files: [['storyboard.pdf', '2.4 MB'], ['budget.xlsx', '86.0 KB'], ['cut-v3.mp4', '212.4 MB']]
    },
    more: ['项目会话能跑 Grok 了', '项目会话能新开、也能接着聊 Antigravity', '项目会话能接着你终端里的 Codex 会话',
      '终端换成 NSH 自己的', '文件树里能拖着移动文件了', '手机页首屏少下一半'],
    // the cover's chips after the platform ones: the film's other scenes
    cover: { chips: ['项目会话提问卡', '手机页就是桌面应用'] },
    // the end card
    tagline: '交出去，离开，回来看结果。',
    cta: '下载 0.6.0', url: 'blackman99.github.io/deskfolk',
    fineRest: 'MIT 开源 · 用你自己的模型端点和 agent',
    finer: '界面按真实功能重绘'
  },
  en: {
    word: 'Deskfolk', from: '0.5.1', version: '0.6.0', count: '60 updates',
    platforms: {
      chips: [
        { icon: 'check', text: 'macOS', tail: 'signed and notarized' },
        { icon: 'check', text: 'Windows' },
        { icon: 'check', text: 'Linux', new: 'new', tail: 'preview' }
      ],
      head: 'One native app on three desktops',
      sub: 'Linux gets a deb and an AppImage; Windows pairs a phone with Windows Hello and keeps to the tray',
      desks: { mac: 'macOS', win: 'Windows', linux: 'Linux · deb · AppImage' },
      clock: ['1:09 PM', '11/5/2026'],
      fine: 'macOS 14 or later, signed and notarized · Windows and Linux packages unsigned',
      cover: 'macOS · Windows · Linux (preview) · signed and notarized on macOS · MIT',
      coverHead: 'One native app on macOS, Windows and Linux',
      coverChips: ['A deb and an AppImage for Linux', 'Pair a phone with Windows Hello']
    },
    h: {
      ask: 'A project session’s agent can ask you',
      phone: 'The phone’s page is the desktop app’s own',
      send: 'A line you send flies into the conversation',
      more: 'And more'
    },
    sub: {
      ask: 'Its questions wait at the end; several asked at once are one card, a step at a time',
      phone: 'The terminal reattaches, files open full screen, a back swipe shows the page you go back to',
      send: 'And files drop into a conversation: PDFs, sheets, archives, videos'
    },
    slow: '4× slower',
    bots: [
      { name: 'Script', prev: 'Subtitles are lined up', time: '10:58' },
      { name: 'Schedule', prev: 'Three title drafts', time: '10:41' },
      { name: 'Illustrator', prev: 'Warmer poster colours', time: '10:20' },
      { name: 'Clerk', prev: 'Sent you the quote', time: '09:52' }
    ],
    search: 'Search', botsTab: 'Bots', section: 'Projects', workspace: 'Workspace', tools: 'Tools', settings: 'Settings',
    trace: 'Trace', map: 'Map', stThinking: 'Thinking', stReplying: 'Replying', stIdle: 'Idle',
    placeholder: name => `Message ${name}...`,
    thinking: 'Thinking', streaming: 'streaming',
    span: (sec) => sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`,
    modelDefault: 'Default model', effortDefault: 'Default thinking',
    proj: { dir: 'teaser', title: 'Cut the teaser', prev: 'First cut is ready' },
    dmAsk: 'Line up the teaser’s subtitles for me',
    dmReply: 'Done: the line at 12 seconds came in half a second early; it is back in place.',
    set: {
      title: 'Settings', remote: 'Remote access',
      tabs: ['General', 'Interface', 'Models', 'Agents', 'MCP Servers', 'Prompts', 'Notifications', 'Remote access', 'About'],
      section: 'Relay connection', subtitle: 'A phone or another computer reaches this one through a relay you deploy yourself, end-to-end encrypted. Experimental, off by default.', online: 'Remote online',
      paste: 'Open the relay address on the device and paste this into its pairing screen. It carries a one-time secret, expires in ten minutes, and does not belong in logs or chats.', copy: 'Copy message',
      check: 'Check the host fingerprint the device shows against this one.',
      arrived: name => `${name} is asking to pair.`, compare: 'This has to match what the device is showing.', approve: 'Approve this device', cancel: 'Cancel',
      done: 'Paired. The device can reach this computer now.', close: 'Close'
    },
    toast: { title: 'Deskfolk', body: '有新回复，打开查看' },
    ask: {
      dir: 'landing', title: 'Landing page', time: '13:06', answeredAt: '13:08', live: 'Working', plan: 'Plan',
      you: 'Redo the home page with the new copy; ask me before you start', said: 'I have read the new copy. Three things to settle with you before I start.',
      head: n => `Claude Code has ${n} questions for you`, asked: n => `Claude Code asked ${n} questions`,
      waiting: 'Claude Code is waiting for your answer', pickOne: 'Pick one', own: 'Write your own, or add a note…', next: 'Next', submit: 'Send answers',
      answered: 'Answered',
      qs: [
        { q: 'Which layout for the first screen?', o: [['Words left, picture right', 'Title and buttons on the left, a screenshot on the right'], ['A big centred title', 'One line, a large picture under it']], pick: 0 },
        { q: 'Which main colour?', o: [['Brand teal', 'The same as in the app'], ['Warm orange', 'Louder, like the current posters']], pick: 0 },
        { q: 'Dark mode this time?', o: [['Yes', 'Follows the system'], ['Not yet', 'Next version']], pick: 1 }
      ],
      after: 'Right: words left, brand teal, no dark mode yet. Starting on the first screen.',
      placeholder: 'Say something to Claude Code…'
    },
    phone: {
      clock: '11:02', bot: 2, you: 'Send me the final poster', youT: '10:59',
      earlier: ['Show me two covers first', '10:41', 'Done: a warm one and a cool one; the cool one is closer to what you described.', '10:44'],
      say: ['Here is the final: ', 'poster-final.png', ', the cool one.'], sayT: '11:00', model: 'claude-sonnet-4-6',
      back: 'Back', annotate: 'Annotate', annotations: 'Annotations',
      tools: 'Tools', toolItems: [['folder', 'Workspace'], ['calendar', 'Routine calendar'], ['dollar', 'Spend'], ['gauge', 'Usage'], ['terminal', 'Terminal'], ['nodes', 'Roles']],
      archived: 'Archived sessions', tabs: ['Bots', 'Projects', 'Settings'], search: 'Search',
      term: { name: 'teaser', cwd: '~/teaser' },
      swipe: 'Swipe back'
    },
    send: {
      bot: 2, ask: 'One more poster, in cool colours', askT: '10:20', reply: 'Sure: this one sits on deep blue, the title goes silver.', replyT: '10:21',
      line: 'Cool light on the people too', lineT: '10:22', drop: 'Drop to attach',
      files: [['storyboard.pdf', '2.4 MB'], ['budget.xlsx', '86.0 KB'], ['cut-v3.mp4', '212.4 MB']]
    },
    more: ['Project sessions can run Grok', 'Project sessions start and carry on Antigravity', 'Carry on a Codex session from your terminal',
      'The terminal is NSH’s own', 'Move files by dragging them in the file tree', 'The phone’s first screen downloads half as much'],
    cover: { chips: ['Agents ask on cards', 'The phone’s page is the app’s own'] },
    tagline: 'Hand it off. Walk away. Return to results.',
    cta: 'Download 0.6.0', url: 'blackman99.github.io/deskfolk',
    fineRest: 'MIT open source · your own model endpoints and agents',
    finer: 'Screens redrawn from the real app'
  }
};
