import type { DocsNavGroupId, DocsPageKey } from './docs';

export type Lang = 'zh' | 'en';

export type StepCopy = {
  title: string;
  body: string;
  callout: string;
  /** A docs page that takes the step further. */
  link?: { label: string; page: DocsPageKey };
};

export type Dict = {
  nav: {
    overview: string;
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
    ctaPrimary: string;
    copy: string;
    copied: string;
  };
  demo: {
    steps: StepCopy[];
    /** What the first screen's still shows, for screen readers. */
    stillLabel: string;
  };
  /** The home page: one screen, the headline as the demo's player. */
  home: {
    /** Each beat is one line of the headline and one clip of the real app. */
    beats: { line: string; caption: string }[];
    stageLabel: string;
    download: string;
    film: string;
    filmDuration: string;
    filmTitle: string;
    filmDescription: string;
    note: string;
    close: string;
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
    overview: '介绍与安装',
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
    ctaPrimary: '下载 Alpha',
    copy: '复制',
    copied: '已复制'
  },
  demo: {
    stillLabel: 'Deskfolk 窗口：左边是群聊「发布」，下面是这件事的流程图，右边在播放做好的宣传短片',
    steps: [
      {
        title: '先选工作区和模型端点',
        body:
          '首次打开就是向导：选一个本机目录做共享工作区，再接一个 OpenAI 兼容或 Anthropic 兼容的端点，拉取它的模型列表、选好默认模型。之后不用每轮自选：每个 Bot 有自己的默认模型，可以钉，卡住了沿你排的阶梯往上换。',
        callout: '密钥只在这一格里填，交给系统保管，不进聊天。'
      },
      {
        title: '第一个 Bot：制片',
        body:
          '向导的最后一步就是它：名字、职责、边界已经按通用助手填好，可以直接创建，也可以改成你要的样子。这里改成「制片」：开工前把活拆成任务、每张的审查者设成审片，交付前自己先核对；边界是只在工作区里动手、你说停就停。创建后它的私聊随即打开。这一步也能跳过，之后随时在名册里建。',
        callout: '向导最后一步：名字、职责、边界，建好就能私聊。'
      },
      {
        title: '一句话，要来审片',
        body:
          '在私聊里说一句：建一个「审片」，逐条对照你的要求审视频和文案，看帧、核对时长和分辨率，带依据地判通过或打回，只审不改；再建群「发布」把两个都拉进来。创建 Bot、建群、改端点和 MCP，都是对话里的一句话。审片用的是另一个模型，判通过的不是制片自己那个模型。',
        callout: '一句话，它建好审片和群「发布」。'
      },
      {
        title: '交出去，它先拆成任务',
        body:
          '在群里交代这件事：给「晨光」手冲壶做一支 6 秒、1080×1920 的宣传短片，片尾带品牌 logo，再配一句主标语。制片是这个群的负责人，先把活拆成任务，每张都写明谁来做、谁来审。把流程图拖到会话下面，右边就是任务清单：谁在做、球在谁手里、谁来审，一眼看清。',
        callout: '每张任务都写明谁来做、谁来审。'
      },
      {
        title: '工作区外先问你，做完由你来定',
        body:
          'logo 在工作区外，拷进来的命令停在批准卡上，点「允许一次」才跑。制片把画面交给 Grok Imagine 生成视频，这一段就结束了；应用把你的话整理成「你的要求」，每条都站在你的原话上、只增不删。你说的时长 6 秒和分辨率 1080×1920 成了两条检查提议，点「确认」它们才成为门禁。',
        callout: '你的原话记成要求；数字成了检查，你点确认。'
      },
      {
        title: '关窗走开，渲染由应用去查',
        body:
          '窗口收进托盘，视频还在渲染。等渲染的这段时间没有轮在跑：应用按 30 秒、1 分钟……自己去查，查到结果再叫醒制片；监督器每 15 秒看一眼，活停在半路就叫回去，重启也不丢。',
        callout: '你走开，应用替你盯着渲染。'
      },
      {
        title: '说停就停，只有你能解除',
        body:
          '你在群里说「先停一下」：叫停当场生效，压在这件事上，开轮、叫醒和有副作用的调用都过不去。这时再说「片尾的 logo 再大一点」，制片只开一段只读的轮来回你，这句话同时记成一条新要求。说「继续」才解开，活从你最后那句话接着做。',
        callout: '叫停是一个状态，你说「继续」才解开。'
      },
      {
        title: '做完有定义',
        body:
          '制片交件，应用当场跑你确认过的检查，时长或分辨率不对就退回返工；Bot 说「做完了」不算。检查通过后，审片看过帧，逐条带依据判通过，这张任务才变成「已通过」。主标语是文字，交上来落在你的放行卡上。',
        callout: '检查、审查、你的放行；Bot 说的不算。'
      },
      {
        title: '回来，看结果',
        body:
          '回来问一句「怎么样了」，应用按这件事的状态直接回你，不开轮、不叫醒谁。流程图在会话下面，成片在旁边窗格里播放：每张任务过了哪些检查、谁审的、谁放行的，都在上面。',
        callout: '问一句「怎么样了」，按状态直接回你。'
      }
    ]
  },
  home: {
    beats: [
      { line: '交出去。', caption: '一句话交代，它先拆成任务：每张写明谁来做、谁来审。' },
      { line: '离开。', caption: '关窗走开，应用替你盯着渲染。' },
      { line: '回来看结果。', caption: '检查、审查、你的放行都过了，才算做完。' }
    ],
    stageLabel: 'Deskfolk 真实界面演示',
    download: '下载 Alpha',
    film: '看短片',
    filmDuration: '0:30',
    filmTitle: 'Deskfolk 短片',
    filmDescription: '吉祥物麻薯（你）把活交给布丁（你的 Bot）；布丁接着干，要动工作区以外的东西先停下来问你；你离开，回来时活做完了，也查过了。',
    note: 'macOS 已公证，Windows 预览版',
    close: '关闭'
  },
  footer: {
    tagline: '本机运行的单人 agent 协作应用，支持 macOS，Windows 为预览版。',
    mit: 'MIT 协议开源。与 xAI / Grok 无官方附属关系。',
    contributors: 'Deskfolk Contributors'
  },
  seo: {
    title: 'Deskfolk — 交出去，离开，回来看结果',
    description:
      'macOS 本机的 agent 协作应用（Windows 为预览版）：把多天、多步、要返工的活交给 Bot，你可以离开。模型负责干活，应用负责当真：你的原话原样存档、需求只增不删，任务要过应用自己跑的检查和有依据的审查才算做完，叫停是只有你能解除的状态，停在半路有监督器去追，只在需要你时才找你。这些规矩写在代码里；Bot 怎么干活写在应用自带的提示词里：在设置里就能改，也可以让 Bot 查本机记录、拿依据提改动，在批准卡上由你放行。会话和文件在本机，模型端点和 MCP 工具由你接入，危险动作先等你批准。面向会自己配模型端点的独立开发者与小工作室。MIT 开源，Alpha 阶段。',
    imageAlt: 'Deskfolk：一个窗口里并排着群聊、这件事的流程图和做好的宣传短片'
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
      overview: {
        title: '介绍与安装',
        blurb: '它为什么可托付、适合谁、能做什么；下载、从源码启动、用本地模型，以及哪些已接入、哪些不做。',
        intro: 'Deskfolk 把多天、多步、要返工的活交给 Bot，Bot 说做完的由应用先核过。这一页讲它凭什么可以托付、适合谁、能做什么，怎么装，以及现在哪些已经接入、哪些不做。'
      },
      gatekeeper: {
        title: 'macOS 首次打开',
        blurb: '新版已公证，双击即开；更早的版本被 Gatekeeper 拦下时怎么放行。',
        intro: 'Mac 版从 0.1.0-rc.16 起经过 Apple 公证，双击即可打开；更早的未签名版本首次打开会被 Gatekeeper 拦下：怎么放行，放行之后应用里还有哪些把关。'
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
    overview: 'About and install',
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
    ctaPrimary: 'Download alpha',
    copy: 'Copy',
    copied: 'Copied'
  },
  demo: {
    stillLabel: 'The Deskfolk window: the Launch group on the left with its flow below, and the finished promo film playing on the right',
    steps: [
      {
        title: 'Set the workspace and a model endpoint',
        body:
          'The first run is a wizard: pick a local folder as the shared workspace, add an OpenAI-compatible or Anthropic-compatible endpoint, fetch its models and choose the default. From then on nobody asks you turn by turn: each Bot has its own default model, which you can pin, and climbs the ladder you order when it gets stuck.',
        callout: 'The key goes in this one field, into the system\'s credential store, never the chat.'
      },
      {
        title: 'The first Bot: the Producer',
        body:
          'It is the wizard\'s last step: name, duties and boundaries come filled in for a general assistant, to create as is or make your own. Here it becomes the Producer: before starting, it lays the job out in tickets with the Reviewer on each, and checks its own work before handing it in; it stays in the workspace and stops when you say so. On create, its direct chat opens. You can skip the step and add Bots from the roster any time.',
        callout: 'The wizard’s last step: name, duties, boundaries, and it’s ready to chat.'
      },
      {
        title: 'One line brings in a Reviewer',
        body:
          'In the direct chat, one line: make a Reviewer that checks videos and copy against your asks item by item, looks at frames, checks length and size, and passes or sends back with evidence, never editing; then make a group called “Launch” with both. Creating Bots and groups, or changing endpoints and MCP, is one sentence in a chat. The Reviewer runs on another model, so a pass is not the Producer’s own model grading itself.',
        callout: 'One line, and it makes the Reviewer and the “Launch” group.'
      },
      {
        title: 'Hand it off: it lays out tickets',
        body:
          'In the group, hand over the job: a 6-second, 1080×1920 promo film for the “Dawn” kettle, ending on the brand logo, plus a tagline. The Producer leads the group, so it lays the job out in tickets first, each naming who makes it and who reviews it. Drag the flow under the chat and the tickets sit beside it: who is on it, whose turn it is, who reviews.',
        callout: 'Every ticket names who makes it and who reviews it.'
      },
      {
        title: 'It asks before leaving the workspace; you define done',
        body:
          'The logo lives outside the workspace, so the command that copies it in stops at an approval card until you press Allow once. Once the Producer hands the picture to Grok Imagine, its segment ends, and the app writes your words up as asks, each standing on what you said and only ever added to. The length and size you gave become two proposed checks; they gate the work only once you confirm them.',
        callout: 'Your words become asks; your numbers, checks you confirm.'
      },
      {
        title: 'Walk away; the app watches the render',
        body:
          'The window goes to the tray while the video renders. Nothing runs a turn while it waits: the app polls the render itself, at 30 seconds, a minute and on, and wakes the Producer with the result; the supervisor looks every 15 seconds and calls stalled work back, across restarts too.',
        callout: 'You leave; the app keeps an eye on the render.'
      },
      {
        title: 'Stop means stop, until you lift it',
        body:
          'Say “Pause.” in the group: the stop holds the job at once, and no turn, wake-up or side effect gets past it. Say “Make the logo at the end bigger.” while it holds, and the Producer answers in a read-only turn while the line is kept as a new ask. Only “Continue.” lifts the stop, and the work goes on from what you said last.',
        callout: 'A stop is a state: only “Continue.” lifts it.'
      },
      {
        title: 'Done has a definition',
        body:
          'When the Producer hands the film in, the app runs the checks you confirmed on the spot, and a wrong length or size sends it back for rework; a Bot saying “done” moves nothing. Once the checks pass, the Reviewer looks at the frames and passes it with evidence for each item, and only then is the ticket approved. The tagline is text, so its hand-in lands on your card.',
        callout: 'Checks, a review and your OK; a Bot’s word moves nothing.'
      },
      {
        title: 'Return to results',
        body:
          'Back at your desk, ask “How is it going?” and the app answers from the job’s state without starting a turn or waking anyone. The flow sits under the chat and the film plays beside it: every ticket’s checks, reviewer and approval are on it.',
        callout: 'Ask “How is it going?” and the state answers.'
      }
    ]
  },
  home: {
    beats: [
      { line: 'Hand it off.', caption: 'One line, and it lays out tickets: who makes each, who reviews it.' },
      { line: 'Walk away.', caption: 'Close the window; the app keeps an eye on the render.' },
      { line: 'Return to results.', caption: 'Done means checks, a review and your OK all passed.' }
    ],
    stageLabel: 'Deskfolk, the real app',
    download: 'Download alpha',
    film: 'Watch the film',
    filmDuration: '0:30',
    filmTitle: 'The Deskfolk film',
    filmDescription: 'Mochi (you) hands Pudding (your Bot) a job; Pudding takes it from there and stops to ask before touching anything outside the workspace; you walk away and come back to work that is done, and checked.',
    note: 'macOS notarized, Windows preview',
    close: 'Close'
  },
  footer: {
    tagline: 'A single-user agent collaboration app for macOS, with a Windows preview.',
    mit: 'Open source under MIT. Not affiliated with xAI / Grok.',
    contributors: 'Deskfolk Contributors'
  },
  seo: {
    title: 'Deskfolk — Hand it off, walk away, return to results',
    description:
      'A local agent app for macOS (Windows in preview): hand Bots the multi-day, multi-step jobs that need rework, and walk away. The model does the work; the app holds it to account: your words are kept as you said them, requirements are only ever added, a job is done only after checks the app runs itself and a review backed by evidence, a stop is a state only you can lift, a supervisor chases stalls, and the app comes to you only when it needs you. Those rules are code; how Bots work is written in prompts the app ships: change them in Settings, or let a Bot propose a change, backed by this machine\'s records, that you let through on its approval card. Chats and files stay on your Mac; you plug in the model endpoints and MCP tools, and risky actions wait for your approval. For solo developers and small studios who bring their own model endpoint. MIT, alpha.',
    imageAlt: 'Deskfolk: a group chat, the job’s flow and the finished promo film side by side in one window'
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
      overview: {
        title: 'About and install',
        blurb: 'Why it can be trusted with a job, who it is for, what it does; download, run from source, local models, and what is live and what is not.',
        intro: 'Deskfolk hands multi-day, multi-step jobs that need rework to Bots, and checks first when a Bot says done. This page covers why you can hand it over, who it is for, what it does, how to install it, and what is live today and what is not.'
      },
      gatekeeper: {
        title: 'First launch on macOS',
        blurb: 'New builds are notarized and open with a double-click; getting an older one past Gatekeeper.',
        intro: 'From 0.1.0-rc.16 the Mac alpha is notarized by Apple and opens with a double-click; Gatekeeper blocks the first launch of an older, unsigned build: how to let it through, and what the app still guards after that.'
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
