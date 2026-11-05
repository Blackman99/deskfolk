import type { DocsPageKey } from '$lib/docs';
import type { Lang } from '$lib/i18n';

/**
 * The home page's words: a first screen, six chapters that Mochi (you) and Pudding (your Bot) act
 * out, and a last call to download. Every claim here was checked against the app (its copy files,
 * CONTEXT.md and the ADRs); a chapter's `facts` are the small print of what it shows, and a scene's
 * strings are the app's own wording where the scene draws a piece of the app.
 */

export const CHAPTER_IDS = ['models', 'sessions', 'preview', 'panes', 'remote', 'spend'] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

export type ChapterCopy = {
  /** Short name, on the chapter rail and above the title. */
  kicker: string;
  title: string;
  body: string;
  facts: string[];
  link: { label: string; page: DocsPageKey };
};

const zh = {
  hero: {
    lead: '把多天、多步、要返工的活交给 Bot，你去忙别的。往下滑，麻薯（你）和布丁（你的 Bot）把六件事演给你看。',
    download: '下载',
    film: '看短片',
    filmDuration: '0:30',
    filmTitle: 'Deskfolk 短片',
    filmDescription:
      '麻薯（你）一句话把活交给制片布丁：它拆成任务、写明谁做谁审；工作区外先问你；你走开，应用替你盯着；说停就停，下一句接着做；交上来的先过你确认过的检查，审片带依据判；回来看结果。',
    note: 'macOS 已公证，Windows、Linux 预览版',
    close: '关闭',
    tocLabel: '六件事',
    scrollHint: '往下滑',
    deskSays: ['把活交给我吧！', '模型随你接。', '产物就在旁边打开。', '花了多少，一笔笔都记着。']
  },
  names: { mochi: '麻薯（你）', pudding: '布丁（你的 Bot）' },
  pokes: {
    mochi: ['我是麻薯，代表你。', '活交出去了，我去喝杯咖啡。', '别戳啦～', '有事它会来找我的。'],
    pudding: ['我是布丁，你的 Bot。', '在干活呢！', '做完先过检查再交。', '叫停我就停。']
  },
  chapters: {
    models: {
      kicker: '模型随你接',
      title: '订阅、官方、第三方、本机，模型随你接',
      body: '每个 Bot 有自己的运行方式：用你在这台电脑上登录好的 Claude Code、Codex 这类 Agent，花的是你自己的订阅；或者接一个 OpenAI / Anthropic 兼容的端点，官方的、第三方的、本机跑的都行。',
      facts: [
        '本机 Agent：Claude Code、Codex、Grok、OpenCode、Antigravity、ZCode，或自己加的 ACP 命令；应用只调用你登录好的程序，不碰它的登录和 token',
        '端点：Anthropic、DeepSeek、千问、小米 MiMo 填密钥即用；OpenAI、OpenRouter、Ollama、LM Studio、llama.cpp，或任何兼容的地址',
        '每个 Bot 一个默认模型，可以钉住；卡住了沿你排的模型阶梯往上换'
      ],
      link: { label: '模型与工具的术语', page: 'models' }
    },
    sessions: {
      kicker: '接着终端的会话',
      title: '终端里聊到一半的，拿进来接着做',
      body: '在终端里和 Claude Code 聊到一半？在应用里挑出那个会话接着做：应用从它开一个分支，终端里的原会话一个字不动。也可以在任意文件夹里新开 Claude Code 或 Codex 的项目会话。',
      facts: [
        '「导入终端会话…」列出这台电脑上的 Claude Code 会话，最多 120 个',
        '带过来的是你的话和 Claude 的回复，工具调用汇成一行',
        '权限模式、模型、思考等级和停下，都在应用里点',
        'Codex 目前只能在文件夹里新开，还不能导入'
      ],
      link: { label: '会话的术语', page: 'conversations' }
    },
    preview: {
      kicker: '产物就地打开',
      title: '交上来的东西，不用离开应用就能看',
      body: 'Bot 交上来的图、音视频、PDF、Word、Excel、PPT、网页、Markdown 和代码，在聊天旁边直接打开，不用找文件夹、不用换应用；看到哪里不对，就在上面批注，发给 Bot 照着改。',
      facts: [
        '预览面板就在聊天旁边，也能拖成单独的窗格',
        '能批注：文本和代码、Markdown、网页、图片、PDF，音视频按时间点',
        'Office 文件只读，不能批注，最大 50 MB；约 80 种代码和文本带语法高亮'
      ],
      link: { label: '工作区的术语', page: 'workspace' }
    },
    panes: {
      kicker: '多窗格',
      title: '想分几格分几格',
      body: '把标签拖到窗格边上就分开：左边聊天、右边看产物、下面开终端或流程图。横着竖着随便分，按住 ⌥ 拖出来，它就浮在上面。',
      facts: [
        '对话、流程、产物、工作区、终端、日程、花费、用量、分工和任务地图，都能放进窗格',
        '侧栏里的会话直接拖进布局；右键窗格：向上、下、左、右分割',
        '窄屏（680px 以下）和手机上不分窗格'
      ],
      link: { label: '窗与窗格的术语', page: 'runtime' }
    },
    remote: {
      kicker: '远程控制',
      title: '出门了，它还在你手上',
      body: '手机配对一次，在外面也能看 Bot 做到哪了、回话、批准、叫停，翻工作区、敲终端，甚至直接操作 Mac 的屏幕。中继由你自己部署，一路端到端加密，中继自己也看不到内容。',
      facts: [
        '手机上是添加到主屏幕的网页，不用装应用',
        '每台设备在电脑上用 Touch ID 或 Windows Hello 批准，最多 16 台；配对码 10 分钟有效',
        'Mac 屏幕：能直连就直连，连不上自动经中继',
        '默认关闭；macOS 和 Windows 可用'
      ],
      link: { label: '远程访问指南', page: 'remote' }
    },
    spend: {
      kicker: '用量与花费',
      title: '每一笔都看得见',
      body: '每一次模型调用都记进本机账本：哪个 Bot、哪个模型、多少 token、多少钱。供应商报了价的记实报，没报的按你设的单价估算，两个数分开算。订阅额度用了多少、什么时候重置，用量挂件一眼就看到。',
      facts: [
        '按时间、模型、会话、Bot、类别筛；每一笔都能跳回触发它的那条消息',
        '设一个每日花费上限（美元），到了就停下所有 Bot，你按「解除」才放开',
        '套餐额度：Claude（5 小时、7 天）、Codex、Grok、Antigravity；API 密钥的端点按 token 计费，没有套餐额度'
      ],
      link: { label: '花费指南', page: 'spend' }
    }
  } satisfies Record<ChapterId, ChapterCopy>,
  scenes: {
    models: {
      agents: '本机登录的 Agent',
      endpoints: '端点',
      dragHint: '拖插头，插到任一个上',
      runsOn: (name: string) => `运行方式：${name}`,
      endpoint: (name: string) => `端点：${name}`,
      custom: '自定义',
      customLabel: '自定义端点地址',
      customPlaceholder: 'https://api.example.com/v1',
      customInvalid: '填一个 http(s) 开头的地址',
      customKinds: ['OpenAI 兼容', 'Anthropic 兼容'],
      connect: '接上',
      ladderTitle: '模型阶梯',
      rungs: ['快的', '稳的', '最强的'],
      stuck: '卡住了，往上换一级',
      pinned: '已钉住',
      connected: '已接上'
    },
    sessions: {
      terminalTitle: '终端 — ~/dawn-site',
      transcript: [
        { who: 'you', text: '把首页的大标题换成新文案' },
        { who: 'claude', text: '好的，先看一下首页。' },
        { who: 'tool', text: 'Read(src/routes/+page.svelte)' },
        { who: 'tool', text: 'Edit(src/routes/+page.svelte)' },
        { who: 'claude', text: '换好了。要不要把分享图也一起更新？' }
      ],
      appTitle: 'Deskfolk',
      projects: '项目',
      importTitle: '导入终端会话',
      sessionTitle: '把首页的大标题换成新文案',
      sessionMeta: '~/dawn-site · 12 分钟前',
      carryOn: '接着做',
      dragHint: '把会话拖进应用，或点「接着做」',
      toolsFolded: (n: number) => `${n} 次工具调用`,
      kept: '原会话原样保留',
      branch: '应用里的分支',
      next: { you: '好，分享图也一起换', claude: '收到，分享图也换成新标题。' },
      composer: '接着说…',
      codex: 'Codex：在文件夹里新开',
      replay: '重放',
      replayLabel: '重放这一段'
    },
    preview: {
      tabTitle: '布丁的产物',
      dropHint: '把你电脑上的文件拖进来试试：只在这个页面里打开，不上传',
      dropNow: '松手，布丁接住',
      pick: '选个文件',
      local: '本地预览，不上传',
      samples: { poster: 'poster.jpg', film: 'dawn-promo.mp4', pdf: 'brief.pdf', sheet: 'budget.xlsx', doc: 'notes.md' },
      office: (ext: string) => `${ext} 文件在应用里直接打开（只读）；这个页面不解析它`,
      tooBig: (kb: number) => `文件较大，这里只显示前 ${kb} KB`,
      unknown: '这种文件这个页面打不开；应用里能看的种类见左边',
      annotateHint: '点一下预览，加一条批注',
      annotationPlaceholder: '哪里要改…',
      send: '发给 Bot',
      received: (n: number) => `布丁收到 ${n} 条批注，照着改`,
      sheet: { head: ['项目', '预算', '已花'], rows: [['拍摄', '¥3,000', '¥2,450'], ['配乐', '¥800', '¥800'], ['投放', '¥5,000', '¥1,920']] },
      pdfLines: ['晨光手冲壶 · 宣传片简报', '时长 6 秒，1080×1920', '片尾带品牌 logo，配一句主标语'],
      docLines: ['# 拍摄笔记', '- 早上 7 点的侧光', '- 壶嘴的水流要慢', '- 片尾 logo 再大一点'],
      note: '片尾 logo 再大一点',
      fileList: '文件列表',
      previewLabel: '预览'
    },
    panes: {
      tabs: ['群「发布」', '布丁的产物', '终端', '流程', '花费'],
      dropHint: '把标签拖到窗格边上',
      floatHint: '按住 ⌥ 拖：浮动',
      menu: ['向上分割', '向下分割', '向左分割', '向右分割', '浮动这个标签页'],
      narrow: '窄屏和手机上不分窗格；下面是在电脑上的样子',
      reset: '还原',
      close: '关闭',
      resize: '调整窗格大小',
      window: 'Deskfolk 窗口示意',
      paneMenu: '窗格菜单',
      tray: '还没打开的标签页'
    },
    remote: {
      openPhone: '在新窗口打开手机',
      openHint: '两个窗口实时同步：在小窗里点，这边的布丁马上有反应',
      popupBlocked: '弹窗被拦下了，就用页面里这部手机吧',
      deskTitle: '电脑上的 Deskfolk',
      away: '你出门了',
      tabs: ['对话', '工作区', '终端', 'Mac 屏幕'],
      sidebar: ['群「发布」', '布丁', '审片'],
      chat: {
        history: [
          { mine: true, text: '首页的大标题换成新文案，改好写进 site/hero.md' },
          { mine: false, text: '好，我先看看现在的首页。' }
        ],
        bot: '首页文案改好了，要写进 site/hero.md。',
        doneBot: '写好了，等你回来看。',
        you: '好，接着做吧'
      },
      approval: { head: '这一步要先问你', tool: '写入 site/hero.md', allowOnce: '允许一次', deny: '拒绝' },
      stop: '停下',
      stopped: '已停下',
      resume: '接着做吧',
      status: { working: '布丁在干活…', waiting: '布丁在等你批准', stopped: '已停下：你再说一句，它就接着做', done: '做完了，等你回来看' },
      push: 'Deskfolk 有待处理事项',
      e2e: '端到端加密',
      relay: '经你的中继',
      direct: '直连',
      files: ['site/hero.md', 'site/og.png', 'notes.md'],
      terminal: ['$ pnpm build', '✓ built in 2.1s'],
      screenHint: '这就是你 Mac 上此刻的画面',
      waiting: '等你批准',
      replay: '重放',
      denied: '已拒绝，布丁换个办法',
      phoneLabel: '手机上的 Deskfolk',
      screenLabel: '电脑屏幕的缩略画面'
    },
    spend: {
      title: '花费 · 今天',
      sample: '示例数据',
      columns: ['时间', 'Bot', '模型', 'token', '美元'],
      reported: '实报',
      estimated: '估算',
      totalReported: '实报合计',
      totalEstimated: '估算合计',
      cap: (amount: string) => `每日上限 ${amount}`,
      capHit: '到上限了：所有 Bot 停下',
      release: '解除',
      released: '已解除，今天不再拦',
      stopped: '停下了，等你解除',
      jump: '跳到触发它的消息',
      bots: { producer: '制片', reviewer: '审片' },
      messages: ['给晨光手冲壶做一支 6 秒宣传短片', '片尾 logo 再大一点', '审一下这一版', '配一句主标语'],
      usage: {
        widget: '用量挂件',
        title: '用量',
        used: (percent: string) => `已用${percent}`,
        resetsIn: (wait: string) => `${wait}后重置`,
        hoursMinutes: (h: number, m: number) => (h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`),
        windows: { fiveHour: '5 小时', week: '7 天' },
        noPlan: '按 token 计费，没有套餐额度',
        apiKey: 'DeepSeek 端点',
        dragHint: '拖到哪都行，放到左右边上就贴边藏起一半',
        close: '收起'
      }
    }
  },
  end: {
    title: '交出去，离开，回来看结果。',
    body: '会话和文件都在你自己的电脑上，MIT 开源。',
    download: '下载',
    docs: '看文档'
  },
  rail: '六件事'
};

export type HomeCopy = typeof zh;

const en: HomeCopy = {
  hero: {
    lead: 'Hand Bots the multi-day, multi-step jobs that need rework, and get on with your day. Scroll on: Mochi (you) and Pudding (your Bot) act out six things it does.',
    download: 'Download',
    film: 'Watch the film',
    filmDuration: '0:30',
    filmTitle: 'The Deskfolk film',
    filmDescription:
      'Mochi (you) hands the job to Pudding, the Producer, in one line: it lays out tickets naming who makes and who reviews each; it asks before leaving the workspace; you walk away while the app keeps watch; say stop and it stops, your next line sets it going; what it hands in must pass the checks you confirmed, and the Reviewer rules with evidence; you come back to results.',
    note: 'macOS notarized, Windows and Linux previews',
    close: 'Close',
    tocLabel: 'Six things',
    scrollHint: 'Scroll',
    deskSays: ['Hand it to me!', 'Any model you bring.', 'Results open right here.', 'Every call is on the books.']
  },
  names: { mochi: 'Mochi (you)', pudding: 'Pudding (your Bot)' },
  pokes: {
    mochi: ['I’m Mochi. I stand for you.', 'Job’s handed off. Coffee time.', 'Hey, that tickles!', 'It’ll come find me if it needs me.'],
    pudding: ['I’m Pudding, your Bot.', 'Busy working!', 'Checks first, then I hand it in.', 'Say stop and I stop.']
  },
  chapters: {
    models: {
      kicker: 'Any model',
      title: 'Your subscription, any vendor, a third party or your own machine',
      body: 'Each Bot runs its own way: on a local agent you’re already signed in to on this computer, such as Claude Code or Codex, spending your own subscription; or on an OpenAI- or Anthropic-compatible endpoint, whether official, third-party or running on your machine.',
      facts: [
        'Local agents: Claude Code, Codex, Grok, OpenCode, Antigravity, ZCode, or an ACP command you add; the app runs the program you signed in to and never touches its sign-in or tokens',
        'Endpoints: Anthropic, DeepSeek, Qwen and Xiaomi MiMo with just a key; OpenAI, OpenRouter, Ollama, LM Studio, llama.cpp, or any compatible address',
        'Each Bot has a default model you can pin, and climbs the model ladder you set when it gets stuck'
      ],
      link: { label: 'Models and tools glossary', page: 'models' }
    },
    sessions: {
      kicker: 'Terminal sessions',
      title: 'Halfway through in the terminal? Carry on here',
      body: 'Halfway through a Claude Code chat in the terminal? Pick that session in the app and carry on: the app branches from it, and the terminal’s own session is left exactly as it was. Or start a new Claude Code or Codex project session in any folder.',
      facts: [
        '“Import a terminal session…” lists the Claude Code sessions on this computer, up to 120',
        'Your words and Claude’s replies come along; tool calls fold into one line',
        'Permission mode, model, thinking and Stop are a click in the app',
        'Codex starts new sessions in a folder; it can’t be imported yet'
      ],
      link: { label: 'Sessions glossary', page: 'conversations' }
    },
    preview: {
      kicker: 'Files in place',
      title: 'What it hands in opens without leaving the app',
      body: 'Images, audio and video, PDFs, Word, Excel and PowerPoint, web pages, Markdown and code a Bot hands in open right beside the chat: no hunting through folders, no other app. See something off? Annotate it and send the notes to the Bot to work from.',
      facts: [
        'The preview panel sits beside the chat and can be dragged into a pane of its own',
        'Annotate text and code, Markdown, web pages, images, PDFs, and audio and video at points in time',
        'Office files are view-only, not annotatable, up to 50 MB; about 80 kinds of code and text are highlighted'
      ],
      link: { label: 'Workspace glossary', page: 'workspace' }
    },
    panes: {
      kicker: 'Panes',
      title: 'Split it any way you like',
      body: 'Drag a tab to a pane’s edge and it splits: the chat on the left, the results on the right, a terminal or the flow below. Split across or down as often as you like; hold ⌥ while you drag and it floats.',
      facts: [
        'Chats, flows, artifacts, the workspace, terminals, the calendar, spend, usage, roles and task maps all go in panes',
        'Drag a conversation from the sidebar straight into the layout; right-click a pane to split it up, down, left or right',
        'No panes on narrow windows (under 680px) or on phones'
      ],
      link: { label: 'Window and panes glossary', page: 'runtime' }
    },
    remote: {
      kicker: 'Remote control',
      title: 'Out of the house, still in your hand',
      body: 'Pair your phone once, and from anywhere you can see how far the Bots got, reply, approve, stop them, browse the workspace, type in a terminal, even drive your Mac’s screen. You run the relay yourself, and traffic is end-to-end encrypted, so not even the relay can read it.',
      facts: [
        'The phone app is a web page added to your Home Screen; nothing to install',
        'Each device is approved on the computer with Touch ID or Windows Hello, up to 16; pairing codes last 10 minutes',
        'Mac screen: direct when it can be, through the relay when it can’t',
        'Off by default; available on macOS and Windows'
      ],
      link: { label: 'Remote access guide', page: 'remote' }
    },
    spend: {
      kicker: 'Usage and spend',
      title: 'Every call on the books',
      body: 'Every model call goes into a ledger on your machine: which Bot, which model, how many tokens, what it cost. Prices the provider reports are kept as reported; the rest are estimated from prices you set, and the two are totalled apart. How much of a plan you’ve used and when it resets is on the usage widget.',
      facts: [
        'Filter by time, model, session, Bot and category; every call jumps back to the message that set it off',
        'Set a daily spend cap in dollars: reach it and every Bot stops until you press Lift',
        'Plan limits for Claude (5-hour and 7-day), Codex, Grok and Antigravity; API-key endpoints bill per token, with no plan limits'
      ],
      link: { label: 'Spend guide', page: 'spend' }
    }
  },
  scenes: {
    models: {
      agents: 'Local agents you’re signed in to',
      endpoints: 'Endpoints',
      dragHint: 'Drag the plug into any socket',
      runsOn: (name: string) => `Runs on: ${name}`,
      endpoint: (name: string) => `Endpoint: ${name}`,
      custom: 'Custom',
      customLabel: 'Custom endpoint address',
      customPlaceholder: 'https://api.example.com/v1',
      customInvalid: 'Enter an address starting with http(s)',
      customKinds: ['OpenAI-compatible', 'Anthropic-compatible'],
      connect: 'Connect',
      ladderTitle: 'Model ladder',
      rungs: ['Fast', 'Steady', 'Strongest'],
      stuck: 'Stuck: up one rung',
      pinned: 'Pinned',
      connected: 'connected'
    },
    sessions: {
      terminalTitle: 'Terminal — ~/dawn-site',
      transcript: [
        { who: 'you', text: 'Swap the home page headline for the new copy' },
        { who: 'claude', text: 'Sure, let me look at the home page first.' },
        { who: 'tool', text: 'Read(src/routes/+page.svelte)' },
        { who: 'tool', text: 'Edit(src/routes/+page.svelte)' },
        { who: 'claude', text: 'Done. Shall I update the share image too?' }
      ],
      appTitle: 'Deskfolk',
      projects: 'Projects',
      importTitle: 'Import a terminal session',
      sessionTitle: 'Swap the home page headline for the new copy',
      sessionMeta: '~/dawn-site · 12 min ago',
      carryOn: 'Carry on',
      dragHint: 'Drag the session into the app, or press Carry on',
      toolsFolded: (n: number) => `${n} tool calls`,
      kept: 'Original left as it was',
      branch: 'The app’s branch',
      next: { you: 'Yes, the share image too', claude: 'On it: the share image gets the new headline too.' },
      composer: 'Carry on…',
      codex: 'Codex: new sessions in a folder',
      replay: 'Replay',
      replayLabel: 'Replay this scene'
    },
    preview: {
      tabTitle: 'Pudding’s artifacts',
      dropHint: 'Drop a file from your computer: it opens in this page only, nothing is uploaded',
      dropNow: 'Let go, Pudding will catch it',
      pick: 'Pick a file',
      local: 'Local preview, not uploaded',
      samples: { poster: 'poster.jpg', film: 'dawn-promo.mp4', pdf: 'brief.pdf', sheet: 'budget.xlsx', doc: 'notes.md' },
      office: (ext: string) => `${ext} files open right in the app (view-only); this page doesn’t read them`,
      tooBig: (kb: number) => `A large file: showing the first ${kb} KB`,
      unknown: 'This page can’t open that kind of file; the kinds the app opens are listed on the left',
      annotateHint: 'Click the preview to add a note',
      annotationPlaceholder: 'What should change…',
      send: 'Send to Bot',
      received: (n: number) => `Pudding got ${n} ${n === 1 ? 'note' : 'notes'} and is on it`,
      sheet: { head: ['Item', 'Budget', 'Spent'], rows: [['Shoot', '$420', '$345'], ['Music', '$110', '$110'], ['Ads', '$700', '$270']] },
      pdfLines: ['Dawn kettle · promo brief', '6 seconds, 1080×1920', 'Ends on the brand logo, with a tagline'],
      docLines: ['# Shoot notes', '- Side light at 7 am', '- Slow pour from the spout', '- Bigger logo at the end'],
      note: 'Bigger logo at the end',
      fileList: 'Files',
      previewLabel: 'Preview'
    },
    panes: {
      tabs: ['Launch group', 'Pudding’s artifacts', 'Terminal', 'Flow', 'Spend'],
      dropHint: 'Drag a tab to a pane’s edge',
      floatHint: 'Hold ⌥ while dragging: float',
      menu: ['Split up', 'Split down', 'Split left', 'Split right', 'Float this tab'],
      narrow: 'No panes on narrow screens or phones; this is how it looks on a computer',
      reset: 'Reset',
      close: 'Close',
      resize: 'Resize panes',
      window: 'Deskfolk window, sketched',
      paneMenu: 'Pane menu',
      tray: 'Tabs not open yet'
    },
    remote: {
      openPhone: 'Open the phone in a new window',
      openHint: 'The two windows stay in sync: tap in the small one and Pudding reacts here',
      popupBlocked: 'The pop-up was blocked; use the phone on the page instead',
      deskTitle: 'Deskfolk on your computer',
      away: 'You’re out',
      tabs: ['Chats', 'Workspace', 'Terminal', 'Mac screen'],
      sidebar: ['Launch group', 'Pudding', 'Reviewer'],
      chat: {
        history: [
          { mine: true, text: 'New copy for the home page headline, written into site/hero.md' },
          { mine: false, text: 'Sure, let me look at the home page first.' }
        ],
        bot: 'The home page copy is ready to go into site/hero.md.',
        doneBot: 'Written. It’s waiting for you.',
        you: 'Fine, carry on'
      },
      approval: { head: 'This step asks you first', tool: 'Write site/hero.md', allowOnce: 'Allow once', deny: 'Deny' },
      stop: 'Stop',
      stopped: 'Stopped',
      resume: 'Fine, carry on',
      status: {
        working: 'Pudding is working…',
        waiting: 'Pudding is waiting for your OK',
        stopped: 'Stopped: say one more thing and it carries on',
        done: 'Done, waiting for you'
      },
      push: 'Deskfolk has pending items',
      e2e: 'End-to-end encrypted',
      relay: 'Via your relay',
      direct: 'Direct',
      files: ['site/hero.md', 'site/og.png', 'notes.md'],
      terminal: ['$ pnpm build', '✓ built in 2.1s'],
      screenHint: 'Your Mac’s screen, right now',
      waiting: 'Waiting for you',
      replay: 'Replay',
      denied: 'Denied; Pudding tries another way',
      phoneLabel: 'Deskfolk on the phone',
      screenLabel: 'Miniature of the computer screen'
    },
    spend: {
      title: 'Spend · today',
      sample: 'Sample data',
      columns: ['Time', 'Bot', 'Model', 'Tokens', 'USD'],
      reported: 'Reported',
      estimated: 'Estimated',
      totalReported: 'Reported total',
      totalEstimated: 'Estimated total',
      cap: (amount: string) => `Daily cap ${amount}`,
      capHit: 'Cap reached: every Bot stops',
      release: 'Lift',
      released: 'Lifted: no more stops today',
      stopped: 'Stopped until you lift it',
      jump: 'Jump to the message that set it off',
      bots: { producer: 'Producer', reviewer: 'Reviewer' },
      messages: ['Make a 6-second promo for the Dawn kettle', 'Bigger logo at the end', 'Review this cut', 'Add a tagline'],
      usage: {
        widget: 'Usage widget',
        title: 'Usage',
        used: (percent: string) => `${percent} used`,
        resetsIn: (wait: string) => `Resets in ${wait}`,
        hoursMinutes: (h: number, m: number) => (h > 0 ? `${h} h ${m} min` : `${m} min`),
        windows: { fiveHour: '5-hour', week: '7-day' },
        noPlan: 'Billed per token: no plan limits',
        apiKey: 'DeepSeek endpoint',
        dragHint: 'Drag me anywhere; let go at the left or right edge and I tuck in',
        close: 'Close'
      }
    }
  },
  end: {
    title: 'Hand it off. Walk away. Return to results.',
    body: 'Your chats and files stay on your own computer. MIT open source.',
    download: 'Download',
    docs: 'Read the docs'
  },
  rail: 'Six things'
};

export const HOME: Record<Lang, HomeCopy> = { zh, en };

export type SceneCopy = HomeCopy['scenes'];
