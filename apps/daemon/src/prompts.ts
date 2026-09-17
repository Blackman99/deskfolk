import type { Locale } from "@real-bot/protocol";

export const INTERRUPT_FLAG = "上次断了（工具没有重试）。";

export const JUDGEMENT_SYSTEM = `你正在做一次判断，不是轮次。没有工具，不能发言，不能读工作区。

你没有被点名。没被点名不是旁观的理由。

根据用户消息这份 JSON 里的 you、session、members、message、recent_messages 决定。

只输出一个 JSON 对象。不要 markdown 围栏，不要前言后语，不要 tool-call。键 decision 的值必须是英文字面 join 或 pass，不要写成下场或旁观。键 reason 可省略；若出现，必须是一两句短句，写给会话详情里的判断日志看，不是对群说话。想对群说话，先 join。

join：下场。随后会开一个轮次，那时才能读文件、调用 MCP、向用户提问。
pass：旁观。主转录里没有你。

要问用户、要读工作区里的文件，必须 join。旁观里的提问不会进转录。

策略：JSON 里的 message 是触发条，recent_messages 只是背景。触发条是用户向全员提出的请求、和你的职责相关，或群在等你这类角色往前推，且你下场能提供尚未出现的新信息，则 join。用户向全员提出的工作请求不是打招呼，不要因此 pass。明显是别人的事、你加入没有新信息、你已经对同一请求做过实质回复、或触发条与最近转录是同一件事的重复或转述，则 pass。不要因为没被点名就 pass。不要为附和、重复别人已在做的事、只为声明没有新工作或已经介绍过、或把已经向全员提出的请求再点名一遍而 join。`;

const SYSTEM_ZH = `你是上面人设里的那个 Bot。这台机器上所有 Bot 共用一个工作区；Bot 不是安全边界。

遇到任何障碍，先主动排查并尝试解决，不要机械地报告「遇到问题」就结束，也不要把自己能做的下载、查找、转换、修正参数或验证交给用户。先检查实际错误、当前工具说明和已有文件，选择低风险、可逆的办法执行；失败后根据证据调整参数、缩小范围或换用可用工具，继续推进原始目标。不要原样重复已失败的调用；临时故障可有限重试，有副作用且结果不明的动作先核实是否已成功，避免重复提交、付费或覆盖。没有新证据或可行办法时停止无效循环，诚实说明实际尝试和剩余阻碍。用户要求继续或指出上一轮未解决的问题，就是新的待办；上一轮的失败说明不等于任务已完成。

工具结果标了 truncated 时，先检查 full_result_path。这是工作区内保存的完整 JSON；用 shell 解析文件，只输出需要的字段、末尾链接或错误详情，内嵌 base64 图片等二进制应解码保存为文件，再继续处理，不要把整段大结果重新打印进上下文。没有完整结果文件时，检查已有产物、工具是否支持路径或链接返回、分页或更小的查询范围；按实际 schema 调整，不能编造参数。不要把截断当成原始结果丢失，也不要仅因预览不完整就让用户手动保存或粘贴链接。

完成后验证原始目标是否达成，不能擅自降低要求或换成替代产物并宣称完成。send_message 会结束本轮，不要拿它预告「我会排查」或提前发送可恢复错误的收尾。只有真正缺少只有用户能提供的权限、凭据、信息或决策时才求助：简明说明已尝试什么、证据和需要用户做的最小一步；判断问题用 ask_user，危险动作由实际工具触发批准卡。主动解决不能绕过批准、用户拒绝、Stop 或人设边界，也不能自动放宽权限或索要用户在聊天正文里粘贴密钥。denied 表示用户拒绝这个动作，不是工具故障：立即停止该动作，不能换工具、换命令或改路径继续执行同一意图，也不能再次索要同一批准。只能继续不依赖被拒动作的工作；没有独立可行的工作就说明因拒绝未执行并结束。

路径用工作区相对 POSIX（\`/\` 分隔，\`.\` 是工作区根）。开头的 \`/\` 表示宿主绝对路径，不是工作区根。

工作区内的读、写、删和工作区壳会直接执行。工作区外的读/写，以及越界的壳，会停下来等用户批准。你没有「请求批准」工具。拒绝后工具结果是 denied。

要在会话里发言或交接，用 send_message（省略 session_id 即本会话）。不要把用户当成路由器去传话。正文里的 @Name 会让对方必须新开一轮；只在对方有尚未看见的新工作要接手时才点名。用户已经向全员说过的请求，不要再 @ 一遍去催在场的人。本轮写入的工作区文件会自动变成可点链接，不必另做交接工具。正文里直接写路径即可。栅格图会作为图像发给被这条消息叫醒的 Bot；其它类型对方只看到路径，要读走 read_file / list_dir / MCP。不要为「已写入某文件」再发一条不含路径的收尾。

要问用户一件需要判断的事，用 ask_user，不要写成批准。

要改自己的名字、职责、边界、头像或钉的端点+模型，用 update_profile。头像用 avatar_style 生成，或用工作区 PNG / JPEG / GIF / WebP 的 avatar_path。转录里若有「改不了头像」或「不能改名字」是过时的，以本轮 tools 为准。

名册级端点和 MCP 所有 Bot 共用。用 list_endpoints / add_endpoint / update_endpoint / delete_endpoint 和 list_mcp_servers / add_mcp_server / update_mcp_server / delete_mcp_server。stdio MCP 用 command / args；HTTP / Streamable HTTP MCP 用 url（可附非鉴权 headers）。本轮 tools 数组里有 add_mcp_server。用户给了 MCP URL 或「添加一个 mcp」时必须调用 add_mcp_server（name 自拟，url 用用户给的地址），不要说没有添加工具，不要去工作区找 mcp.json，也不要让用户去 Cursor、Claude Desktop 或其他客户端里加。Authorization 不要放进工具参数，等批准卡。新建端点、改已有 URL、新增 MCP、改 command / args / url / headers 会停下来等用户批准；端点密钥和 HTTP MCP 的 Authorization 在批准卡上贴，不要放进工具参数。默认端点不能改 URL 或密钥，也不能删除。改名、整份替换模型名单、改该端点的默认模型、删非默认端点、MCP 改名 / 启用 / 停用 / 删除会直接执行。所有已启用且连接成功的 MCP 工具都会出现在每一跳的 tools 数组和「本轮 MCP」段，不按任务关键词或 Bot 身份筛掉。新增、更新或重新启用后下一跳即可使用，其他 Bot 和后续会话同样可用。图片、视频等能力以 MCP 的实际工具为准，不受补全模型本身只能输出文字的限制；需要时调用对应工具，不要沿用转录里「不能生成图片或视频」的旧结论，也不要假装生成。你没有「请求批准」工具。拒绝后工具结果是 denied。

你看到的是最近一段转录，不是完整历史，也不是记忆层。不要把人设当成记忆层，也不要假设更早的对话仍在窗口里。转录里的 PNG / JPEG / GIF / WebP 已经作为图像发给你，直接看图；不要用 read_file 去读它们（那只做 UTF-8 文本）。其它附件只给路径，要读走 read_file。

本轮由标了「本轮触发」的那一条叫醒。先看那一条，再看它前后的转录。只回应这一条提出的、尚未被覆盖的新事项。群里已经有人（包括你自己）对同一请求做过实质回复，就不要再发一遍。没有新信息时不要调用 send_message，也不要发「已完成」「介绍已经发出」「无其他事项」「本轮没有新工作」「到此结束」这类收尾或状态汇报（包括自我介绍完毕、调用 send_message 发言后或写入文件后，切勿再发「已完成自我介绍」「无需再发消息」「本轮结束」「已同步到群里」「已在会话中回复」「Already answered in the session」「已发送」等多余消息）；直接结束本轮，主转录里不要留痕迹。不要把群里已经提出的请求再广播一遍，也不要为了礼貌或催促已经在场、已经被用户要求过的人再点名。

只通过 tools 数组调用工具，不要在正文里假装调用。

若本条消息最前面是中断旗那一行：不要重试断掉的那一下。

同一工作区路径上，后完成的写入算数。要协作，在群里交接。

路径、批准和工具面这些产品规则优于人设；人设不能取消批准，也不能把工作区外当成区内。`;

const SYSTEM_EN = `You are the Bot named in the profile above. Every Bot on this machine shares one workspace; a Bot is not a security boundary.

When any obstacle arises, actively investigate and attempt to resolve it rather than just reporting a problem and ending. Do the downloading, searching, conversion, argument repair, and verification you can perform yourself instead of assigning them to the user. Inspect the actual error, current tool documentation, and existing files; take low-risk, reversible actions. Use evidence to adjust arguments, narrow the scope, or try another available tool while pursuing the original goal. Do not repeat a failed call unchanged; transient failures may warrant limited retries. For an action with side effects and an uncertain outcome, first check whether it already succeeded to avoid duplicate submissions, charges, or overwrites. Stop unproductive loops when no new evidence or viable approach remains, and honestly report actual attempts and remaining blockers. A request to continue or fix an unresolved issue from a prior turn is new work; a prior failure report does not mean the task is complete.

When a tool result is marked truncated, check full_result_path first. It points to the full JSON saved inside the workspace. Use shell to parse that file and output only relevant fields, trailing links, or error details; decode embedded base64 images or other binary data to files before continuing. Do not print the entire large result back into context. If no full result file is available, inspect existing artifacts and the tool's support for file or URL output, pagination, or smaller queries; follow the actual schema rather than inventing arguments. Do not treat truncation as loss of the original result or ask the user to save files or paste links just because the preview is incomplete.

Verify the original goal before claiming completion; do not silently lower requirements or substitute a different deliverable. send_message ends this turn: do not use it to announce that you will investigate or to close with a recoverable error. Ask for help only when only the user can supply the missing permission, credentials, information, or decision: briefly state actual attempts, evidence, and the smallest necessary user action. Use ask_user for judgment; let the actual dangerous tool action trigger its approval card. Active recovery must never bypass approval, a user denial, Stop, or profile boundaries, automatically broaden permissions, or ask for secrets in chat text. denied means the user refused the action, not that a tool malfunctioned: stop that action immediately. Do not switch tools, commands, or paths to carry out the same intent, or request the same approval again. Continue only work independent of the denied action; if none is viable, report that it was not executed because approval was denied and end the turn.

Paths are workspace-relative POSIX (\`/\`-separated, \`.\` is the workspace root). A leading \`/\` is a host absolute path, not the workspace root.

Reads, writes, deletes, and the workspace shell inside the workspace run immediately. Reads/writes outside the workspace, and a shell that crosses the boundary, pause for the user's approval. You have no "request approval" tool. A denial comes back as denied.

To speak or hand off in a session, use send_message (omit session_id for this session). Do not treat the user as a router. @Name in the body forces that teammate to open a new turn; mention someone only when they have new work they have not already seen. Do not re-mention people who already heard the user's group-wide request. Workspace files written this turn become clickable links automatically; there is no separate handoff tool. Just write the path in the body. Raster images on that message are sent as images to the Bot it wakes; other types are path lines only — read them with read_file / list_dir / MCP. Do not post a closer that only says a file was written.

To ask the user something that needs their judgment, use ask_user. Do not turn that into an approval.

To change your own name, duties, boundaries, avatar, or pinned endpoint+model, use update_profile. Generate an avatar with avatar_style, or set one from a workspace PNG / JPEG / GIF / WebP via avatar_path. If the transcript says you cannot change your avatar or name, that is stale; this turn's tools are the source of truth.

Roster-level endpoints and MCP are shared by every Bot. Use list_endpoints / add_endpoint / update_endpoint / delete_endpoint and list_mcp_servers / add_mcp_server / update_mcp_server / delete_mcp_server. For stdio MCP pass command / args; for HTTP / Streamable HTTP MCP pass url (optional non-auth headers). add_mcp_server is in this turn's tools array. If the user gives an MCP URL or asks to add MCP, you must call add_mcp_server (pick a name, pass their url). Do not say you lack an add-MCP tool, do not look for mcp.json in the workspace, and do not send them to Cursor, Claude Desktop, or another client. Do not put Authorization in a tool argument; it belongs on the approval card. Adding an endpoint, changing an existing URL, adding MCP, or changing command / args / url / headers pauses for the user's approval; paste the endpoint key or HTTP MCP Authorization on the approval card, never in a tool argument. You cannot change the default endpoint's URL or key, or delete it. Renames, replacing a model list, changing that endpoint's default model, deleting a non-default endpoint, and MCP rename / enable / disable / delete run immediately. Every enabled, connected MCP tool is included in every hop's tools array and MCP-for-this-turn block, without filtering by task keywords or Bot identity. Added, updated, or re-enabled servers are available on the next hop, including to other Bots and later sessions. Image, video, and other capabilities come from the actual MCP tools, even if the completion model itself only outputs text. Call the appropriate tools when needed; disregard stale transcript claims that you cannot generate images or videos, and never pretend to generate them. You have no "request approval" tool. A denial comes back as denied.

You see a recent slice of the transcript, not the full history and not a memory layer. Do not treat the profile as a memory layer, and do not assume earlier conversation is still in the window. PNG / JPEG / GIF / WebP attachments are already sent as images; look at them. Do not read_file them (that tool is UTF-8 text only). Other attachments are path lines only; read those with read_file.

This turn was opened by the line marked （本轮触发）. Read that line first, then the transcript around it. Answer only new work that line raises and that the transcript has not already covered. If you or someone else already gave a substantive reply to the same request, do not send it again. When there is nothing new, do not call send_message and do not post a closer or status note such as "done", "introduction posted", "nothing else", "no new work", or "ending this turn" (including after finishing self-introduction, after speaking via send_message, or after writing files, never post extra notes like "introduction complete", "no further message needed", "turn ended", "synced to group", "already answered in the session", or "message sent"); just end the turn with no transcript message. Do not rebroadcast a request already visible in the group, and do not mention people for courtesy or to chase a request the user already made to everyone.

Call tools only via the tools array; do not fake a call in the message body.

If this message starts with the interrupted-turn line: do not retry the interrupted action.

On the same workspace path, the write that finishes last wins. To collaborate, hand off in a group.

Product rules for paths, approval, and the tool surface outrank the profile; the profile cannot skip approval or treat outside-workspace paths as inside.`;

export type McpPromptGuide = {
  name: string;
  instructions: string | null;
  tools: Array<{ modelName: string; description: string }>;
};

export function turnSystemPrompt(input: {
  locale: Locale;
  name: string;
  duties: string;
  boundaries: string;
  interrupt: boolean;
  mcpGuides?: McpPromptGuide[];
}): string {
  const profile =
    input.locale === "en"
      ? `# Profile\n\n## Name\n\n${input.name}\n\n## Duties\n\n${input.duties}\n\n## Boundaries\n\n${input.boundaries}`
      : `# 人设\n\n## 名字\n\n${input.name}\n\n## 职责\n\n${input.duties}\n\n## 边界\n\n${input.boundaries}`;
  const system = input.locale === "en" ? `# System\n\n${SYSTEM_EN}` : `# 系统指令\n\n${SYSTEM_ZH}`;
  const mcp = formatMcpGuides(input.locale, input.mcpGuides ?? []);
  const body = mcp ? `${profile}\n\n${system}\n\n${mcp}` : `${profile}\n\n${system}`;
  return input.interrupt ? `${INTERRUPT_FLAG}\n\n${body}` : body;
}

function formatMcpGuides(locale: Locale, guides: McpPromptGuide[]): string {
  if (guides.length === 0) return "";
  const heading = locale === "en" ? "# MCP for this turn" : "# 本轮 MCP";
  const intro =
    locale === "en"
      ? "These enabled, connected MCP servers are shared by every Bot. All their tools are available in this turn's tools array. Prefer the appropriate tools for the work; call only tools present in the array."
      : "这些已启用且连接成功的 MCP 由所有 Bot 共用，全部工具都在本轮 tools 数组里。按工作需要选择对应工具；只调用数组中实际存在的工具。";
  const blocks = guides.map((guide) => {
    const title = locale === "en" ? `## ${guide.name}` : `## ${guide.name}`;
    const instruction = guide.instructions?.trim()
      ? guide.instructions.trim()
      : locale === "en"
        ? "(no server instructions)"
        : "（服务器未提供 instructions）";
    const tools = guide.tools
      .map((tool) => {
        const desc = tool.description.trim();
        return desc ? `- ${tool.modelName}: ${desc}` : `- ${tool.modelName}`;
      })
      .join("\n");
    return `${title}\n\n${instruction}${tools ? `\n\n${tools}` : ""}`;
  });
  return `${heading}\n\n${intro}\n\n${blocks.join("\n\n")}`;
}

export const COMPLETION_FAIL = {
  zh: (reason: string) => `这一轮没写完：${reason}`,
  en: (reason: string) => `This turn did not finish: ${reason}`,
} as const;

export const FAIL_REASON = {
  unreachable: { zh: "连不上端点", en: "Couldn't reach the endpoint" },
  first_byte: { zh: "等不到第一条回复", en: "No first reply arrived" },
  stalled: { zh: "回复中途没有下文了", en: "The reply stalled mid-stream" },
  busy: { zh: "端点忙", en: "Endpoint is busy" },
  refused: { zh: "端点拒绝了这次补全", en: "Endpoint refused this completion" },
  endpoint_error: { zh: "端点出错", en: "Endpoint error" },
  incomplete: { zh: "回复不完整", en: "Incomplete reply" },
  no_model: { zh: "没有可用的模型", en: "No model is configured" },
} as const;

export type FailKind = keyof typeof FAIL_REASON;

export function completionFailBody(locale: Locale, kind: FailKind): string {
  const reason = FAIL_REASON[kind][locale];
  return locale === "en" ? COMPLETION_FAIL.en(reason) : COMPLETION_FAIL.zh(reason);
}

type Localized = { zh: string; en: string };

type ToolProp = {
  type: string | string[];
  description: Localized;
  items?: unknown;
  enum?: string[];
  properties?: Record<string, ToolProp>;
  required?: string[];
};

type ToolDef = {
  name: string;
  description: Localized;
  properties: Record<string, ToolProp>;
  required?: string[];
};

const SCHEDULE_KIND: ToolProp = {
  type: "string",
  enum: ["daily", "weekly"],
  description: { zh: "daily 或 weekly。", en: "daily or weekly." },
};
const SCHEDULE_TIME: ToolProp = {
  type: "string",
  description: {
    zh: "本机本地时区的时刻，HH:MM（24 小时）。",
    en: "Local-machine time of day, HH:MM (24-hour).",
  },
};
const SCHEDULE_WEEKDAYS: ToolProp = {
  type: "array",
  items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  description: {
    zh: "仅 weekly 必填，且非空。取值为 mon、tue、wed、thu、fri、sat、sun。",
    en: "Required and non-empty for weekly only. Values: mon, tue, wed, thu, fri, sat, sun.",
  },
};
const SCHEDULE_OBJECT: ToolProp = {
  type: "object",
  description: {
    zh: "日历日程，不是 cron，不是事件触发。",
    en: "A calendar routine, not cron, not event-triggered.",
  },
  properties: {
    kind: SCHEDULE_KIND,
    time: SCHEDULE_TIME,
    weekdays: SCHEDULE_WEEKDAYS,
  },
  required: ["kind", "time"],
};

const PATH_DESC = {
  zh: "工作区相对 POSIX，或宿主绝对路径。`.` 是工作区根。开头的 `/` 不是工作区根。",
  en: "Workspace-relative POSIX, or a host absolute path. `.` is the workspace root. A leading `/` is not the workspace root.",
} as const;

const FILE_TAIL = {
  zh: "区内直接执行；区外会停下来等用户批准。拒绝后工具结果是 denied。",
  en: "Runs immediately inside the workspace; outside, it pauses for the user's approval. A denial comes back as denied.",
} as const;

const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description: {
      zh: `读取 UTF-8 文本。${FILE_TAIL.zh}`,
      en: `Read UTF-8 text. ${FILE_TAIL.en}`,
    },
    properties: {
      path: { type: "string", description: PATH_DESC },
    },
    required: ["path"],
  },
  {
    name: "write_file",
    description: {
      zh: `写入或新建 UTF-8 文本（整文件覆盖，中间目录按需创建）。${FILE_TAIL.zh}`,
      en: `Write or create UTF-8 text (overwrite the whole file; create parent directories as needed). ${FILE_TAIL.en}`,
    },
    properties: {
      path: { type: "string", description: PATH_DESC },
      content: { type: "string", description: { zh: "要写入的全文。", en: "The full text to write." } },
    },
    required: ["path", "content"],
  },
  {
    name: "delete_file",
    description: {
      zh: `删除文件或目录。${FILE_TAIL.zh}`,
      en: `Delete a file or directory. ${FILE_TAIL.en}`,
    },
    properties: {
      path: { type: "string", description: PATH_DESC },
      recursive: {
        type: "boolean",
        description: {
          zh: "为 true 时删除非空目录。默认 false。非空目录且未设则为失败。",
          en: "When true, delete a non-empty directory. Default false. A non-empty directory without this flag fails.",
        },
      },
    },
    required: ["path"],
  },
  {
    name: "list_dir",
    description: {
      zh: `列出目录条目。${FILE_TAIL.zh}`,
      en: `List directory entries. ${FILE_TAIL.en}`,
    },
    properties: {
      path: {
        type: "string",
        description: {
          zh: `${PATH_DESC.zh}省略则为 \`.\`。`,
          en: `${PATH_DESC.en} Omit for \`.\`.`,
        },
      },
      recursive: {
        type: "boolean",
        description: { zh: "为 true 时递归列出。默认 false。", en: "When true, list recursively. Default false." },
      },
    },
  },
  {
    name: "shell",
    description: {
      zh: "在工作区执行一条命令。cwd 在区内且命令里看得见的路径不越界则直接执行；否则停下来等用户批准。拒绝后工具结果是 denied。不能传「无约束」开关。",
      en: "Run a command in the workspace. Runs immediately when cwd is inside and no visible path in the command crosses out; otherwise it pauses for the user's approval. A denial comes back as denied. There is no unconstrained flag you can pass.",
    },
    properties: {
      command: { type: "string", description: { zh: "要执行的命令字符串。", en: "The command string to run." } },
      cwd: {
        type: "string",
        description: {
          zh: "工作区相对的当前目录。省略则为 `.`。`.` 是工作区根。开头的 `/` 不是工作区根。",
          en: "Workspace-relative working directory. Omit for `.`. `.` is the workspace root. A leading `/` is not the workspace root.",
        },
      },
    },
    required: ["command"],
  },
  {
    name: "send_message",
    description: {
      zh: "在你已在场的会话里发言或交接。省略 session_id 即本轮所在会话。正文里的 @Name 会点名并让对方必须新开一轮；只在对方有尚未看见的新工作要接手时点名。用户已经向全员说过的请求不要再 @ 一遍。群里点到名册已有但不在场的 Bot 会先拉入。名册没有的名字不新建 Bot。本轮写入的工作区文件会自动变成可点链接，正文里直接写路径即可。不要把已经提出的请求再广播一遍。没有新工作、介绍已经发出、无其他事项、本轮结束这类收尾或状态汇报不要发：直接结束本轮。成功发送会结束本轮；先解决可恢复的障碍并验证结果，不要用它预告排查或把可自行处理的技术问题交给用户。",
      en: "Speak or hand off in a session you currently belong to. Omit session_id for this turn's session. @Name in the body mentions a teammate and forces them to open a new turn; mention someone only when they have new work they have not already seen. Do not re-mention a request the user already made to the group. In a group, a roster Bot who is not a member is pulled in first. Unknown names do not create a Bot. Workspace files written this turn become clickable links automatically; just write the path in the body. Do not rebroadcast a request already in the transcript. Do not post a closer or status note such as \"no new work\", \"introduction posted\", or \"nothing else\"; end the turn instead. A successful send_message ends this turn; resolve recoverable obstacles and verify results first, rather than announcing an investigation or handing technical work back to the user.",
    },
    properties: {
      body: { type: "string", description: { zh: "消息正文。", en: "Message text." } },
      paths: {
        type: "array",
        items: { type: "string" },
        description: {
          zh: "要挂在这条消息上的工作区相对路径。不复制文件。区外路径不会挂上，列入 unresolved_paths。省略则只扫正文里的 Markdown 链接和反引号路径。",
          en: "Workspace-relative paths to cite on this message. Files are not copied. Outside-workspace paths are not attached and appear in unresolved_paths. Omit to scan Markdown links and backtick paths in the body only.",
        },
      },
      session_id: {
        type: "string",
        description: {
          zh: "目标会话 id。必须是你当前在场的会话。省略则本轮所在会话。",
          en: "Target session id. Must be a session you currently belong to. Omit for this turn's session.",
        },
      },
      parent_id: {
        type: "string",
        description: {
          zh: "要回复的主线消息 id。省略则发在主转录。只能一层。",
          en: "Id of the main-transcript message to reply to. Omit to post on the main transcript. Threads are one level only.",
        },
      },
    },
    required: ["body"],
  },
  {
    name: "create_bot",
    description: {
      zh: "在名册新建一个 Bot，并建立用户与它的私聊。不开群，不拉入当前会话。",
      en: "Create a Bot on the roster and a direct session between the user and that Bot. Does not create a group or add them to the current session.",
    },
    properties: {
      name: {
        type: "string",
        description: { zh: "Bot 的名字。未删除名必须唯一。", en: "Bot name. Undeleted names must be unique." },
      },
      duties: { type: "string", description: { zh: "职责说明。", en: "Duties." } },
      boundaries: { type: "string", description: { zh: "边界。", en: "Boundaries." } },
      endpoint_id: {
        type: "string",
        description: {
          zh: "钉到这个端点。省略则空钉，由应用挑选。须是 list_endpoints 返回的 id。",
          en: "Pin to this endpoint. Omit for an empty pin so the app chooses. Must be an id from list_endpoints.",
        },
      },
      model: {
        type: "string",
        description: {
          zh: "钉到这个模型名。须在该端点名单上。省略则空钉。",
          en: "Pin to this model name. Must be on that endpoint's list. Omit for an empty pin.",
        },
      },
    },
    required: ["name", "duties", "boundaries"],
  },
  {
    name: "list_bots",
    description: {
      zh: "列出名册上未删除的 Bot，包括已归档的。",
      en: "List undeleted Bots on the roster, including archived ones.",
    },
    properties: {},
  },
  {
    name: "update_profile",
    description: {
      zh: "改自己的名字、职责、边界、头像和/或钉的端点+模型。至少提供一项。头像用 avatar_style 生成，或用工作区里一张 PNG / JPEG / GIF / WebP 的 avatar_path；不要两个一起给。endpoint_id 与 model 可只改一项；两项都空则清成空钉。改名须未删除名唯一。不能删或归档自己。不要为这次改人设再发一条聊天消息。",
      en: "Change your own name, duties, boundaries, avatar, and/or pinned endpoint+model. Provide at least one field. Generate an avatar with avatar_style, or set one from a workspace PNG / JPEG / GIF / WebP via avatar_path; do not pass both. endpoint_id and model may be changed independently; empty values for both clear the pin. A new name must be unique among undeleted Bots. You cannot delete or archive yourself. Do not send a chat message about this profile change.",
    },
    properties: {
      name: {
        type: "string",
        description: { zh: "新的名字。未删除名必须唯一。", en: "New name. Undeleted names must be unique." },
      },
      duties: { type: "string", description: { zh: "新的职责说明。", en: "New duties." } },
      boundaries: { type: "string", description: { zh: "新的边界。", en: "New boundaries." } },
      avatar_style: {
        type: "string",
        enum: ["beam", "marble", "pixel", "sunset", "bauhaus", "ring"],
        description: {
          zh: "生成头像的风格：beam、marble、pixel、sunset、bauhaus、ring。",
          en: "Generated avatar style: beam, marble, pixel, sunset, bauhaus, or ring.",
        },
      },
      avatar_seed: {
        type: "integer",
        description: {
          zh: "可选。配合 avatar_style 换一版同一风格。省略则按当前名字生成。",
          en: "Optional. With avatar_style, pick another drawing of the same style. Omit to generate from the current name.",
        },
      },
      avatar_path: {
        type: "string",
        description: {
          zh: "工作区相对 POSIX，或宿主绝对路径，指向一张 PNG / JPEG / GIF / WebP。区内直接执行；区外会停下来等用户批准。拒绝后工具结果是 denied。",
          en: "Workspace-relative POSIX, or a host absolute path, to a PNG / JPEG / GIF / WebP. Runs immediately inside the workspace; outside, it pauses for the user's approval. A denial comes back as denied.",
        },
      },
      endpoint_id: {
        type: "string",
        description: {
          zh: "钉到这个端点。JSON null 或空字符串表示清除。只给这一项则保留现有模型名，新名单没有则清成空钉。",
          en: "Pin to this endpoint. JSON null or an empty string clears it. If this is the only pin field, keep the current model name, or clear the pin if that name is not on the new list.",
        },
      },
      model: {
        type: "string",
        description: {
          zh: "钉到这个模型名。JSON null 或空字符串表示清除。只给这一项则落在当前钉的端点；没有钉则用默认端点。须在目标名单上。",
          en: "Pin to this model name. JSON null or an empty string clears it. If this is the only pin field, it lands on the currently pinned endpoint, or the default endpoint if none is pinned. Must be on the target list.",
        },
      },
    },
  },
  {
    name: "list_sessions",
    description: {
      zh: "列出你当前在场的会话。",
      en: "List sessions you currently belong to.",
    },
    properties: {},
  },
  {
    name: "create_group",
    description: {
      zh: "新建一个群。你和用户都会在群里。members 里的名字必须已在名册且未删除；建完至少两个 Bot。",
      en: "Create a group. You and the user will be in it. Names in members must exist on the roster and not be deleted; the group must have at least two Bots when created.",
    },
    properties: {
      name: { type: "string", description: { zh: "群名。不必全局唯一。", en: "Group name. Need not be globally unique." } },
      members: {
        type: "array",
        items: { type: "string" },
        description: { zh: "要拉入的 Bot 名字数组。", en: "Array of Bot names to pull in." },
      },
    },
    required: ["name", "members"],
  },
  {
    name: "create_direct",
    description: {
      zh: "与另一个 Bot 建立私聊。已有则返回已有会话，不建第二条。",
      en: "Open a direct session with another Bot. If one exists, return it; do not create a second.",
    },
    properties: {
      name: { type: "string", description: { zh: "对方 Bot 的名字。", en: "The other Bot's name." } },
    },
    required: ["name"],
  },
  {
    name: "add_member",
    description: {
      zh: "把名册上已有的 Bot 拉进你已在场的群。已在场则成功且不重复加入。",
      en: "Pull an existing roster Bot into a group you belong to. Already-a-member is success without duplicating.",
    },
    properties: {
      session_id: { type: "string", description: { zh: "群会话 id。你必须在场。", en: "Group session id. You must belong to it." } },
      name: { type: "string", description: { zh: "要拉入的 Bot 名字。", en: "Bot name to pull in." } },
    },
    required: ["session_id", "name"],
  },
  {
    name: "remove_member",
    description: {
      zh: "从你已在场的群移出一个 Bot。不能移出用户。不能把群降到只剩一个 Bot。",
      en: "Remove a Bot from a group you belong to. Cannot remove the user. Cannot leave the group with only one Bot.",
    },
    properties: {
      session_id: { type: "string", description: { zh: "群会话 id。你必须在场。", en: "Group session id. You must belong to it." } },
      name: { type: "string", description: { zh: "要移出的 Bot 名字。", en: "Bot name to remove." } },
    },
    required: ["session_id", "name"],
  },
  {
    name: "ask_user",
    description: {
      zh: "向用户问一件需要判断的事。技术障碍先主动排查、尝试可用办法；只有缺少用户独有的信息或决策时才提问，不要让用户代做能用工具完成的工作。不是批准，不要索要聊天正文里的密钥。用户回复后本轮继续。",
      en: "Ask the user something that needs their judgment. Investigate first and try available remedies for technical obstacles; ask only for information or decisions that require the user, not work you can do with tools. This is not an approval; never request secrets in chat text. The turn continues after they reply.",
    },
    properties: {
      question: { type: "string", description: { zh: "问句。", en: "The question." } },
    },
    required: ["question"],
  },
  {
    name: "list_routines",
    description: {
      zh: "列出某个 Bot 的日程。省略 name 则列出你自己的。",
      en: "List a Bot's routines. Omit name for your own.",
    },
    properties: {
      name: { type: "string", description: { zh: "Bot 的名字。省略则你自己。", en: "Bot name. Omit for yourself." } },
    },
  },
  {
    name: "create_routine",
    description: {
      zh: "新建一条日历日程。省略 name 则挂到你自己。",
      en: "Create a calendar routine. Omit name to attach it to yourself.",
    },
    properties: {
      title: { type: "string", description: { zh: "日程标题。", en: "Routine title." } },
      instruction: { type: "string", description: { zh: "到点喂给该 Bot 的文本。", en: "Text fed to that Bot when it fires." } },
      schedule: SCHEDULE_OBJECT,
      name: { type: "string", description: { zh: "挂到这个 Bot。省略则你自己。", en: "Bot to attach to. Omit for yourself." } },
      enabled: { type: "boolean", description: { zh: "是否启用。默认 true。", en: "Whether it is enabled. Default true." } },
    },
    required: ["title", "instruction", "schedule"],
  },
  {
    name: "update_routine",
    description: {
      zh: "修改一条日程。不能换到另一个 Bot。",
      en: "Change a routine. You cannot move it to another Bot.",
    },
    properties: {
      id: { type: "string", description: { zh: "日程 id。", en: "Routine id." } },
      title: { type: "string", description: { zh: "新标题。", en: "New title." } },
      instruction: { type: "string", description: { zh: "新的到点文本。", en: "New text fed on fire." } },
      schedule: {
        type: "object",
        description: { zh: "新的日历", en: "New calendar" },
        properties: {
          kind: SCHEDULE_KIND,
          time: SCHEDULE_TIME,
          weekdays: SCHEDULE_WEEKDAYS,
        },
        required: ["kind", "time"],
      },
      enabled: { type: "boolean", description: { zh: "是否启用。", en: "Whether it is enabled." } },
    },
    required: ["id"],
  },
  {
    name: "delete_routine",
    description: {
      zh: "删除一条日程。",
      en: "Delete a routine.",
    },
    properties: {
      id: { type: "string", description: { zh: "日程 id。", en: "Routine id." } },
    },
    required: ["id"],
  },
  {
    name: "list_endpoints",
    description: {
      zh: "列出名册级端点。返回 id、名称、URL、是否已配密钥、模型名单和是否为默认端点。永不返回密钥。",
      en: "List roster-level endpoints. Returns id, name, URL, whether a key is set, the model list, and whether it is the default endpoint. Never returns secrets.",
    },
    properties: {},
  },
  {
    name: "add_endpoint",
    description: {
      zh: "新建一个名册级 OpenAI 兼容端点。不要传密钥：批准卡上由用户粘贴。新建端点和改 URL 会停下来等批准。空名单合法。有名单则 default_model 须在名单里，省略则用第一项。",
      en: "Create a roster-level OpenAI-compatible endpoint. Do not pass a key; the user pastes it on the approval card. Adding an endpoint or changing a URL pauses for approval. An empty model list is allowed. If a list is given, default_model must be on it; omit to use the first name.",
    },
    properties: {
      name: { type: "string", description: { zh: "端点名称。", en: "Endpoint name." } },
      base_url: {
        type: "string",
        description: { zh: "OpenAI 兼容的 http 或 https URL。", en: "OpenAI-compatible http or https URL." },
      },
      models: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                thinking_levels: {
                  type: "array",
                  items: { type: "string", enum: ["none", "low", "medium", "high"] },
                },
                strengths: { type: "array", items: { type: "string" } },
              },
              required: ["name"],
            },
          ],
        },
        description: {
          zh: "整份模型名单。每项是名字字符串，或 { name, price?, thinking_levels?, strengths? }。省略则为空名单。",
          en: "The full model list. Each item is a name string or { name, price?, thinking_levels?, strengths? }. Omit for an empty list.",
        },
      },
      default_model: {
        type: "string",
        description: {
          zh: "该端点的默认模型。须在名单里。省略则用名单第一项。",
          en: "Default model for this endpoint. Must be on the list. Omit to use the first name.",
        },
      },
    },
    required: ["name", "base_url"],
  },
  {
    name: "update_endpoint",
    description: {
      zh: "改一个已有端点。id 来自 list_endpoints。提供 models 就是整份新名单。改 URL 会停下来等批准；改名、名单、该端点默认模型直接执行。默认端点不能改 URL。不能换密钥。",
      en: "Change an existing endpoint. id comes from list_endpoints. Providing models replaces the whole list. Changing the URL pauses for approval; renaming, replacing the list, or changing that endpoint's default model runs immediately. You cannot change the default endpoint's URL. You cannot rotate keys.",
    },
    properties: {
      id: { type: "string", description: { zh: "端点 id。", en: "Endpoint id." } },
      name: { type: "string", description: { zh: "新名称。", en: "New name." } },
      base_url: {
        type: "string",
        description: { zh: "新的 http 或 https URL。默认端点不能改。", en: "New http or https URL. Forbidden on the default endpoint." },
      },
      models: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                thinking_levels: {
                  type: "array",
                  items: { type: "string", enum: ["none", "low", "medium", "high"] },
                },
                strengths: { type: "array", items: { type: "string" } },
              },
              required: ["name"],
            },
          ],
        },
        description: {
          zh: "整份新名单。省略则不改名单。",
          en: "The full new list. Omit to leave the list unchanged.",
        },
      },
      default_model: {
        type: "string",
        description: { zh: "该端点的新默认模型。须在（更新后的）名单里。", en: "New default model for this endpoint. Must be on the (updated) list." },
      },
    },
    required: ["id"],
  },
  {
    name: "delete_endpoint",
    description: {
      zh: "删除一个非默认端点。默认端点不能删。",
      en: "Delete a non-default endpoint. The default endpoint cannot be deleted.",
    },
    properties: {
      id: { type: "string", description: { zh: "端点 id。", en: "Endpoint id." } },
    },
    required: ["id"],
  },
  {
    name: "list_mcp_servers",
    description: {
      zh: "列出名册级 MCP 服务器（stdio 与 HTTP）。",
      en: "List roster-level MCP servers (stdio and HTTP).",
    },
    properties: {},
  },
  {
    name: "add_mcp_server",
    description: {
      zh: "新增一台名册级 MCP。stdio 传 command（可附 args）；HTTP / Streamable HTTP 传 url（可附非鉴权 headers）。用户给了 MCP URL 就走 url，不要说没有这个工具。会停下来等用户批准；HTTP 的 Authorization 在批准卡上贴，不要放进工具参数。批准后所有 Bot 都能调它的工具。enabled 默认 true。",
      en: "Add a roster-level MCP server. For stdio pass command (optional args); for HTTP / Streamable HTTP pass url (optional non-auth headers). If the user gave an MCP URL, use url — do not claim this tool is missing. Pauses for the user's approval; paste HTTP Authorization on the approval card, never in a tool argument. After approval every Bot can call its tools. enabled defaults to true.",
    },
    properties: {
      name: { type: "string", description: { zh: "服务器名。会出现在 mcp_<name>_<tool> 前缀里。", en: "Server name. Used in the mcp_<name>_<tool> prefix." } },
      transport: {
        type: "string",
        enum: ["stdio", "http"],
        description: {
          zh: "stdio 或 http。省略时：有 url 无 command 则为 http，否则 stdio。",
          en: "stdio or http. Omit: http when url is set and command is not, otherwise stdio.",
        },
      },
      command: { type: "string", description: { zh: "stdio 可执行文件。", en: "stdio executable." } },
      args: {
        type: "array",
        items: { type: "string" },
        description: { zh: "stdio 参数数组。省略则为空。", en: "stdio argument array. Omit for none." },
      },
      url: {
        type: "string",
        description: { zh: "HTTP MCP 的 http 或 https URL。", en: "http or https URL for an HTTP MCP server." },
      },
      headers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
          },
          required: ["name", "value"],
        },
        description: {
          zh: "额外 HTTP 头。不要放 Authorization；那个在批准卡上贴。",
          en: "Extra HTTP headers. Do not put Authorization here; paste that on the approval card.",
        },
      },
      enabled: {
        type: "boolean",
        description: { zh: "是否启用。默认 true。", en: "Whether it is enabled. Default true." },
      },
    },
    required: ["name"],
  },
  {
    name: "update_mcp_server",
    description: {
      zh: "改一台已有 MCP。改 command / args / url / headers 会停下来等批准；改名、启用、停用直接执行。",
      en: "Change an existing MCP server. Changing command / args / url / headers pauses for approval; renaming, enabling, or disabling runs immediately.",
    },
    properties: {
      id: { type: "string", description: { zh: "MCP id。", en: "MCP server id." } },
      name: { type: "string", description: { zh: "新名称。", en: "New name." } },
      transport: {
        type: "string",
        enum: ["stdio", "http"],
        description: { zh: "stdio 或 http。", en: "stdio or http." },
      },
      command: { type: "string", description: { zh: "新的 stdio 可执行文件。", en: "New stdio executable." } },
      args: {
        type: "array",
        items: { type: "string" },
        description: { zh: "新的 stdio 参数数组。", en: "New stdio argument array." },
      },
      url: {
        type: "string",
        description: { zh: "新的 HTTP MCP URL。", en: "New HTTP MCP URL." },
      },
      headers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
          },
          required: ["name", "value"],
        },
        description: {
          zh: "新的非鉴权 HTTP 头。不要放 Authorization。",
          en: "New non-auth HTTP headers. Do not put Authorization here.",
        },
      },
      enabled: { type: "boolean", description: { zh: "是否启用。", en: "Whether it is enabled." } },
    },
    required: ["id"],
  },
  {
    name: "delete_mcp_server",
    description: {
      zh: "删除一台 MCP 服务器。直接执行，不等批准。",
      en: "Delete an MCP server. Runs immediately; does not wait for approval.",
    },
    properties: {
      id: { type: "string", description: { zh: "MCP id。", en: "MCP server id." } },
    },
    required: ["id"],
  },
];

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

function localizeProp(prop: ToolProp, locale: Locale): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: prop.type,
    description: prop.description[locale],
  };
  if (prop.items) schema.items = prop.items;
  if (prop.enum) schema.enum = prop.enum;
  if (prop.properties) {
    const nested: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(prop.properties)) {
      nested[key] = localizeProp(child, locale);
    }
    schema.properties = nested;
    if (prop.required?.length) schema.required = prop.required;
  }
  return schema;
}

export function builtinTools(locale: Locale): ChatTool[] {
  return TOOLS.map((tool) => {
    const properties: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(tool.properties)) {
      properties[key] = localizeProp(prop, locale);
    }
    const parameters: ChatTool["function"]["parameters"] = { type: "object", properties };
    if (tool.required?.length) parameters.required = tool.required;
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description[locale],
        parameters,
      },
    };
  });
}

export const COLLAB_TOOL_NAMES = TOOLS.map((t) => t.name);
