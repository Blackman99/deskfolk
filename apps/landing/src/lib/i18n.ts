import type { DocsNavGroupId, DocsPageKey } from './docs';

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
    defaultModel: string;
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
    previewRendered: string;
    previewSource: string;
    previewSaved: string;
    trayHidden: string;
    trayTurns: string;
    trayShow: string;
    trayStop: string;
    trayQuit: string;
    trayTerminal: (command: string) => string;
    bannerNow: string;
    judgementJoin: string;
    judgementPass: string;
    judgementLabel: string;
    trace: string;
    pin: string;
    more: string;
    artifactsOf: (name: string) => string;
    flowOf: (name: string) => string;
    flowFeedback: string;
    flowBlamed: string;
    flowWatched: (n: number) => string;
    flowDone: string;
    flowRunning: string;
    flowWhy: string;
    thinking: string;
    you: string;
    /** Up, down, left, right. */
    split: [string, string, string, string];
    emptyTitle: string;
    emptyHint: string;
    emptyFilter: string;
    /** New terminal, workspace, routines. */
    emptyItems: [string, string, string];
    emptyReattach: string;
    emptyNoReattach: string;
    terminalStop: string;
    terminalEnd: string;
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
    briefPath: string;
    /** The job's title, as the flow board's switcher shows it. */
    jobTitle: string;
    /** What the model picker chose for each Bot's turn, and why. */
    routes: Record<BotId, { model: string; thinking: string; kind: string; reason: string; exec: string }>;
    command: string;
    commandOutput: string[];
    commandTook: string;
    terminalFolder: string;
    terminalCommand: string;
    terminalOutput: string[];
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
    onThisPage: string;
    source: string;
    navLabel: string;
    manifestoTag: string;
    manifestoIntro: string;
    manifestoIndexHeading: string;
    manifestoIndexLead: string;
    roadmapTag: string;
    roadmapIntro: string;
    pagerPrev: string;
    pagerNext: string;
    navGroup: Record<DocsNavGroupId, string>;
    pages: Record<DocsPageKey, { title: string; blurb: string }>;
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
      'Bot 有名字、职责和边界，可以私聊、进群、被 @ 点名、彼此交接；一件事一张流程图，每一轮用的模型都说得出理由。窗口、运行时、会话和共享工作区都在你的 Mac 上；模型端点和 MCP 工具由你接入。',
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
        title: '先选工作区和模型端点',
        body:
          '设置就是向导：一个本机目录做共享工作区，再加至少一个 OpenAI 兼容端点。端点下已启用的模型各占一行，写清擅长领域、思考等级和价格，点一行就设成默认。之后每开一轮由 agent 按任务挑模型和思考等级并留下一句理由，你不用每轮自选。',
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
          '你发一条不带 @ 的消息，在场的每个 Bot 各自决定下场还是旁观；旁观不进主转录。用 @ 点名则必须下场。应用不代你裁决谁说话，也没有轮数熔断。下场的那位，名字旁标着这一轮用的模型。',
        callout: '参与判断：Researcher 下场，其余旁观。'
      },
      {
        title: '危险动作停在批准卡上',
        body:
          'Researcher 想加一个 MCP 服务器来抓网页。新增 MCP、新建端点、工作区外读写和出站网络都要你放行；新增 MCP 这一类不能 Always allow。已配好的工具调用则直接执行。在等你的事标在侧栏这条会话上，没有另开的通知页。',
        callout: '允许一次或拒绝。密钥不进转录。'
      },
      {
        title: '交接就是发消息，命令看得见',
        body:
          'Researcher 跑脚本核对数字，输出就在它那一行下面边跑边滚，跑完折成一行。整理完它把 @Writer 写进消息，Writer 被叫醒接着干。本轮写出的工作区文件自动挂在回复上，没有另一套产物库。',
        callout: '跑完折成一行：命令 · 退出码 · 耗时。'
      },
      {
        title: '产物在旁边一块窗格里打开',
        body:
          '点开 report.md，主栏分出一块窗格，标签叫「调研的产物」：左边是这件事引用过的文件，右边是 Monaco 编辑器，行号、查找、折叠，Markdown 在渲染和源码之间切换。改完 ⌘S 写回同一路径。一条会话只有一块预览，再点别的文件就换到它。',
        callout: '写回的是磁盘上的真文件。'
      },
      {
        title: '一件事是一张流程图',
        body:
          '会话窗格窄了，顶栏按钮收进 ⋯。点「经过」，这件事按谁叫醒了谁画出来：一轮一张卡片，交出的文件挂在卡片上。Bot 卡片底下一行是这一轮的模型、思考等级和消息类别，开轮前由 agent 挑定；点开看它为什么这么挑、走了几跳。纠正链结束时的复盘也记在这里，只有判成模型的问题才留成这个 Bot 的经验。',
        callout: '每轮挑的模型和理由，记在这一轮的卡片上。'
      },
      {
        title: '分出一块，开你自己的终端',
        body:
          '在任意窗格里右键，可以向上下左右分割；新的空窗格列着新终端、工作区和日程。开一个终端跑 pnpm dev：这是你自己的 shell，不走批准，Bot 也碰不到。当前窗格描一圈强调色；排法只记在这台 Mac 上，退出再开，分屏和终端都回来。',
        callout: '关掉终端标签不杀进程，从「＋」接回。'
      },
      {
        title: '关窗不停，等你的事会来找你',
        body:
          '窗口藏进托盘，进行中的轮次和终端里的 pnpm dev 都接着跑。Coordinator 复核完，macOS 横幅点开就是这条会话；Dock 角标只数你没看过的和还在等你的。私聊里的 Stop 立即停掉眼前这一轮；Cmd+Q 或托盘「退出」才结束窗口和守护进程。',
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
    pendingApproval: '待批准',
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
    defaultModel: '默认',
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
    previewRendered: '渲染',
    previewSource: '源码',
    previewSaved: '已保存到 report.md',
    trayHidden: '窗口已隐藏到托盘，轮次继续。',
    trayTurns: '进行中',
    trayShow: '显示窗口',
    trayStop: 'Stop',
    trayQuit: '退出',
    trayTerminal: (command) => `终端 · ${command} 还在跑`,
    bannerNow: '现在',
    judgementJoin: '下场',
    judgementPass: '旁观',
    judgementLabel: '参与判断',
    trace: '经过',
    pin: '置顶',
    more: '更多会话操作',
    artifactsOf: (name) => `${name}的产物`,
    flowOf: (name) => `${name}流程`,
    flowFeedback: '有反馈',
    flowBlamed: '归咎模型',
    flowWatched: (n) => `${n} 人旁观`,
    flowDone: '完成',
    flowRunning: '进行中',
    flowWhy: '为什么选它',
    thinking: '思考',
    you: '你',
    split: ['向上分割', '向下分割', '向左分割', '向右分割'],
    emptyTitle: '这个窗格还没有内容',
    emptyHint: '从侧栏点一条会话放进来，或者从下面挑一个。',
    emptyFilter: '按名字或路径找',
    emptyItems: ['新终端', '工作区', '日程图'],
    emptyReattach: '可接回',
    emptyNoReattach: '没有可接回的终端',
    terminalStop: '停止',
    terminalEnd: '结束会话'
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
    reportEditLine: '> 核验：Researcher，2026-09-17',
    briefPath: 'brief.md',
    jobTitle: '围绕 brief.md 完成 report.md',
    routes: {
      researcher: {
        model: 'deepseek-v3.2',
        thinking: '低',
        kind: '推理',
        reason: '要调抓取工具、跑脚本核对年报数字，工具调用多；deepseek-v3.2 擅长工具调用，思考给低档就够。',
        exec: '3 跳 · 0 次工具错误 · 46s'
      },
      writer: {
        model: 'qwen3-32b',
        thinking: '中',
        kind: '写作',
        reason: '照着核验结论起草六节中文报告；qwen3-32b 擅长中文写作。',
        exec: '2 跳 · 0 次工具错误 · 1m12s'
      },
      coordinator: {
        model: 'qwen3-32b',
        thinking: '低',
        kind: '推理',
        reason: '对照 brief.md 逐条复核，读得多写得少。',
        exec: '进行中'
      }
    },
    command: 'python3 scripts/check_numbers.py brief.md',
    commandOutput: [
      '读取 notes/fetched/annual-report-2025.md',
      '个人开发者占比 61% · brief 写 61% ✓',
      '同比 +9 pt · brief 写 +9 pt ✓',
      '2 / 2 个数字一致'
    ],
    commandTook: '3.1s',
    terminalFolder: 'real-bot-workspace',
    terminalCommand: 'pnpm dev',
    terminalOutput: [
      '> report-site@0.1.0 dev',
      '> vite',
      '',
      '  VITE v7.1.3  ready in 412 ms',
      '',
      '  ➜  Local:   http://localhost:5173/'
    ]
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
        live: 'macOS 桌面窗、常驻守护进程、本地共享工作区、SQLite 持久化；关窗不停，你自己的终端会话也由守护进程持有',
        wip: '复杂真实场景下的长期稳定性验证',
        avoid: '云电脑、云端计费、多用户 SaaS'
      },
      {
        dim: '桌面工作台',
        live: '主栏任意分屏，标签装会话、终端、日程图或工作区；一件事一张流程图；等你的事标在会话列表上，macOS 横幅与 Dock 角标',
        wip: '几条会话同时可见时，只有当前那条会报在线，其余仍可能弹一次横幅',
        avoid: '多窗口进程、手机上分屏'
      },
      {
        dim: 'Bot 形态',
        live: '持久名册、私聊、多 Bot 群、@ 点名、参与判断、异步交接；纠正链结束后自动复盘，结论留成该 Bot 的经验',
        wip: '验证经验复用是否真的让选择更准、完成更快',
        avoid: '用完即弃的对话框、中央裁决路由、轮数熔断'
      },
      {
        dim: '模型与工具',
        live: '多个 OpenAI 兼容端点；stdio 与 Streamable HTTP MCP；开轮前由 agent 挑模型和思考等级并给出理由，规则兜底，记在流程图那一轮的卡片上',
        wip: '工具和协作方式也由 agent 开轮前决定',
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
        live: '改人设和技能、建 Bot 和群、配端点、模型名单和 MCP，都可由 Bot 通过工具完成',
        wip: '全部应用操作的对话覆盖（含首启向导）',
        avoid: '每件事都要手点深层菜单'
      },
      {
        dim: '远程访问',
        live: '默认关闭的实验原型：自托管中继、Noise 加密链路与手机 PWA，可做隔离集成测试',
        wip: '独立安全复核，真机主屏幕 WebAuthn 与 Web Push 验收；在这之前公网配对保持关闭',
        avoid: '项目方运营的云端中继、把实验原型当成可用的远控'
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
      '选一个本机目录作为共享工作区，建议独立于源码仓库；不存在会自动创建。',
      '在设置里选择工作区文件夹，再填 OpenAI 兼容端点 URL 和 API key，配好模型名单与默认模型。',
      '通过侧栏创建第一个 Bot，填名称、职责和边界，开始私聊。',
      '让它创建其他 Bot、组群或提出 MCP 配置；需要批准时在应用里审核。'
    ],
    download: {
      title: '下载 Alpha 快照',
      body: '最新 GitHub Release 提供 Apple 芯片与 Intel 两种 .dmg。构建未签名：首次打开若被 Gatekeeper 拦截，右键选「打开」，或在终端执行（完整 FAQ：docs/gatekeeper.zh.md；昂贵动作仍会先问你）：',
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
      'macOS 本地单人 agent 协作应用：Bot 有名字、职责和边界，可以私聊、进群、被 @ 点名、彼此交接；一件事一张流程图，桌面窗能分屏开终端。窗口、运行时、会话和共享工作区都在本机，模型端点和 MCP 工具由你接入。MIT 开源，Alpha 阶段。',
    imageAlt: 'Real Bot：信使窗口里三个 Bot 在群里协作完成 report.md'
  },
  docs: {
    onThisPage: '本页',
    source: '源文件',
    navLabel: '文档',
    manifestoTag: 'CONTEXT.md',
    manifestoIntro:
      '领域语言与明确回避的反模式。源文件仍是仓库根目录的 CONTEXT.md；站点按主题拆页，不另写一份词汇。',
    manifestoIndexHeading: '按主题读术语',
    manifestoIndexLead: '每个主题一页。点开后左侧是整份文档导航，右侧是本页术语。',
    roadmapTag: 'ROADMAP.md',
    roadmapIntro: 'Real Bot 的建设方向，不是稳定版承诺或交付时间表。页面在构建时直接由仓库根目录的 ROADMAP.md 生成。',
    pagerPrev: '上一页',
    pagerNext: '下一页',
    navGroup: {
      language: '领域语言',
      direction: '方向'
    },
    pages: {
      manifesto: { title: '概述', blurb: '这份语言管什么、不管什么。' },
      people: { title: '人与名册', blurb: 'Bot、你、人设、归档。' },
      conversations: { title: '会话', blurb: '群、私聊、线程、回应。' },
      collaboration: { title: '协作', blurb: '点名、判断、交接、轮次。' },
      workspace: { title: '工作区', blurb: '共享目录、产物、附件、搜索。' },
      runtime: { title: '运行时', blurb: '窗与窗格、守护进程、托盘、终端、本机接口。' },
      models: { title: '模型与工具', blurb: '端点、MCP、日程、技能、上下文与花费。' },
      safety: { title: '批准与边界', blurb: '危险动作、壳、Always allow。' },
      roadmap: { title: '路线图', blurb: '建设方向，不是交付时间表。' }
    }
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
      'Bots have names, duties and boundaries. They chat one to one, join groups, get @mentioned and hand work to each other; every job reads as a flow, and every turn can say why it ran on the model it did. The window, runtime, sessions and shared workspace live on your Mac; you plug in the model endpoints and MCP tools.',
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
          'Settings double as the setup wizard: one local folder as the shared workspace, plus at least one OpenAI-compatible endpoint. Each enabled model on an endpoint is its own row, with strengths, thinking levels and price; click a row to make it the default. From then on an agent picks the model and thinking level for each turn — and leaves a reason — instead of asking you every time.',
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
          'Send a message without @ and every bot present decides to join or pass; passing never enters the transcript. An @mention makes joining mandatory. The app does not arbitrate who speaks and has no turn-count breaker. The one who joins has the model its turn runs on beside its name.',
        callout: 'Judgement: Researcher joins, the others pass.'
      },
      {
        title: 'Dangerous actions stop at an approval card',
        body:
          'Researcher wants an MCP server to fetch web pages. Adding MCP, adding endpoints, reading or writing outside the workspace and outbound network all wait for you; adding MCP can never be set to Always allow. Calls to configured tools run directly. What waits on you is marked on the conversation in the sidebar; there is no separate notifications page.',
        callout: 'Allow once or deny. Secrets never enter the transcript.'
      },
      {
        title: 'A handoff is just a message, and commands show',
        body:
          'Researcher runs a script to check the figures; its output scrolls under that line while it runs, then folds to one line. Done, it writes @Writer into its message and Writer wakes up to continue. Files written during the turn attach to the reply automatically; there is no separate artifact store.',
        callout: 'It folds to one line: command · exit code · how long.'
      },
      {
        title: 'The output opens in a pane beside it',
        body:
          'Open report.md and the main column splits off a pane for it, in a tab named "Research\'s artifacts": the files this job touched on the left, a Monaco editor on the right with line numbers, find, folding, and Markdown switching between rendered and source. Edit and press ⌘S to write back to the same path. A conversation has one preview; opening another file turns it to that one.',
        callout: 'It writes a real file on disk.'
      },
      {
        title: 'One job reads as a flow',
        body:
          'The conversation pane is narrow now, so its header actions fold into ⋯. Pick Trace and the job is drawn by who woke whom: a card per turn, with the files it handed over on the card. Under each Bot card is the model, thinking level and message kind its turn ran on, picked by an agent before the turn; click it for why, and how many hops it took. The review at the end of a correction lands here too, and only a verdict against the model becomes that Bot\'s experience.',
        callout: 'The model each turn ran on, and why, sits on its card.'
      },
      {
        title: 'Split off a pane for your own terminal',
        body:
          'Right-click anywhere in a pane to split it up, down, left or right; the new empty pane offers New terminal, Workspace and Routines. Start a terminal and run pnpm dev: it is your own shell, it needs no approval, and no Bot can touch it. The current pane is framed in the accent colour; the layout is remembered on this Mac, and Quit and reopen brings back the split and the terminal.',
        callout: 'Closing a terminal tab leaves it running; reattach from "+".'
      },
      {
        title: 'Close the window; what waits on you finds you',
        body:
          'The window hides in the tray, and running turns and the pnpm dev in the terminal carry on. When Coordinator finishes its check, a macOS banner opens straight to that conversation, and the Dock badge counts only what you have not seen plus what is still waiting on you. Stop in a direct chat ends the current turn immediately; only Cmd+Q or Quit in the tray ends the window and the daemon.',
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
    defaultModel: 'Default',
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
    previewRendered: 'Rendered',
    previewSource: 'Source',
    previewSaved: 'Saved to report.md',
    trayHidden: 'Window hidden in the tray. Turns keep running.',
    trayTurns: 'running',
    trayShow: 'Show window',
    trayStop: 'Stop',
    trayQuit: 'Quit',
    trayTerminal: (command) => `Terminal · ${command} still running`,
    bannerNow: 'now',
    judgementJoin: 'join',
    judgementPass: 'pass',
    judgementLabel: 'Judgement',
    trace: 'Trace',
    pin: 'Pin',
    more: 'More conversation actions',
    artifactsOf: (name) => `${name}'s artifacts`,
    flowOf: (name) => `${name} flow`,
    flowFeedback: 'Feedback',
    flowBlamed: 'Model blamed',
    flowWatched: (n) => `${n} watched`,
    flowDone: 'Done',
    flowRunning: 'In progress',
    flowWhy: 'Why this model',
    thinking: 'thinking',
    you: 'You',
    split: ['Split up', 'Split down', 'Split left', 'Split right'],
    emptyTitle: 'Nothing open in this pane',
    emptyHint: 'Open a conversation from the sidebar, or pick one of these.',
    emptyFilter: 'Find by name or path',
    emptyItems: ['New terminal', 'Workspace', 'Routine calendar'],
    emptyReattach: 'Reattach',
    emptyNoReattach: 'No terminal to reattach',
    terminalStop: 'Stop',
    terminalEnd: 'End session'
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
    reportEditLine: '> Verified by Researcher, 2026-09-17',
    briefPath: 'brief.md',
    jobTitle: 'Turn brief.md into report.md',
    routes: {
      researcher: {
        model: 'deepseek-v3.2',
        thinking: 'low',
        kind: 'reasoning',
        reason: 'Calls the fetch tool and runs a script to check annual-report figures — heavy on tool calls. deepseek-v3.2 is strong at them; low thinking is enough.',
        exec: '3 hops · 0 tool errors · 46s'
      },
      writer: {
        model: 'qwen3-32b',
        thinking: 'medium',
        kind: 'writing',
        reason: 'Drafts a six-section report from the verified notes; qwen3-32b is strong at writing.',
        exec: '2 hops · 0 tool errors · 1m12s'
      },
      coordinator: {
        model: 'qwen3-32b',
        thinking: 'low',
        kind: 'reasoning',
        reason: 'Checks report.md against brief.md point by point: a lot of reading, little writing.',
        exec: 'in progress'
      }
    },
    command: 'python3 scripts/check_numbers.py brief.md',
    commandOutput: [
      'read notes/fetched/annual-report-2025.md',
      'individual developers 61% · brief says 61% ✓',
      'year on year +9 pt · brief says +9 pt ✓',
      '2 / 2 figures match'
    ],
    commandTook: '3.1s',
    terminalFolder: 'real-bot-workspace',
    terminalCommand: 'pnpm dev',
    terminalOutput: [
      '> report-site@0.1.0 dev',
      '> vite',
      '',
      '  VITE v7.1.3  ready in 412 ms',
      '',
      '  ➜  Local:   http://localhost:5173/'
    ]
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
        live: 'macOS window, resident daemon, local shared workspace, SQLite state; closing the window stops nothing, and the daemon holds your own terminal sessions too',
        wip: 'Long-running stability in complex real-world scenarios',
        avoid: 'Cloud VMs, cloud billing, multi-user SaaS'
      },
      {
        dim: 'Desktop workbench',
        live: 'Split the main column any way; tabs hold a conversation, a terminal, the routine calendar or the workspace; one flow per job; what waits on you marked on the conversation list, with macOS banners and a Dock badge',
        wip: 'With several conversations on screen only the current one reports presence, so the others can still post a banner once',
        avoid: 'Multiple window processes, split panes on a phone'
      },
      {
        dim: 'Bots',
        live: 'Persistent roster, direct chats, multi-bot groups, @mentions, judgement, async handoffs; a review at the end of a correction, kept as that bot\'s experience',
        wip: 'Measuring whether reused experience actually picks better and finishes faster',
        avoid: 'Disposable chat boxes, a central dispatcher, turn-count breakers'
      },
      {
        dim: 'Models and tools',
        live: 'Multiple OpenAI-compatible endpoints; stdio and Streamable HTTP MCP; an agent picks the model and thinking level before each turn and says why, with rules as the fallback, kept on that turn\'s card in the flow',
        wip: 'Agent-led choice of tools and collaboration, decided before the turn too',
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
        live: 'Bots edit profiles and skills, create bots and groups, configure endpoints, model lists and MCP through tools',
        wip: 'Conversational coverage of every operation, including first-run setup',
        avoid: 'Deep menus for everyday configuration'
      },
      {
        dim: 'Remote access',
        live: 'A default-off experimental prototype: a self-hosted relay, a Noise-encrypted link and a phone PWA, for isolated integration testing',
        wip: 'Independent security review, and real-device home-screen WebAuthn and Web Push; public pairing stays off until then',
        avoid: 'A project-run cloud relay, passing a prototype off as working remote access'
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
      'Pick a local folder as the shared workspace, ideally outside the source checkout; missing folders are created.',
      'In Settings, choose a workspace folder, then enter an OpenAI-compatible endpoint URL and API key, then the model list and default model.',
      'Create the first bot from the sidebar with a name, duties and boundaries, and open a direct chat.',
      'Ask it to create other bots, form groups or propose MCP configuration; approve dangerous actions in the app.'
    ],
    download: {
      title: 'Download the alpha snapshot',
      body: 'The latest GitHub Release ships .dmg files for Apple silicon and Intel. The build is unsigned: if Gatekeeper blocks the first launch, right-click and choose Open, or run (full FAQ: docs/gatekeeper.md; expensive actions still ask first):',
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
      'A single-user agent collaboration app for macOS. Bots have names, duties and boundaries; they chat one to one, join groups, get @mentioned and hand work to each other. Every job reads as a flow, and the window splits into panes with your own terminal. Window, runtime, sessions and shared workspace stay on your Mac; you plug in the model endpoints and MCP tools. MIT, alpha.',
    imageAlt: 'Real Bot: three bots collaborating on report.md in a group chat window'
  },
  docs: {
    onThisPage: 'On this page',
    source: 'Source',
    navLabel: 'Docs',
    manifestoTag: 'CONTEXT.md',
    manifestoIntro:
      'The domain language and the anti-patterns it avoids. The source is still CONTEXT.md at the repository root; this site splits it by topic instead of rewriting the glossary.',
    manifestoIndexHeading: 'Terms by topic',
    manifestoIndexLead: 'One page per topic. The left rail is the whole docs tree; the right rail is this page.',
    roadmapTag: 'ROADMAP.md',
    roadmapIntro: 'Where Real Bot is heading. Not a stable-release promise or a delivery schedule. Generated at build time from ROADMAP.md at the repository root.',
    pagerPrev: 'Previous',
    pagerNext: 'Next',
    navGroup: {
      language: 'Language',
      direction: 'Direction'
    },
    pages: {
      manifesto: { title: 'Overview', blurb: 'What this language covers, and what it does not.' },
      people: { title: 'People and roster', blurb: 'Bots, you, profiles, archive.' },
      conversations: { title: 'Sessions', blurb: 'Groups, directs, threads, reactions.' },
      collaboration: { title: 'Collaboration', blurb: 'Mentions, judgement, handoffs, turns.' },
      workspace: { title: 'Workspace', blurb: 'Shared folder, artifacts, attachments, search.' },
      runtime: { title: 'Runtime', blurb: 'Window and panes, daemon, tray, terminal, local API.' },
      models: { title: 'Models and tools', blurb: 'Endpoints, MCP, routines, skills, context, spend.' },
      safety: { title: 'Approval and bounds', blurb: 'Dangerous actions, shells, Always allow.' },
      roadmap: { title: 'Roadmap', blurb: 'Direction, not a delivery schedule.' }
    }
  }
};

export const DICT: Record<Lang, Dict> = { zh, en };
