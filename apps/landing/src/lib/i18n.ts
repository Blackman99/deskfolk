export type Lang = 'zh' | 'en';

export type BotId = 'coordinator' | 'researcher' | 'writer';

export type StepCopy = {
  title: string;
  body: string;
  callout: string;
};

export type BoundaryRow = {
  dim: string;
  live: string;
  wip: string;
  avoid: string;
};

export type Dict = {
  nav: {
    demo: string;
    boundaries: string;
    quickstart: string;
    manifesto: string;
    roadmap: string;
    github: string;
    switchLang: string;
    wip: string;
    download: string;
    menu: string;
    closeMenu: string;
    theme: string;
    themeSystem: string;
    themeLight: string;
    themeDark: string;
  };
  hero: {
    headline: string;
    headlineLines: string[];
    subhead: string;
    wipNote: string;
    ctaPrimary: string;
    ctaSecondary: string;
    runLabel: string;
    runCommand: string;
    copy: string;
    copied: string;
    scrollHint: string;
  };
  demo: {
    heading: string;
    intro: string;
    steps: StepCopy[];
    railLabel: string;
  };
  mock: {
    windowTitle: string;
    roster: string;
    addBot: string;
    search: string;
    groups: string;
    youBot: string;
    workspace: string;
    settings: string;
    emptyRoster: string;
    welcome: string;
    starters: string[];
    composerPlaceholder: string;
    sendHint: string;
    replying: string;
    groupSettings: string;
    botSettings: string;
    members: (n: number) => string;
    pendingApproval: string;
    unread: string;
    settingsTitle: string;
    settingsTabs: [string, string, string];
    wizardHint: string;
    workspaceLabel: string;
    endpointLabel: string;
    endpointName: string;
    endpointUrlLabel: string;
    endpointKeyLabel: string;
    keySet: string;
    keyHint: string;
    modelsLabel: string;
    modelCols: { strengths: string; thinking: string; price: string };
    save: string;
    newBot: string;
    fieldName: string;
    fieldDuties: string;
    fieldBoundaries: string;
    fieldAvatar: string;
    avatarRefresh: string;
    approvalTitle: (bot: string) => string;
    approvalKind: string;
    approvalKindValue: string;
    approvalName: string;
    approvalTransport: string;
    approvalCommand: string;
    approvalNoAlways: string;
    allowOnce: string;
    deny: string;
    allowed: string;
    previewTitle: string;
    previewRendered: string;
    previewSource: string;
    previewSave: string;
    previewUnsaved: string;
    previewSaved: string;
    trayHidden: string;
    trayTurns: string;
    trayShow: string;
    trayStop: string;
    trayQuit: string;
    judgementJoin: string;
    judgementPass: string;
    judgementLabel: string;
  };
  bots: Record<BotId, { name: string; duties: string; boundaries: string }>;
  script: {
    groupName: string;
    workspacePath: string;
    endpointName: string;
    endpointUrl: string;
    models: { name: string; strengths: string; thinking: string; price: string }[];
    userCreateTeam: string;
    coordinatorCreated: string;
    userGroupGoal: string;
    researcherRead: string;
    researcherHandoff: [string, string];
    researcherNotePath: string;
    writerDone: string;
    reportPath: string;
    coordinatorClose: string;
    reportLines: string[];
    reportEditLine: string;
  };
  boundaries: {
    heading: string;
    intro: string;
    colLive: string;
    colWip: string;
    colAvoid: string;
    rows: BoundaryRow[];
    /** [before roadmap link, between roadmap and CONTEXT.md links, after] */
    footnote: [string, string, string];
  };
  quickstart: {
    heading: string;
    intro: string;
    requirements: string;
    step1: string;
    step2: string;
    firstRun: string[];
    download: { title: string; body: string; link: string; note: string };
    linkDocs: string;
    linkManifesto: string;
    linkRoadmap: string;
  };
  footer: {
    tagline: string;
    mit: string;
    contributors: string;
  };
  seo: {
    title: string;
    description: string;
    imageAlt: string;
  };
  docs: {
    toc: string;
    manifestoTag: string;
    manifestoIntro: string;
    roadmapTag: string;
    roadmapIntro: string;
    backHome: string;
    toRoadmap: string;
    toManifesto: string;
  };
};

const zh: Dict = {
  nav: {
    demo: '完整流程',
    boundaries: '边界',
    quickstart: '从源码启动',
    manifesto: '设计理念',
    roadmap: '路线图',
    github: 'GitHub',
    switchLang: 'English',
    wip: 'Alpha',
    download: '下载',
    menu: '菜单',
    closeMenu: '关闭菜单',
    theme: '外观',
    themeSystem: '跟随系统',
    themeLight: '亮色',
    themeDark: '暗色'
  },
  hero: {
    headline: '在自己的电脑上，用对话组一支持久的 AI 队友。',
    headlineLines: ['在自己的电脑上，', '用对话组一支', '持久的 AI 队友。'],
    subhead:
      'Bot 有名字、职责和边界，可以私聊、进群、被 @ 点名、彼此交接。窗口、运行时、会话和共享工作区都在你的 Mac 上；模型端点和 MCP 工具由你接入。',
    wipNote: 'Alpha 版本：macOS 未签名快照，功能与数据结构仍会变化。',
    ctaPrimary: '下载 Alpha（macOS）',
    ctaSecondary: '从源码启动',
    runLabel: '本机运行',
    runCommand: 'pnpm install && pnpm dev',
    copy: '复制',
    copied: '已复制',
    scrollHint: '往下滚动，看一遍完整流程'
  },
  demo: {
    heading: '从空名册到交付 report.md，一次走完',
    intro: '右侧窗口会随着你的滚动自己操作起来。窗口是按应用当前实现重建的示意，每一步对应真实存在的功能，不是概念图。',
    railLabel: '演示进度',
    steps: [
      {
        title: '先填工作区和模型端点',
        body:
          '设置就是向导：一个本机目录做共享工作区，再加至少一个 OpenAI 兼容端点。模型名单写清楚擅长领域、思考等级和价格，之后由应用按任务挑模型，你不用每轮自选。',
        callout: '密钥只在这个输入框里填，不进聊天。'
      },
      {
        title: '建第一个 Bot',
        body:
          '名字、职责、边界三格必填。头像按名字生成。保存后名册那一行多一个头像，和它的私聊随即打开。名册没有人数上限，也不含你。',
        callout: '名册是侧栏顶上那一行头像。'
      },
      {
        title: '剩下的队友，让它自己去建',
        body:
          '直接告诉 Coordinator 要谁。它用内置工具创建 Researcher 和 Writer、建好群「调研」，把三个人都拉进去。创建 Bot、建群、改配置，都是对话里的一句话。',
        callout: 'Bot 可以创建 Bot、建群、改端点和 MCP。'
      },
      {
        title: '在群里下任务，没被点名的自己判断',
        body:
          '你发一条不带 @ 的消息，在场的每个 Bot 各自决定下场还是旁观；旁观不进主转录。用 @ 点名则必须下场。应用不代你裁决谁说话，也没有轮数熔断。',
        callout: '参与判断：Researcher 下场，其余旁观。'
      },
      {
        title: '危险动作停在批准卡上',
        body:
          'Researcher 想加一个 MCP 服务器来抓网页。新增 MCP、新建端点、工作区外读写和出站网络都要你放行；新增 MCP 这一类不能 Always allow。已配好的工具调用则直接执行。',
        callout: '允许一次或拒绝。密钥不进转录。'
      },
      {
        title: '交接就是发消息',
        body:
          'Researcher 整理完把 @Writer 写进消息，Writer 被叫醒接着干。本轮写出的工作区文件自动挂在回复上，没有另一套产物库。',
        callout: '同一个工作区，不复制、不隔离。'
      },
      {
        title: '产物就在你的工作区里',
        body:
          '点开 report.md，右侧预览面板是 Monaco 编辑器：行号、查找、Markdown 渲染或源码。改完 Cmd+S 写回同一路径；侧栏 ⌘O 能打开整棵目录。',
        callout: '写回的是磁盘上的真文件。'
      },
      {
        title: '关窗不停，守护进程接着跑',
        body:
          '窗口藏进托盘，进行中的轮次继续。私聊里的 Stop 立即停掉眼前这一轮；群聊要停就发消息。Cmd+Q 或托盘「退出」才结束窗口和守护进程。',
        callout: '关窗是隐藏，不是退出。'
      }
    ]
  },
  mock: {
    windowTitle: 'Real Bot',
    roster: '名册',
    addBot: '新建 Bot',
    search: '搜索会话、消息、文件、日程',
    groups: '群',
    youBot: '你 ↔ Bot',
    workspace: '工作区',
    settings: '设置',
    emptyRoster: '名册是空的。点名册那一行的 + 建 Bot。',
    welcome: '开始和 Coordinator 私聊',
    starters: ['你可以帮我做什么？', '查看当前工作区有哪些文件', '开始一个新任务'],
    composerPlaceholder: '发消息，@ 点名队友',
    sendHint: 'Enter ↵ 发送 · Shift+Enter 换行',
    replying: '回复中',
    groupSettings: '群组设置',
    botSettings: 'Bot 设置',
    members: (n) => `${n} 位成员`,
    pendingApproval: '待审批',
    unread: '未读',
    settingsTitle: '设置',
    settingsTabs: ['通用', '模型服务', 'MCP 扩展'],
    wizardHint: '向导就是设置的空态：工作区路径、至少一个端点的 URL 和密钥齐了即完成。',
    workspaceLabel: '工作区目录',
    endpointLabel: '端点',
    endpointName: '名称',
    endpointUrlLabel: 'URL',
    endpointKeyLabel: '端点密钥',
    keySet: '已配置',
    keyHint: '进钥匙串，不进 SQLite。',
    modelsLabel: '模型名单',
    modelCols: { strengths: '擅长', thinking: '思考', price: '价格' },
    save: '保存',
    newBot: '新建 Bot',
    fieldName: '名字',
    fieldDuties: '职责',
    fieldBoundaries: '边界',
    fieldAvatar: '头像',
    avatarRefresh: '换一个',
    approvalTitle: (bot) => `${bot} 想新增 MCP 服务器`,
    approvalKind: '种类',
    approvalKindValue: '新增 MCP（每次都要批准）',
    approvalName: '名称',
    approvalTransport: '传输',
    approvalCommand: '命令',
    approvalNoAlways: '这一类没有 Always allow。',
    allowOnce: '允许一次',
    deny: '拒绝',
    allowed: '已允许',
    previewTitle: '产物预览',
    previewRendered: '预览',
    previewSource: '源码',
    previewSave: '保存',
    previewUnsaved: '未保存',
    previewSaved: '已保存到 report.md',
    trayHidden: '窗口已隐藏到托盘，轮次继续。',
    trayTurns: '进行中',
    trayShow: '显示窗口',
    trayStop: 'Stop',
    trayQuit: '退出',
    judgementJoin: '下场',
    judgementPass: '旁观',
    judgementLabel: '参与判断'
  },
  bots: {
    coordinator: {
      name: 'Coordinator',
      duties: '协调研究与写作，拆解任务并交接',
      boundaries: '不直接做深层调研；需要放行的动作先问用户'
    },
    researcher: {
      name: 'Researcher',
      duties: '深度调研与事实核验',
      boundaries: '只整理与核验，不改结论措辞'
    },
    writer: {
      name: 'Writer',
      duties: '起草与排版 report.md',
      boundaries: '沿用 Researcher 的核验结论，不擅自改数字'
    }
  },
  script: {
    groupName: '调研',
    workspacePath: '/Users/you/real-bot-workspace',
    endpointName: '本地 vLLM',
    endpointUrl: 'http://127.0.0.1:8000/v1',
    models: [
      { name: 'qwen3-32b', strengths: '中文写作、分析', thinking: 'low / medium / high', price: '¥1 / M' },
      { name: 'deepseek-v3.2', strengths: '编码、工具调用', thinking: 'none / low', price: '¥2 / M' },
      { name: 'glm-4.6-flash', strengths: '摘要、判断', thinking: 'none', price: '¥0.1 / M' }
    ],
    userCreateTeam:
      '创建两个队友：Researcher 负责深度调研与核验，Writer 负责起草 report.md。把你们三个组成一个叫「调研」的群。',
    coordinatorCreated:
      '已创建 Researcher 和 Writer，并建好群「调研」，我们三个都在里面。要开始的话，直接在群里说目标就行。',
    userGroupGoal: '围绕工作区里的 brief.md 完成 report.md。需要交接时直接联系对方，不用等我。',
    researcherRead: '读完 brief.md。三个问题里有两个引用了外部年报的数字，我需要抓网页核对之后再整理。',
    researcherHandoff: ['数字核对完了，结论整理在 notes/brief-summary.md。', ' 请据此起草 report.md，结构按 brief 的三个问题走。'],
    researcherNotePath: 'notes/brief-summary.md',
    writerDone: '已写入 report.md，共 6 节，结论沿用核验版本，没有改任何数字。',
    reportPath: 'report.md',
    coordinatorClose: '对照 brief.md 复核过 report.md：三个问题都有回答，数字与核验一致，可以交付了。',
    reportLines: [
      '# 调研报告',
      '',
      '> 依据 brief.md 与 notes/brief-summary.md 整理',
      '',
      '## 1. 背景',
      '',
      '本地协作工具在过去两年里从「单次对话」转向',
      '「持久队友」。brief 提出的三个问题围绕这一转变。',
      '',
      '## 2. 问题一：谁在用',
      '',
      '年报显示个人开发者占比 61%，较上一年 +9 pt。'
    ],
    reportEditLine: '> 核验：Researcher，2026-09-17'
  },
  boundaries: {
    heading: '哪些已经接入，哪些还在建，哪些不做',
    intro: '「已接入」表示代码里有实现，不代表每种模型、工具组合和完整任务路径都通过了真实环境验收。',
    colLive: '已接入',
    colWip: '正在建设',
    colAvoid: '明确不做',
    rows: [
      {
        dim: '运行时底座',
        live: 'macOS 桌面窗、常驻守护进程、本地共享工作区、SQLite 持久化',
        wip: '复杂真实场景下的长期稳定性验证',
        avoid: '云电脑、云端计费、多用户 SaaS'
      },
      {
        dim: 'Bot 形态',
        live: '持久名册、私聊、多 Bot 群、@ 点名、参与判断、异步交接',
        wip: '基于任务反馈的自主反思与经验复用',
        avoid: '用完即弃的对话框、中央裁决路由、轮数熔断'
      },
      {
        dim: '模型与工具',
        live: '多个 OpenAI 兼容端点；stdio 与 Streamable HTTP MCP；规则评分挑模型和思考等级',
        wip: '由 agent 自主决定模型、思考强度、工具和协作方式',
        avoid: '绑定单一厂商、供应商目录、假装兼容所有实现'
      },
      {
        dim: '安全与权限',
        live: '危险动作批准卡、钥匙串存密钥、Always allow 规则、私聊 Stop',
        wip: '更细粒度的 MCP 权限治理',
        avoid: '把 Bot 当安全沙箱、假装已具备完全自主权限'
      },
      {
        dim: '对话管理应用',
        live: '改人设、建 Bot 和群、配端点、模型名单和 MCP，都可由 Bot 通过工具完成',
        wip: '全部应用操作的对话覆盖（含首启向导）',
        avoid: '每件事都要手点深层菜单'
      }
    ],
    footnote: ['详细方向见', '；领域词汇以 ', ' 为准。']
  },
  quickstart: {
    heading: '下载，或从源码启动',
    intro: 'MIT 协议开源。Alpha 快照只有 macOS 且未签名；Windows 与 Linux 不在支持范围。',
    requirements: '需要 macOS、Node.js 22+、pnpm 12.3.4、Bun 1.2+、Rust / Cargo，以及 Tauri 的 macOS 前置依赖（含 Xcode Command Line Tools）。',
    step1: '克隆并安装依赖',
    step2: '并行启动守护进程与桌面窗',
    firstRun: [
      '准备一个已存在的本地目录作为共享工作区，建议独立于源码仓库。',
      '在设置里填工作区、OpenAI 兼容端点 URL 和 API key，配好模型名单与默认模型。',
      '通过侧栏创建第一个 Bot，填名称、职责和边界，开始私聊。',
      '让它创建其他 Bot、组群或提出 MCP 配置；需要批准时在应用里审核。'
    ],
    download: {
      title: '下载 Alpha 快照',
      body: '最新 GitHub Release 提供 Apple 芯片与 Intel 两种 .dmg。构建未签名：首次打开若被 Gatekeeper 拦截，右键选「打开」，或在终端执行：',
      link: '前往最新 Release',
      note: 'xattr -dr com.apple.quarantine "/Applications/Real Bot.app"'
    },
    linkDocs: '开发说明',
    linkManifesto: '设计理念',
    linkRoadmap: '路线图'
  },
  footer: {
    tagline: '本机 macOS 上的单人 agent 协作应用。',
    mit: 'MIT 协议开源。与 xAI / Grok 无官方附属关系。',
    contributors: 'Real Bot Contributors'
  },
  seo: {
    title: 'Real Bot — 在自己的电脑上，用对话组一支持久的 AI 队友',
    description:
      'macOS 本地单人 agent 协作应用：Bot 有名字、职责和边界，可以私聊、进群、被 @ 点名、彼此交接。窗口、运行时、会话和共享工作区都在本机，模型端点和 MCP 工具由你接入。MIT 开源，Alpha 阶段。',
    imageAlt: 'Real Bot：信使窗口里三个 Bot 在群里协作完成 report.md'
  },
  docs: {
    toc: '目录',
    manifestoTag: 'CONTEXT.md',
    manifestoIntro: '这份文档定义 Real Bot 的领域语言、架构决策和明确回避的反模式。页面在构建时直接由仓库根目录的 CONTEXT.md 生成。',
    roadmapTag: 'ROADMAP.md',
    roadmapIntro: 'Real Bot 的建设方向，不是稳定版承诺或交付时间表。页面在构建时直接由仓库根目录的 ROADMAP.md 生成。',
    backHome: '返回首页',
    toRoadmap: '查看路线图',
    toManifesto: '阅读设计理念'
  }
};

const en: Dict = {
  nav: {
    demo: 'Full walkthrough',
    boundaries: 'Boundaries',
    quickstart: 'Run from source',
    manifesto: 'Manifesto',
    roadmap: 'Roadmap',
    github: 'GitHub',
    switchLang: '中文',
    wip: 'Alpha',
    download: 'Download',
    menu: 'Menu',
    closeMenu: 'Close menu',
    theme: 'Appearance',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark'
  },
  hero: {
    headline: 'Persistent AI teammates, organized by conversation, on your own Mac.',
    headlineLines: ['Persistent AI teammates,', 'organized by conversation,', 'on your own Mac.'],
    subhead:
      'Bots have names, duties and boundaries. They chat one to one, join groups, get @mentioned and hand work to each other. The window, runtime, sessions and shared workspace live on your Mac; you plug in the model endpoints and MCP tools.',
    wipNote: 'Alpha: unsigned macOS snapshot. Features and data structures may still change.',
    ctaPrimary: 'Download alpha (macOS)',
    ctaSecondary: 'Run from source',
    runLabel: 'Runs locally',
    runCommand: 'pnpm install && pnpm dev',
    copy: 'Copy',
    copied: 'Copied',
    scrollHint: 'Scroll to watch the full flow'
  },
  demo: {
    heading: 'From an empty roster to a delivered report.md, in one pass',
    intro: 'The window on the right operates itself as you scroll. It is a reconstruction of the current app; every step maps to a feature that exists today, not a concept sketch.',
    railLabel: 'Walkthrough progress',
    steps: [
      {
        title: 'Set the workspace and a model endpoint',
        body:
          'Settings double as the setup wizard: one local folder as the shared workspace, plus at least one OpenAI-compatible endpoint. The model list records strengths, thinking levels and price, so the app can pick a model per task instead of asking you every turn.',
        callout: 'The API key goes in this field only. Never in chat.'
      },
      {
        title: 'Create the first bot',
        body:
          'Name, duties and boundaries are all required. The avatar is generated from the name. On save, one more face appears on the roster row and a direct chat opens. The roster has no cap and does not include you.',
        callout: 'The roster is the row of avatars at the top of the sidebar.'
      },
      {
        title: 'Let it hire the rest of the team',
        body:
          'Tell Coordinator who you need. It uses built-in tools to create Researcher and Writer, opens the group "Research" and pulls all three in. Creating bots, groups and configuration is one sentence in a chat.',
        callout: 'Bots can create bots, groups, endpoints and MCP servers.'
      },
      {
        title: 'Post the goal; unmentioned bots decide for themselves',
        body:
          'Send a message without @ and every bot present decides to join or pass; passing never enters the transcript. An @mention makes joining mandatory. The app does not arbitrate who speaks and has no turn-count breaker.',
        callout: 'Judgement: Researcher joins, the others pass.'
      },
      {
        title: 'Dangerous actions stop at an approval card',
        body:
          'Researcher wants an MCP server to fetch web pages. Adding MCP, adding endpoints, reading or writing outside the workspace and outbound network all wait for you; adding MCP can never be set to Always allow. Calls to configured tools run directly.',
        callout: 'Allow once or deny. Secrets never enter the transcript.'
      },
      {
        title: 'A handoff is just a message',
        body:
          'Researcher writes @Writer into its message and Writer wakes up to continue. Files written during the turn attach to the reply automatically; there is no separate artifact store.',
        callout: 'One workspace. Nothing copied, nothing isolated.'
      },
      {
        title: 'The output is in your workspace',
        body:
          'Open report.md and the preview panel shows a Monaco editor: line numbers, find, rendered Markdown or source. Edit and press Cmd+S to write back to the same path; ⌘O in the sidebar opens the whole folder tree.',
        callout: 'It writes a real file on disk.'
      },
      {
        title: 'Close the window; the daemon keeps going',
        body:
          'The window hides in the tray and running turns continue. Stop in a direct chat ends the current turn immediately; in a group you stop bots by telling them. Only Cmd+Q or Quit in the tray ends the window and the daemon.',
        callout: 'Closing hides. It does not quit.'
      }
    ]
  },
  mock: {
    windowTitle: 'Real Bot',
    roster: 'Roster',
    addBot: 'New bot',
    search: 'Search sessions, messages, files, routines',
    groups: 'Groups',
    youBot: 'You ↔ Bot',
    workspace: 'Workspace',
    settings: 'Settings',
    emptyRoster: 'The roster is empty. Use + on the roster row to create a bot.',
    welcome: 'Start chatting with Coordinator',
    starters: ['What can you help me with?', 'List files in the workspace', 'Start a new task'],
    composerPlaceholder: 'Message, @ to mention a teammate',
    sendHint: 'Enter ↵ to send · Shift+Enter for a new line',
    replying: 'replying',
    groupSettings: 'Group settings',
    botSettings: 'Bot settings',
    members: (n) => `${n} members`,
    pendingApproval: 'Approval',
    unread: 'Unread',
    settingsTitle: 'Settings',
    settingsTabs: ['General', 'Models', 'MCP'],
    wizardHint: 'Setup is the empty settings state: a workspace path plus one endpoint URL and key completes it.',
    workspaceLabel: 'Workspace folder',
    endpointLabel: 'Endpoint',
    endpointName: 'Name',
    endpointUrlLabel: 'URL',
    endpointKeyLabel: 'Endpoint key',
    keySet: 'Set',
    keyHint: 'Stored in Keychain, not in SQLite.',
    modelsLabel: 'Model list',
    modelCols: { strengths: 'Strengths', thinking: 'Thinking', price: 'Price' },
    save: 'Save',
    newBot: 'New bot',
    fieldName: 'Name',
    fieldDuties: 'Duties',
    fieldBoundaries: 'Boundaries',
    fieldAvatar: 'Avatar',
    avatarRefresh: 'Shuffle',
    approvalTitle: (bot) => `${bot} wants to add an MCP server`,
    approvalKind: 'Kind',
    approvalKindValue: 'Add MCP (approve every time)',
    approvalName: 'Name',
    approvalTransport: 'Transport',
    approvalCommand: 'Command',
    approvalNoAlways: 'No Always allow for this kind.',
    allowOnce: 'Allow once',
    deny: 'Deny',
    allowed: 'Allowed',
    previewTitle: 'Artifact preview',
    previewRendered: 'Rendered',
    previewSource: 'Source',
    previewSave: 'Save',
    previewUnsaved: 'Unsaved',
    previewSaved: 'Saved to report.md',
    trayHidden: 'Window hidden in the tray. Turns keep running.',
    trayTurns: 'running',
    trayShow: 'Show window',
    trayStop: 'Stop',
    trayQuit: 'Quit',
    judgementJoin: 'join',
    judgementPass: 'pass',
    judgementLabel: 'Judgement'
  },
  bots: {
    coordinator: {
      name: 'Coordinator',
      duties: 'Coordinate research and writing; split tasks and hand off',
      boundaries: 'No deep research itself; asks before anything that needs approval'
    },
    researcher: {
      name: 'Researcher',
      duties: 'Deep research and fact checking',
      boundaries: 'Organizes and verifies only; never rewords conclusions'
    },
    writer: {
      name: 'Writer',
      duties: 'Draft and format report.md',
      boundaries: 'Keeps Researcher’s verified conclusions; never changes numbers'
    }
  },
  script: {
    groupName: 'Research',
    workspacePath: '/Users/you/real-bot-workspace',
    endpointName: 'Local vLLM',
    endpointUrl: 'http://127.0.0.1:8000/v1',
    models: [
      { name: 'qwen3-32b', strengths: 'writing, analysis', thinking: 'low / medium / high', price: '$0.15 / M' },
      { name: 'deepseek-v3.2', strengths: 'coding, tool calls', thinking: 'none / low', price: '$0.28 / M' },
      { name: 'glm-4.6-flash', strengths: 'summaries, judgement', thinking: 'none', price: '$0.02 / M' }
    ],
    userCreateTeam:
      'Create two teammates: Researcher for deep research and verification, Writer for drafting report.md. Put the three of you in a group called "Research".',
    coordinatorCreated:
      'Created Researcher and Writer and opened the group "Research" with all three of us in it. To start, just state the goal in the group.',
    userGroupGoal: 'Turn brief.md in the workspace into report.md. Hand off to each other directly; no need to wait for me.',
    researcherRead: 'Read brief.md. Two of the three questions cite numbers from external annual reports; I need to fetch the pages to verify before summarizing.',
    researcherHandoff: ['Numbers verified; conclusions are in notes/brief-summary.md.', ' please draft report.md from it, structured around the brief’s three questions.'],
    researcherNotePath: 'notes/brief-summary.md',
    writerDone: 'Wrote report.md, six sections. Conclusions follow the verified notes; no numbers changed.',
    reportPath: 'report.md',
    coordinatorClose: 'Checked report.md against brief.md: all three questions answered, numbers match the verification. Ready to deliver.',
    reportLines: [
      '# Research report',
      '',
      '> Based on brief.md and notes/brief-summary.md',
      '',
      '## 1. Background',
      '',
      'Over the last two years local collaboration tools moved',
      'from one-off chats to persistent teammates. The brief’s',
      'three questions all concern that shift.',
      '',
      '## 2. Question one: who uses them',
      '',
      'The annual report puts individual developers at 61%, up 9 pt.'
    ],
    reportEditLine: '> Verified by Researcher, 2026-09-17'
  },
  boundaries: {
    heading: 'What is live, what is being built, what we will not do',
    intro: '"Live" means the code exists. It does not mean every model, tool combination or full task path has been accepted in a real environment.',
    colLive: 'Live',
    colWip: 'In progress',
    colAvoid: 'Not doing',
    rows: [
      {
        dim: 'Runtime',
        live: 'macOS window, resident daemon, local shared workspace, SQLite state',
        wip: 'Long-running stability in complex real-world scenarios',
        avoid: 'Cloud VMs, cloud billing, multi-user SaaS'
      },
      {
        dim: 'Bots',
        live: 'Persistent roster, direct chats, multi-bot groups, @mentions, judgement, async handoffs',
        wip: 'Self-reflection and experience reuse driven by task feedback',
        avoid: 'Disposable chat boxes, a central dispatcher, turn-count breakers'
      },
      {
        dim: 'Models and tools',
        live: 'Multiple OpenAI-compatible endpoints; stdio and Streamable HTTP MCP; rule-based model and thinking-level selection',
        wip: 'Agent-led choice of model, thinking effort, tools and collaboration',
        avoid: 'Vendor lock-in, a provider catalogue, pretending every implementation is compatible'
      },
      {
        dim: 'Safety and permissions',
        live: 'Approval cards for dangerous actions, Keychain secrets, Always allow rules, Stop in direct chats',
        wip: 'Finer-grained MCP permission policies',
        avoid: 'Treating bots as security sandboxes, pretending full autonomy is safe'
      },
      {
        dim: 'Managing the app by chat',
        live: 'Bots edit profiles, create bots and groups, configure endpoints, model lists and MCP through tools',
        wip: 'Conversational coverage of every operation, including first-run setup',
        avoid: 'Deep menus for everyday configuration'
      }
    ],
    footnote: ['See the ', ' for direction; ', ' is the source of truth for vocabulary.']
  },
  quickstart: {
    heading: 'Download, or run from source',
    intro: 'Open source under MIT. The alpha snapshot is macOS only and unsigned; Windows and Linux are out of scope.',
    requirements: 'Requires macOS, Node.js 22+, pnpm 12.3.4, Bun 1.2+, Rust / Cargo and the Tauri macOS prerequisites (including Xcode Command Line Tools).',
    step1: 'Clone and install',
    step2: 'Start the daemon and the desktop window in parallel',
    firstRun: [
      'Prepare an existing local folder as the shared workspace, ideally outside the source checkout.',
      'In Settings, enter the workspace, an OpenAI-compatible endpoint URL and API key, then the model list and default model.',
      'Create the first bot from the sidebar with a name, duties and boundaries, and open a direct chat.',
      'Ask it to create other bots, form groups or propose MCP configuration; approve dangerous actions in the app.'
    ],
    download: {
      title: 'Download the alpha snapshot',
      body: 'The latest GitHub Release ships .dmg files for Apple silicon and Intel. The build is unsigned: if Gatekeeper blocks the first launch, right-click and choose Open, or run:',
      link: 'Go to the latest release',
      note: 'xattr -dr com.apple.quarantine "/Applications/Real Bot.app"'
    },
    linkDocs: 'Development guide',
    linkManifesto: 'Manifesto',
    linkRoadmap: 'Roadmap'
  },
  footer: {
    tagline: 'A single-user agent collaboration app for your Mac.',
    mit: 'Open source under MIT. Not affiliated with xAI / Grok.',
    contributors: 'Real Bot Contributors'
  },
  seo: {
    title: 'Real Bot — Persistent AI teammates, organized by conversation, on your own Mac',
    description:
      'A single-user agent collaboration app for macOS. Bots have names, duties and boundaries; they chat one to one, join groups, get @mentioned and hand work to each other. Window, runtime, sessions and shared workspace stay on your Mac; you plug in the model endpoints and MCP tools. MIT, alpha.',
    imageAlt: 'Real Bot: three bots collaborating on report.md in a group chat window'
  },
  docs: {
    toc: 'Contents',
    manifestoTag: 'CONTEXT.md',
    manifestoIntro: 'This document defines Real Bot’s domain language, architectural decisions and the anti-patterns it avoids. The page is generated at build time from CONTEXT.md at the repository root.',
    roadmapTag: 'ROADMAP.md',
    roadmapIntro: 'Where Real Bot is heading. Not a stable-release promise or a delivery schedule. Generated at build time from ROADMAP.md at the repository root.',
    backHome: 'Back to home',
    toRoadmap: 'View the roadmap',
    toManifesto: 'Read the manifesto'
  }
};

export const DICT: Record<Lang, Dict> = { zh, en };
