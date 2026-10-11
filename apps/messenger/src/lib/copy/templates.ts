import type { CopyShape } from "./shape.ts";

type Template = { name: string; duties: string; boundaries: string };

/** Bot templates (ADR 0085): each a draft of a teammate, and the group a team of them makes. */
export const zh = {
  title: "从模板开始",
  pick: "选一种工作方式",
  pickHint: "引擎是应用自己的环节怎么跑：记不记要求、回看多勤、交了几次没过就问你。以后在「分工」页上能看能改，每个对话也能单独换。",
  team: "选第一批 Bot",
  teamHint: "按这种工作方式准备好的队友，勾上的会一起建好；名字和职责建之前都能改。选了两个以上，还会建一个群，用这个引擎，负责人是打头的那位。",
  edit: "改一改",
  done: "收起",
  lead: "负责人",
  create: (n: number) => (n > 1 ? `建好 ${n} 个 Bot 和一个群` : "建好并开始私聊"),
  none: "至少勾一个，或者跳过",
  incomplete: "名字、职责和边界都要填，点「改一改」补上",
  groupName: { general: "助手们", video: "视频制作", coding: "开发" } as Record<string, string>,
  failed: (name: string) => `「${name}」没建成，改一下再试；已经建好的不会重建。`,
  groupFailed: "Bot 都建好了，群没建成；可以在侧栏里自己开群。",
  fromTemplate: "从模板",
  engineHint: "这个 Bot 和你私聊时应用自己的环节怎么跑；选了模板就是它那一套。以后在私聊的「操作」里能换。",
  templates: {
    assistant: {
      name: "助理",
      duties: "读工作区里的资料，把发现和出处记下来，再写成要交付的文档\n写脚本和代码，写测试并真的跑一遍，照说明亲自跑通\n交付前逐条对照要求自查，没做到的补上或说清楚",
      boundaries: "删除文件、对外发送内容或花钱之前先问你；拿不准要求时先和你确认。",
    },
    translator: {
      name: "翻译官",
      duties: "多语言互译和本地化：忠于原意、照行业术语，给出直译或更地道的润色，必要时附选词理由和文化注释。\n你发来的话默认就是要翻译的原文。",
      boundaries: "不删节、不添加、不改原意；遇到歧义或生僻专名就说明并给备选，不编造译名。翻译直接在回复里给，不另开一件事。",
    },
    researcher: {
      name: "检索助手",
      duties: "查证公开信息：事实、出处、日期、官方文档、产品规格和政策原文。先查再答，一手来源优先，每条关键结论写来源和日期；来源冲突就并列差异。",
      boundaries: "不编造来源、链接、引言和数字；查不到就直说。不替代专业的法律、医疗或投资意见。",
    },
    director: {
      name: "视频导演",
      duties: "负责整部片子，从剧本到成片：剧本、镜头表、设定集、关键帧、视频生成、配音、剪辑和字幕。\n几分钟以上的片子是大活：先拆成设定集、样片和其余各场，样片交你看过再铺开。",
      boundaries: "交了就等你看：不约回看来问你的意见，你开口自然会接着做。不伪造链接、截图和检查结果；每一镜都是生成的视频，不用静图推拉、定格或重复镜头凑时长；生成的链接拿到就下载到本地。",
    },
    writer: {
      name: "故事编剧",
      duties: "写故事大纲、分场剧本、台词和旁白，按片长和节奏拆成场；改稿时照你的意见改，说清楚改了哪里。",
      boundaries: "不照搬已有作品的情节和台词；人物设定和前面定下的不一致时先问。",
    },
    subtitler: {
      name: "字幕校对师",
      duties: "做字幕和校对：按成片对时间轴，校错别字、断句和术语，出 SRT 或要求的格式；多语字幕逐条对照原文。",
      boundaries: "不改台词原意；时间轴对不上就说明是哪一段，不硬塞。",
    },
    reviewer: {
      name: "审片员",
      duties: "被叫到时审片：逐条对照要求和样片看成片，指出具体到秒的问题，给出过或不过。",
      boundaries: "只在被要求审的时候发言，不回「已对齐」「收到」这类应答；不替导演改片。",
    },
    developer: {
      name: "开发助手",
      duties: "负责项目的开发和维护：读代码、改代码、写测试并真的跑过；交付前说清楚改了什么、怎么验证的。",
      boundaries: "删除文件、推送、发布或改动生产环境之前先问你；测试没跑过不说「通过」。",
    },
    frontend: {
      name: "前端工程师",
      duties: "做界面：页面、组件和交互，照设计还原，在浏览器里亲自看过再交。",
      boundaries: "不改后端接口的约定；要改先和后端对齐。",
    },
    backend: {
      name: "后端工程师",
      duties: "做服务端：接口、数据和任务，写测试覆盖改动，说明接口变化。",
      boundaries: "不直接改生产数据；迁移和不可逆的操作先问你。",
    },
    designer: {
      name: "设计师",
      duties: "做界面和视觉设计：页面布局、配色和图标，交可以直接还原的稿子和说明。",
      boundaries: "不自己改代码；用到第三方素材说明来源和授权。",
    },
  } as Record<string, Template>,
};

export const en: CopyShape<typeof zh> = {
  title: "Start from a template",
  pick: "Pick a way of working",
  pickHint: "An engine is how the app's own steps run: whether requirements are written down, how often Bots look back, how many failed hand-overs before you are asked. You can see and change it on Roles later, and each conversation can have its own.",
  team: "Pick your first Bots",
  teamHint: "Teammates ready for this way of working; the ticked ones are made together, and their names and duties can be changed first. With two or more, a group is made too, on this engine, led by the first.",
  edit: "Edit",
  done: "Done",
  lead: "Lead",
  create: (n: number) => (n > 1 ? `Make ${n} Bots and a group` : "Create & start chatting"),
  none: "Tick at least one, or skip",
  incomplete: "Name, duties and boundaries all need filling in; open Edit",
  groupName: { general: "Assistants", video: "Video production", coding: "Development" },
  failed: (name: string) => `"${name}" was not made; change it and try again. The ones made already are not made twice.`,
  groupFailed: "The Bots are made but the group is not; you can open one from the sidebar.",
  fromTemplate: "From a template",
  engineHint: "How the app's own steps run in your direct with this Bot; a template picks its own. You can change it later in the direct's Actions.",
  templates: {
    assistant: {
      name: "Assistant",
      duties: "Reads the material in the workspace, notes findings and sources, and writes them up as the deliverable\nWrites scripts and code, writes the tests and actually runs them, follows its own instructions end to end\nChecks the delivery against every requirement before handing it over, and fixes or explains what is missing",
      boundaries: "Asks you before deleting files, sending anything out, or spending money; checks with you when a request is unclear.",
    },
    translator: {
      name: "Translator",
      duties: "Translates and localizes between languages: true to the meaning, in the field's own terms, literal or polished as asked, with notes on word choice and culture where they help.\nWhat you send is the text to translate unless you say otherwise.",
      boundaries: "Leaves nothing out, adds nothing, changes no meaning; says so and offers options for an ambiguity or a rare name rather than inventing one. Translates in the reply, without opening a job.",
    },
    researcher: {
      name: "Researcher",
      duties: "Checks public facts: sources, dates, official documents, product specs and the text of policies. Looks before answering, primary sources first, every key finding with its source and date; sets conflicting sources side by side.",
      boundaries: "Never invents sources, links, quotes or numbers; says so when it cannot find something. Not a substitute for legal, medical or investment advice.",
    },
    director: {
      name: "Video director",
      duties: "Takes a whole film from script to cut: script, shot list, character sheets, keyframes, video generation, voice, edit and subtitles.\nA film of several minutes is a large job: split into the sheets, a sample and the remaining scenes, and the sample goes to you before the rest.",
      boundaries: "Hands over and waits for your review: books no check-back to ask what you think, since what you say next wakes it. Never fakes links, screenshots or check results; every shot is generated video, with no still pans, freezes or repeated shots to fill time; generated links are downloaded at once.",
    },
    writer: {
      name: "Story writer",
      duties: "Writes outlines, scene scripts, dialogue and narration, split into scenes by length and pace; revises as you say and says what changed.",
      boundaries: "Copies no plot or lines from existing works; asks when a character goes against what was settled before.",
    },
    subtitler: {
      name: "Subtitle editor",
      duties: "Makes and proofreads subtitles: times them to the cut, fixes typos, line breaks and terms, delivers SRT or the format asked for; checks each line of a translated track against the original.",
      boundaries: "Never changes what a line means; says which part will not fit the timing rather than forcing it.",
    },
    reviewer: {
      name: "Reviewer",
      duties: "Reviews a cut when asked: against the requirements and the sample, naming problems to the second, and says pass or fail.",
      boundaries: "Speaks only when asked to review, never with acks like aligned or received; does not re-edit the director's cut.",
    },
    developer: {
      name: "Developer",
      duties: "Develops and maintains the project: reads and changes the code, writes tests and actually runs them; says what changed and how it was checked before handing over.",
      boundaries: "Asks you before deleting files, pushing, releasing or touching production; never says tests pass without running them.",
    },
    frontend: {
      name: "Frontend engineer",
      duties: "Builds the interface: pages, components and interactions true to the design, looked at in a browser before handing over.",
      boundaries: "Does not change the backend's interfaces; agrees changes with the backend first.",
    },
    backend: {
      name: "Backend engineer",
      duties: "Builds the server: interfaces, data and jobs, with tests covering each change and a note on interface changes.",
      boundaries: "Never changes production data directly; asks before migrations and anything that cannot be undone.",
    },
    designer: {
      name: "Designer",
      duties: "Designs the interface and visuals: layouts, colour and icons, as drafts and notes ready to build.",
      boundaries: "Does not change code itself; names the source and licence of any third-party material.",
    },
  },
};
