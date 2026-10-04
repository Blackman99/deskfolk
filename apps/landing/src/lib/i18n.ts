import type { DocsNavGroupId, DocsPageKey } from './docs';

export type Lang = 'zh' | 'en';

export type StepCopy = {
  title: string;
  body: string;
  callout: string;
  /** A docs page that takes the step further. */
  link?: { label: string; page: DocsPageKey };
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
    docs: string;
    glossary: string;
    roadmap: string;
    remote: string;
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
    /** What kind of job and who it is for; the trust list below says how. */
    subhead: string;
    /** Heading of the list below the subhead: the one line the list makes good on. */
    trustLabel: string;
    /** What the headline's promise rests on, one guarantee per item, each with the failure it came out of. */
    trust: { label: string; body: string }[];
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
    /** What the first screen's still shows, for screen readers. */
    stillLabel: string;
    /** On a step whose clip has not played yet on this visit (autoplay refused, or scrolled back up to). */
    play: string;
    replay: string;
    /** Opens the step's clip bigger than the stage. */
    enlarge: string;
  };
  /** The full demo film (static/media/deskfolk-<lang>.mp4), played in a dialog. */
  film: {
    /** On the first screen's still. */
    watch: string;
    /** Beside the scroll hint. */
    watchHint: string;
    /** The film's length, shown beside both entries; change it with the film. */
    duration: string;
    title: string;
    description: string;
    close: string;
  };
  boundaries: {
    heading: string;
    intro: string;
    colLive: string;
    colWip: string;
    colAvoid: string;
    rows: BoundaryRow[];
    /** [before roadmap link, between roadmap and glossary links, after] */
    footnote: [string, string, string];
  };
  quickstart: {
    heading: string;
    intro: string;
    requirements: string;
    step1: string;
    step2: string;
    firstRun: string[];
    download: { title: string; body: string; link: string; note: string; faq: string; windows: string };
    linkDocs: string;
    linkDocsSite: string;
    linkGlossary: string;
    linkRoadmap: string;
    linkRemote: string;
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
    experimentalTag: string;
    /** "Built from main · latest release vX": the site follows main, the download is a release. */
    editionMain: string;
    editionLatest: string;
    editionTitle: string;
    manifestoIndexHeading: string;
    manifestoIndexLead: string;
    /** Label that opens a term's avoid line (the source writes `_Avoid_:`). */
    avoidLabel: string;
    avoidToggle: string;
    avoidToggleHint: string;
    behaviorSummary: string;
    searchLabel: string;
    searchPlaceholder: string;
    searchLoading: string;
    /** `{q}` is the query. */
    searchEmpty: string;
    pagerPrev: string;
    pagerNext: string;
    navGroup: Record<DocsNavGroupId, string>;
    /** `intro` leads the page and is its meta description; the blurb stands in where there is none. */
    pages: Record<DocsPageKey, { title: string; blurb: string; intro?: string }>;
  };
  error: {
    notFound: string;
    generic: string;
    body: string;
    home: string;
    docs: string;
  };
};

const zh: Dict = {
  nav: {
    demo: '完整流程',
    boundaries: '边界',
    quickstart: '从源码启动',
    docs: '文档',
    glossary: '术语表',
    roadmap: '路线图',
    remote: '远程访问',
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
    headline: '交出去，离开，回来看结果。',
    headlineLines: ['交出去，离开，', '回来看结果。'],
    subhead: '多天、多步、要返工的活交给 Bot；Bot 说做完的，应用先核过。面向自带模型端点的独立开发者和小工作室。',
    trustLabel: '模型负责干活，应用负责当真',
    trust: [
      { label: '你的要求不会丢。', body: '原话原样存档，需求只增不删（以前丢过 15 条规则）。' },
      { label: '做完有定义。', body: '只有交付、检查、审查和你的放行能推进，Bot 说「通过」不算（107 秒曾被当成 2 分钟）。' },
      { label: '停下是状态。', body: '叫停只有你能解除，开轮、叫醒和有副作用的调用都先过它（以前说了停，Bot 还在送审）。' },
      { label: '停在半路有人追，也不烦你。', body: '监督器不调模型、重启不丢，只在需要你时找你（以前停了 7.6 小时没人知道）。' }
    ],
    wipNote: 'Alpha 版本：macOS 未签名快照，Windows 为实验性预览；功能与数据结构仍会变化。',
    ctaPrimary: '下载 Alpha',
    ctaSecondary: '从源码启动',
    runLabel: '本机运行',
    runCommand: 'pnpm install && pnpm dev',
    copy: '复制',
    copied: '已复制',
    scrollHint: '往下滚动，看一遍完整流程'
  },
  demo: {
    heading: '从空名册到一套发布物料，一次走完',
    intro:
      '右侧是 Deskfolk 的真实界面，随你的滚动一步步播放。画面录自一个从空状态启动的演示实例：Bot 的回复来自真实模型，海报和预告片由经 MCP 接入的生图、生视频工具生成。耗时长的步骤加速播放，右下角标着倍速；只有收进托盘那一步的桌面、横幅和 Dock 是合成的。',
    railLabel: '演示进度',
    stillLabel: 'Deskfolk 窗口：左边是群聊「发布」，下面是这件事的流程图，右边是生成的预告片，再往下是终端',
    play: '播放这一步',
    replay: '从头播放',
    enlarge: '放大看这一步',
    steps: [
      {
        title: '先选工作区和模型端点',
        body:
          '首次打开就是向导：选一个本机目录做共享工作区，再接一个 OpenAI 兼容端点，拉取它的模型列表、选好默认模型。之后每开一轮，由 agent 按任务挑模型和思考等级并留下一句理由，你不用每轮自选。',
        callout: '密钥只在这一格里填，交给系统保管，不进聊天。'
      },
      {
        title: '建第一个 Bot',
        body:
          '向导的最后一步就是它：名字、职责、边界已经按通用助手填好，可以直接创建，也可以改成你要的样子。这里改成 Coordinator，负责拆任务、点名分派和验收。创建后名册那一行多一个头像，头像按名字生成，和它的私聊随即打开。这一步也能跳过，之后随时在名册里建；名册没有人数上限，也不含你。',
        callout: '向导最后一步：名字、职责、边界，建好就能私聊。'
      },
      {
        title: '剩下的队友，让它自己去建',
        body:
          '在私聊里告诉 Coordinator 要谁：它用内置工具建好 Writer、Designer、Director 三个队友，再建群「发布」把四个都拉进来。创建 Bot、建群、改端点和 MCP，都是对话里的一句话。',
        callout: '一句话，它自己建好三个队友和一个群。'
      },
      {
        title: '在群里下任务，没被点名的自己判断',
        body:
          '在群里发一条不带 @ 的任务：给「晨光」手冲壶做一套发布物料。在场的每个 Bot 各自决定下场还是旁观，Director 判断海报还没出来，先不下场；旁观不进主转录。用 @ 点名则必须下场。应用不代你裁决谁说话，也没有轮数熔断。',
        callout: '没被点名的 Bot，各自判断下不下场。'
      },
      {
        title: '危险动作停在批准卡上',
        body:
          '品牌 logo 放在工作区外，把它拷进来的命令先停在批准卡上，等你点「允许一次」或拒绝。工作区外读写、出站网络、新接 MCP 或端点都要你放行；已配好的工具调用直接执行。等你的事标在侧栏这条会话上，没有另开的通知页。',
        callout: '工作区外的文件，要你点头才读。'
      },
      {
        title: '交接就是发消息，命令看得见',
        body:
          'Writer 写好主标语和文案；Designer 调生图工具出底图，用 Python 叠上 logo 做成海报，交给 Director；Director 把海报生成视频、下载下来剪成 6 秒，再交给 Coordinator 用 ffprobe 核对验收。每条命令和它的输出挂在那条消息底下，跑完折成一行。本轮写出的文件自动挂在回复上，没有另一套产物库。',
        callout: '@ 一下就是交接；命令和输出就在消息底下。'
      },
      {
        title: '产物在旁边一块窗格里打开',
        body:
          '点开回复里的预告片，它在「发布的产物」标签里打开，把标签拖到会话右边，窗口就分成左右两栏。产物窗格左边是这件事引用过的文件，右边按类型预览：视频和图片直接看，Markdown 和代码进 Monaco 编辑器，改完 ⌘S（Windows 上是 Ctrl+S）写回同一路径。',
        callout: '生成的海报和预告片，直接在旁边窗格里看。'
      },
      {
        title: '一件事是一张流程图',
        body:
          '从会话标签的 ⋯ 打开「经过」，再把它拖到会话下面。这件事按谁叫醒了谁画出来：一轮一张卡片，交出的文件挂在卡片上；Bot 卡片底下一行是这一轮的模型、思考等级和消息类别，点开看它为什么这么挑、走了几跳。',
        callout: '谁叫醒了谁、每轮交了什么，一张图看完。'
      },
      {
        title: '分出一块，开你自己的终端',
        body:
          '在产物标签上右键「向下分割」，在分出的空窗格里开一个终端：这是你自己的 shell，不走批准，Bot 也碰不到。会话、流程图、产物和终端四块摆在同一个窗口里；排法只记在这台电脑上，退出再开，分屏和终端都回来。',
        callout: '你自己的 shell，就在同一个窗口里。'
      },
      {
        title: '关窗不停，等你的事会来找你',
        body:
          '窗口藏进托盘，进行中的轮次和终端都接着跑。Coordinator 验收完，macOS 横幅点开就是这条会话；Dock 角标只数你没看过的和还在等你的。私聊里的 Stop 立即停掉眼前这一轮；Cmd+Q 或托盘「退出」才结束窗口和守护进程。横幅和 Dock 角标目前只在 macOS 上有。',
        callout: '关窗不停；做完了，横幅来找你。'
      },
      {
        title: '不在电脑旁，用手机接着管',
        body:
          '配对过的手机经你自己部署的中继连回这台 Mac：会话、批准、工作区和终端都在，消息在两端之间端到端加密，中继只转发它解不开的密文。在手机上 @Writer 补一句英文主标语，干活的仍是 Mac 上那个 Writer；你在手机上读过，Mac 的 Dock 角标也跟着消掉。配对只做一次：Mac 的设置里给出一段一次性配对内容，粘到手机上、两边核对指纹，再在 Mac 上用触控 ID 批准。这是默认关闭的实验功能，目前只在 macOS 上有。',
        callout: '经你自己的中继，在手机上接着管。',
        link: { label: '接入步骤', page: 'remote' }
      }
    ]
  },
  film: {
    watch: '播放完整视频',
    watchHint: '或者直接看完整视频',
    duration: '1:49',
    title: 'Deskfolk 完整演示',
    description: '从首次配置到一群 Bot 交出一套发布物料，再到它的流程图、你自己的终端和手机。',
    close: '关闭'
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
        live: 'macOS 桌面窗（Windows 为实验性预览）、常驻守护进程、本地共享工作区、SQLite 持久化；关窗不停，你自己的终端会话也由守护进程持有',
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
        live: '持久名册、私聊、多 Bot 群、@ 点名、参与判断、异步交接；出了问题按类型记成质量事件，教训由应用在调用前执行，不靠事后复盘写进记忆',
        wip: '用长活实测这些保证：叫停之后还有没有副作用、规则丢没丢、打扰了你几次',
        avoid: '用完即弃的对话框、中央裁决路由、轮数熔断'
      },
      {
        dim: '模型与工具',
        live: '多个 OpenAI 兼容端点；stdio 与 Streamable HTTP MCP；每个 Bot 有默认模型（按近 7 天用量推断，可以钉），要看图的活避开看不了图的模型，卡住了先提思考档、再沿你排的阶梯换模型；每轮的模型和原因记在流程图那一轮的卡片上',
        wip: '阶梯和提档在真实长活里的效果，还没有实测',
        avoid: '绑定单一厂商、供应商目录、假装兼容所有实现'
      },
      {
        dim: '安全与权限',
        live: '危险动作批准卡、密钥进钥匙串（Windows 上是凭据管理器）、Always allow 规则、私聊 Stop',
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
        live: '默认关闭的实验原型：自托管中继、端到端 Noise 加密；配对过的手机能看会话、回消息、处理批准、翻工作区、用终端；Android Chrome 真机上已走通，安装的应用即可登记中继、配对设备',
        wip: '独立安全复核，iOS 主屏幕 Web Push 与 WebAuthn 用户验证的真机验收，把远控凭据从文件搬进钥匙串的打包门；在这之前公网配对保持关闭',
        avoid: '项目方运营的云端中继、把实验原型当成可用的远控'
      }
    ],
    footnote: ['详细方向见', '；领域词汇以', '为准。']
  },
  quickstart: {
    heading: '下载，或从源码启动',
    intro: 'MIT 协议开源。Alpha 快照未签名：macOS 是主要平台；Windows 是实验性预览，还没有远程访问、桌面通知和应用内安装更新；Linux 暂不支持。',
    requirements: '需要 Node.js 22+、pnpm 12.3.4、Bun 1.2+、Rust / Cargo。macOS 上另装 Tauri 的 macOS 前置依赖（含 Xcode Command Line Tools）；Windows 上用 Rust 的 MSVC 工具链和 Visual Studio Build Tools（勾选 C++ 桌面开发），再先编一次终端 helper，见开发说明。',
    step1: '克隆并安装依赖',
    step2: '并行启动守护进程与桌面窗',
    firstRun: [
      '选一个本机目录作为共享工作区，建议独立于源码仓库；不存在会自动创建。',
      '首次打开的设置向导里选好工作区文件夹，再填 OpenAI 兼容端点 URL 和 API key，配好模型名单与默认模型。',
      '向导最后一步建第一个 Bot：名称、职责和边界已按通用助手填好，可直接创建或改成你要的样子，随即开始私聊。',
      '让它创建其他 Bot、组群或提出 MCP 配置；需要批准时在应用里审核。'
    ],
    download: {
      title: '下载 Alpha 快照',
      body: '最新 GitHub Release 提供 Apple 芯片与 Intel 两种 .dmg，以及 Windows 预览版安装包 Deskfolk_<版本>_x64-setup.exe。构建都未签名：Windows 上 SmartScreen 会提示未知发布者，点「更多信息」→「仍要运行」；Mac 上首次打开若被 Gatekeeper 拦截，右键选「打开」，或在终端执行（应用里的昂贵动作仍会先问你）：',
      link: '前往最新 Release',
      note: 'xattr -dr com.apple.quarantine "/Applications/Deskfolk.app"',
      faq: 'macOS 首次打开的完整说明',
      windows: 'Windows 预览版说明'
    },
    linkDocs: '开发说明',
    linkDocsSite: '文档',
    linkGlossary: '术语表',
    linkRoadmap: '路线图',
    linkRemote: '远程访问'
  },
  footer: {
    tagline: '本机运行的单人 agent 协作应用，支持 macOS，Windows 为预览版。',
    mit: 'MIT 协议开源。与 xAI / Grok 无官方附属关系。',
    contributors: 'Deskfolk Contributors'
  },
  seo: {
    title: 'Deskfolk — 交出去，离开，回来看结果',
    description:
      'macOS 本机的 agent 协作应用（Windows 为预览版）：把多天、多步、要返工的活交给 Bot，你可以离开。模型负责干活，应用负责当真：你的原话原样存档、需求只增不删，任务要过应用自己跑的检查和有依据的审查才算做完，叫停是只有你能解除的状态，停在半路有监督器去追，只在需要你时才找你。会话和文件在本机，模型端点和 MCP 工具由你接入，危险动作先等你批准。面向会自己配模型端点的独立开发者与小工作室。MIT 开源，Alpha 阶段。',
    imageAlt: 'Deskfolk：一个窗口里并排着群聊、流程图、生成的预告片和终端'
  },
  docs: {
    onThisPage: '本页',
    source: '源文件',
    navLabel: '文档',
    experimentalTag: '实验性',
    editionMain: '按 main 分支生成',
    editionLatest: '最新发布',
    editionTitle: '文档随 main 分支更新，可能写到了最新发布版里还没有的改动。',
    manifestoIndexHeading: '按主题读术语',
    manifestoIndexLead: '每个主题一页，点词条直接跳到它。',
    avoidLabel: '回避：',
    avoidToggle: '显示回避用语',
    avoidToggleHint: '每个词条下面列着 Deskfolk 刻意不用的叫法，默认收起。',
    behaviorSummary: '行为细节',
    searchLabel: '搜索文档',
    searchPlaceholder: '搜索文档',
    searchLoading: '正在载入…',
    searchEmpty: '没有找到「{q}」',
    pagerPrev: '上一页',
    pagerNext: '下一页',
    navGroup: {
      start: '开始',
      guides: '指南',
      glossary: '术语表',
      direction: '方向'
    },
    pages: {
      docs: {
        title: '文档概览',
        blurb: '怎么装、怎么用，以及每个词指什么。',
        intro: '怎么装、怎么用 Deskfolk，以及它里面每个词指的是什么。先看「开始」，要细节去「指南」，词义以「术语表」为准。'
      },
      gatekeeper: {
        title: 'macOS 首次打开',
        blurb: '未公证的 .dmg 被 Gatekeeper 拦下时怎么放行。',
        intro: 'Mac 版 Alpha 还没有经过 Apple 公证，首次打开会被 Gatekeeper 拦下：怎么放行，放行之后应用里还有哪些把关。'
      },
      windows: {
        title: 'Windows 预览版',
        blurb: '怎么装、和 Mac 版哪里不同、还缺什么。',
        intro: 'Windows 版是实验性预览：怎么装，数据和密钥放在哪，Bot 用什么 shell 跑命令，以及和 Mac 版相比还缺哪些功能。'
      },
      routines: {
        title: '日程',
        blurb: '让 Bot 每天或每周定点开工。',
        intro: 'Bot 可以按设定的时间自己开工：每天，或每周选定的几天。日程在哪看、怎么改，以及它按什么规则执行。'
      },
      spend: {
        title: '花费',
        blurb: '每次模型调用花了多少，实报与估算。',
        intro: '每一次模型调用都记在本机的账本上：在哪里看，实报和估算金额分别从哪来，计费单价怎么配。'
      },
      remote: {
        title: '远程访问',
        blurb: '自托管中继、配对手机、Web Push。',
        intro: '从手机或另一台电脑连到你 Mac 上的 Deskfolk：自己部署中继、让 Mac 连上它、配对设备。默认关闭，目前只在 macOS 上有。'
      },
      manifesto: {
        title: '全部术语',
        blurb: '每个词指什么，按主题分页。',
        intro: 'Deskfolk 里每个词指的是什么、和别的词是什么关系，以及刻意不用的叫法。按主题分成七页。'
      },
      people: { title: '人与名册', blurb: 'Bot、你、人设、归档。' },
      conversations: { title: '会话', blurb: '群、私聊、线程、回应。' },
      collaboration: { title: '协作', blurb: '点名、判断、交接、轮次。' },
      workspace: { title: '工作区', blurb: '共享目录、产物、附件、搜索。' },
      runtime: { title: '运行时', blurb: '窗与窗格、守护进程、托盘、终端、本机接口。' },
      models: { title: '模型与工具', blurb: '端点、MCP、日程、技能、上下文与花费。' },
      safety: { title: '批准与边界', blurb: '危险动作、壳、Always allow。' },
      roadmap: {
        title: '路线图',
        blurb: '建设方向，不是交付时间表。',
        intro: 'Deskfolk 的建设方向，不是稳定版承诺或交付时间表。'
      }
    }
  },
  error: {
    notFound: '找不到这一页',
    generic: '出了点问题',
    body: '地址可能写错了，或者这一页已经搬走。',
    home: '回首页',
    docs: '看文档'
  }
};

const en: Dict = {
  nav: {
    demo: 'Full walkthrough',
    boundaries: 'Boundaries',
    quickstart: 'Run from source',
    docs: 'Docs',
    glossary: 'Glossary',
    roadmap: 'Roadmap',
    remote: 'Remote access',
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
    headline: 'Hand it off. Walk away. Return to results.',
    headlineLines: ['Hand it off.', 'Walk away.', 'Return to results.'],
    subhead: 'Multi-day, multi-step jobs that need rework go to Bots; when a Bot says done, the app checks first. Bring your own model endpoint.',
    trustLabel: 'The model does the work; the app holds it to account',
    trust: [
      { label: 'Nothing you ask for gets lost.', body: 'Kept word for word, only ever added to (15 rules were once lost).' },
      { label: 'Done has a definition.', body: 'Only checks, reviews and your OK move work (a 107 s cut once passed as 2 min).' },
      { label: 'Stop is a state.', body: 'Only you lift it; nothing starts or acts past it (a Bot once kept going after "hold on").' },
      { label: 'Stalls get chased, without pestering you.', body: 'Work picks back up; you hear when needed (a job once sat 7.6 h).' }
    ],
    wipNote: 'Alpha: unsigned macOS snapshot, with Windows as an experimental preview. Features and data structures may still change.',
    ctaPrimary: 'Download alpha',
    ctaSecondary: 'Run from source',
    runLabel: 'Runs locally',
    runCommand: 'pnpm install && pnpm dev',
    copy: 'Copy',
    copied: 'Copied',
    scrollHint: 'Scroll to watch the full flow'
  },
  demo: {
    heading: 'From an empty roster to a launch kit, in one pass',
    intro:
      'On the right is the real Deskfolk app, playing step by step as you scroll. It was recorded on a demo instance that started empty: the Bots answer with real models, and the poster and teaser come from image and video tools connected over MCP. Long steps play sped up, with the speed in the corner; only the desktop, banner and Dock in the tray step are composed.',
    railLabel: 'Walkthrough progress',
    stillLabel: 'The Deskfolk window: the Launch group on the left with its flow below, the generated teaser on the right with a terminal below',
    play: 'Play this step',
    replay: 'Play from the start',
    enlarge: 'Enlarge this step',
    steps: [
      {
        title: 'Set the workspace and a model endpoint',
        body:
          'The first run is a wizard: pick a local folder as the shared workspace, add an OpenAI-compatible endpoint, fetch its models and choose the default. From then on an agent picks the model and thinking level for each turn — and leaves a reason — instead of asking you every time.',
        callout: 'The key goes in this one field, into the system\'s credential store, never the chat.'
      },
      {
        title: 'Create the first bot',
        body:
          'It is the wizard\'s last step: name, duties and boundaries come filled in for a general assistant, to create as is or make your own. Here it becomes Coordinator, who splits the goal, names who does what and checks the results. On create, a face appears on the roster row, its avatar generated from the name, and a direct chat opens. You can skip the step and add bots from the roster any time; the roster has no cap and does not include you.',
        callout: 'The wizard’s last step: name, duties, boundaries, and it’s ready to chat.'
      },
      {
        title: 'Let it hire the rest of the team',
        body:
          'Tell Coordinator who you need, in its direct chat. It uses built-in tools to create Writer, Designer and Director, then opens the group "Launch" with all four in it. Creating bots and groups, or changing endpoints and MCP, is one sentence in a chat.',
        callout: 'One message, and it hires three teammates and makes a group.'
      },
      {
        title: 'Post the goal; unmentioned bots decide for themselves',
        body:
          'Post the task in the group without an @: a launch kit for the "Dawn" pour-over kettle. Every bot present decides to join or pass, and Director passes until there is a poster to work from; passing never enters the transcript. An @mention makes joining mandatory. The app does not arbitrate who speaks and has no turn-count breaker.',
        callout: 'Bots nobody mentioned decide for themselves whether to join.'
      },
      {
        title: 'Dangerous actions stop at an approval card',
        body:
          'The brand logo lives outside the workspace, so the command that copies it in stops at an approval card until you allow it once or deny it. Reading or writing outside the workspace, outbound network, adding MCP or endpoints all wait for you; calls to configured tools run directly. What waits on you is marked on the conversation in the sidebar; there is no separate notifications page.',
        callout: 'Files outside the workspace wait for your yes.'
      },
      {
        title: 'A handoff is just a message, and commands show',
        body:
          'Writer drafts the tagline and copy; Designer has the image tool paint a backdrop and lays the logo over it in Python, then hands the poster to Director; Director turns it into a clip, downloads it, trims it to 6 seconds and hands it to Coordinator, who checks it with ffprobe. Each command and its output sit under the message that ran it and fold to one line when done. Files written during the turn attach to the reply; there is no separate artifact store.',
        callout: 'An @ is a handoff; commands and their output sit under the message.'
      },
      {
        title: 'The output opens in a pane beside it',
        body:
          'Open the teaser from the reply and it lands in the "Launch\'s artifacts" tab; drag the tab to the right of the conversation and the window splits in two. The artifact pane lists the files this job touched on the left and previews the one you pick on the right: video and images play and show as they are, Markdown and code open in a Monaco editor, and ⌘S (Ctrl+S on Windows) writes back to the same path.',
        callout: 'The poster and the teaser open right in the pane beside it.'
      },
      {
        title: 'One job reads as a flow',
        body:
          'Pick Trace from the conversation tab\'s ⋯ and drag it under the conversation. The job is drawn by who woke whom: a card per turn, with the files it handed over on the card. Under each Bot card is the model, thinking level and message kind its turn ran on; click it for why, and how many hops it took.',
        callout: 'Who woke whom and what each turn handed over, on one board.'
      },
      {
        title: 'Split off a pane for your own terminal',
        body:
          'Right-click the artifacts tab, pick Split down, and open a terminal in the new empty pane: it is your own shell, it needs no approval, and no Bot can touch it. Conversation, flow, artifact and terminal now share one window; the layout is remembered on this computer, and Quit and reopen brings back the split and the terminal.',
        callout: 'Your own shell, in the same window.'
      },
      {
        title: 'Close the window; what waits on you finds you',
        body:
          'The window hides in the tray, and running turns and terminals carry on. When Coordinator signs off the kit, a macOS banner opens straight to that conversation, and the Dock badge counts only what you have not seen plus what is still waiting on you. Stop in a direct chat ends the current turn immediately; only Cmd+Q or Quit in the tray ends the window and the daemon. Banners and the Dock badge are macOS only for now.',
        callout: 'Closing the window stops nothing; when it’s done, a banner finds you.'
      },
      {
        title: 'Away from your computer, carry on from your phone',
        body:
          'A paired phone reaches this Mac through a relay you deploy yourself: conversations, approvals, the workspace and your terminals are all there, encrypted end to end between the two, with the relay passing along ciphertext it cannot read. Ask @Writer for a Chinese tagline from the phone and it is still the Writer on the Mac doing the work; read it on the phone and the Mac\'s Dock badge clears too. Pairing happens once: the Mac\'s settings hand out a one-time code, you paste it on the phone, check that the fingerprints match, and approve at the Mac with Touch ID. It is an experimental feature, off by default, and macOS only for now.',
        callout: 'Through your own relay, carry on from your phone.',
        link: { label: 'Set it up', page: 'remote' }
      }
    ]
  },
  film: {
    watch: 'Play the full video',
    watchHint: 'or watch the full video',
    duration: '1:45',
    title: 'Deskfolk, the full demo',
    description: 'From first setup to a group of Bots delivering a launch kit, with its flow board, your own terminal and your phone.',
    close: 'Close'
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
        live: 'macOS window (Windows as an experimental preview), resident daemon, local shared workspace, SQLite state; closing the window stops nothing, and the daemon holds your own terminal sessions too',
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
        live: 'Persistent roster, direct chats, multi-bot groups, @mentions, judgement, async handoffs; what goes wrong is filed by type as a quality event, and lessons are enforced by the app before a call instead of written into memory by a review afterwards',
        wip: 'Measuring these guarantees on long jobs: side effects after a stop, rules lost, how often you were interrupted',
        avoid: 'Disposable chat boxes, a central dispatcher, turn-count breakers'
      },
      {
        dim: 'Models and tools',
        live: 'Multiple OpenAI-compatible endpoints; stdio and Streamable HTTP MCP; each Bot has a default model (inferred from the last 7 days of use, or pinned), work that needs to see images skips models that cannot, and a stuck job thinks harder, then climbs the ladder of models you order; each turn\'s model and why are kept on its card in the flow',
        wip: 'How the ladder and stepping up do on real long jobs, not measured yet',
        avoid: 'Vendor lock-in, a provider catalogue, pretending every implementation is compatible'
      },
      {
        dim: 'Safety and permissions',
        live: 'Approval cards for dangerous actions, secrets in the Keychain (Credential Manager on Windows), Always allow rules, Stop in direct chats',
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
        live: 'A default-off experimental prototype: a self-hosted relay and end-to-end Noise encryption; a paired phone reads and answers conversations, handles approvals, browses the workspace and uses your terminals; checked on a real Android phone in Chrome; the installed app registers with a relay and pairs devices',
        wip: 'Independent security review, real-device checks of iOS home-screen Web Push and WebAuthn user verification, and the packaging gate that moves remote credentials from a file into the Keychain; public pairing stays off until then',
        avoid: 'A project-run cloud relay, passing a prototype off as working remote access'
      }
    ],
    footnote: ['See the ', ' for direction; the ', ' is the source of truth for vocabulary.']
  },
  quickstart: {
    heading: 'Download, or run from source',
    intro: 'Open source under MIT. The alpha snapshot is unsigned: macOS is the primary platform; Windows is an experimental preview, without remote access, desktop notifications or in-app update install yet; Linux is not supported.',
    requirements: 'Requires Node.js 22+, pnpm 12.3.4, Bun 1.2+ and Rust / Cargo. On macOS, add the Tauri macOS prerequisites (including Xcode Command Line Tools); on Windows, Rust\'s MSVC toolchain and Visual Studio Build Tools (Desktop development with C++), plus a one-time build of the terminal helper — see the development guide.',
    step1: 'Clone and install',
    step2: 'Start the daemon and the desktop window in parallel',
    firstRun: [
      'Pick a local folder as the shared workspace, ideally outside the source checkout; missing folders are created.',
      'In the setup wizard that opens on first launch, choose the workspace folder, then enter an OpenAI-compatible endpoint URL and API key, then the model list and default model.',
      'The wizard\'s last step creates the first bot: its name, duties and boundaries come filled in for a general assistant, to create as is or make your own, and its direct chat opens.',
      'Ask it to create other bots, form groups or propose MCP configuration; approve dangerous actions in the app.'
    ],
    download: {
      title: 'Download the alpha snapshot',
      body: 'The latest GitHub Release ships .dmg files for Apple silicon and Intel, and a Windows preview installer, Deskfolk_<version>_x64-setup.exe. Neither is signed: on Windows, SmartScreen warns about an unknown publisher (More info → Run anyway); on a Mac, if Gatekeeper blocks the first launch, right-click and choose Open, or run (expensive actions inside the app still ask first):',
      link: 'Go to the latest release',
      note: 'xattr -dr com.apple.quarantine "/Applications/Deskfolk.app"',
      faq: 'Full first-launch guide for macOS',
      windows: 'About the Windows preview'
    },
    linkDocs: 'Development guide',
    linkDocsSite: 'Docs',
    linkGlossary: 'Glossary',
    linkRoadmap: 'Roadmap',
    linkRemote: 'Remote access'
  },
  footer: {
    tagline: 'A single-user agent collaboration app for macOS, with a Windows preview.',
    mit: 'Open source under MIT. Not affiliated with xAI / Grok.',
    contributors: 'Deskfolk Contributors'
  },
  seo: {
    title: 'Deskfolk — Hand it off, walk away, return to results',
    description:
      'A local agent app for macOS (Windows in preview): hand Bots the multi-day, multi-step jobs that need rework, and walk away. The model does the work; the app holds it to account: your words are kept as you said them, requirements are only ever added, a job is done only after checks the app runs itself and a review backed by evidence, a stop is a state only you can lift, a supervisor chases stalls, and the app comes to you only when it needs you. Chats and files stay on your Mac; you plug in the model endpoints and MCP tools, and risky actions wait for your approval. For solo developers and small studios who bring their own model endpoint. MIT, alpha.',
    imageAlt: 'Deskfolk: a group chat, its flow, the teaser the team made and a terminal side by side in one window'
  },
  docs: {
    onThisPage: 'On this page',
    source: 'Source',
    navLabel: 'Docs',
    experimentalTag: 'Experimental',
    editionMain: 'Built from main',
    editionLatest: 'latest release',
    editionTitle: 'The docs follow the main branch and may describe changes the latest release does not have yet.',
    manifestoIndexHeading: 'Terms by topic',
    manifestoIndexLead: 'One page per topic; click a term to jump to it.',
    avoidLabel: 'Avoid: ',
    avoidToggle: 'Show words to avoid',
    avoidToggleHint: 'Each entry lists the names Deskfolk deliberately does not use; they are folded away by default.',
    behaviorSummary: 'Behavior details',
    searchLabel: 'Search docs',
    searchPlaceholder: 'Search docs',
    searchLoading: 'Loading…',
    searchEmpty: 'Nothing found for “{q}”',
    pagerPrev: 'Previous',
    pagerNext: 'Next',
    navGroup: {
      start: 'Get started',
      guides: 'Guides',
      glossary: 'Glossary',
      direction: 'Direction'
    },
    pages: {
      docs: {
        title: 'Docs overview',
        blurb: 'Installing, using, and what each word means.',
        intro: 'How to install and use Deskfolk, and what each word in it means. Start with Get started, go to Guides for the details; the Glossary settles what a word means.'
      },
      gatekeeper: {
        title: 'First launch on macOS',
        blurb: 'Getting an unnotarized .dmg past Gatekeeper.',
        intro: 'The Mac alpha is not notarized by Apple yet, so Gatekeeper blocks the first launch: how to let it through, and what the app still guards after that.'
      },
      windows: {
        title: 'Windows preview',
        blurb: 'Installing it, how it differs from the Mac, what is missing.',
        intro: 'The Windows build is an experimental preview: how to install it, where data and keys live, which shell Bots run commands in, and what it still lacks next to the Mac.'
      },
      routines: {
        title: 'Routines',
        blurb: 'Bots that start work daily or weekly at a set time.',
        intro: 'A Bot can start work on its own at a set time, daily or on chosen weekdays: where routines live, how to edit them, and the rules they run by.'
      },
      spend: {
        title: 'Spend',
        blurb: 'What each model call cost, reported and estimated.',
        intro: 'Every model call goes into a ledger on this computer: where to read it, where reported and estimated amounts come from, and how to set prices.'
      },
      remote: {
        title: 'Remote access',
        blurb: 'Self-hosted relay, pairing a phone, Web Push.',
        intro: 'Reach Deskfolk on your Mac from a phone or another computer: deploy your own relay, point the Mac at it, pair a device. Off by default, and macOS only for now.'
      },
      manifesto: {
        title: 'All terms',
        blurb: 'What each word means, one page per topic.',
        intro: 'What each word in Deskfolk means, how it relates to the others, and the names it deliberately avoids. Split into seven topics.'
      },
      people: { title: 'People and roster', blurb: 'Bots, you, profiles, archive.' },
      conversations: { title: 'Sessions', blurb: 'Groups, directs, threads, reactions.' },
      collaboration: { title: 'Collaboration', blurb: 'Mentions, judgement, handoffs, turns.' },
      workspace: { title: 'Workspace', blurb: 'Shared folder, artifacts, attachments, search.' },
      runtime: { title: 'Runtime', blurb: 'Window and panes, daemon, tray, terminal, local API.' },
      models: { title: 'Models and tools', blurb: 'Endpoints, MCP, routines, skills, context, spend.' },
      safety: { title: 'Approval and bounds', blurb: 'Dangerous actions, shells, Always allow.' },
      roadmap: {
        title: 'Roadmap',
        blurb: 'Direction, not a delivery schedule.',
        intro: 'Where Deskfolk is heading. Not a stable-release promise or a delivery schedule.'
      }
    }
  },
  error: {
    notFound: 'Page not found',
    generic: 'Something went wrong',
    body: 'The address may be mistyped, or the page has moved.',
    home: 'Home',
    docs: 'Docs'
  }
};

export const DICT: Record<Lang, Dict> = { zh, en };
