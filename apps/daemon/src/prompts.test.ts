import { describe, expect, test } from "bun:test";
import { builtinTools, COMPOSER_SUGGEST_SYSTEM, JUDGEMENT_SYSTEM, turnSystemPrompt, unknownMentionBody } from "./prompts";

describe("prompts", () => {
  test("judgement system has no opening brace", () => {
    expect(JUDGEMENT_SYSTEM.includes("{")).toBe(false);
  });

  test("composer suggest system has no opening brace", () => {
    expect(COMPOSER_SUGGEST_SYSTEM.includes("{")).toBe(false);
  });

  test("turn system with interrupt flag is the locked zh shape", () => {
    const text = turnSystemPrompt({
      locale: "zh",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: true,
    });
    expect(text.startsWith("上次断了（工具没有重试）。\n\n# 人设")).toBe(true);
    expect(text).toContain("## 名字\n\nWriter");
    expect(text).toContain("# 系统指令");
    expect(text).toContain("本轮由标了「本轮触发」的那一条叫醒");
    expect(text).toContain("再看局面和它前后的转录");
    expect(text).toContain("群里已经对同一份产物、同一句结论对齐了");
    expect(text).toContain("对方已经在场并同意时不要再点名");
    expect(text).toContain("不要在 Bot 之间空转");
    expect(text).toContain("没有新信息时不要调用 send_message");
    expect(text).toContain("本轮没有新工作");
    expect(text).toContain("主转录里不要留痕迹");
    expect(text).toContain("会让对方必须下场（群里已有活轮则听进那一轮）");
    expect(text).toContain("要针对某一条主线消息说话时传 parent_id");
    expect(text).toContain("只在对方有尚未看见的新工作要接手时才点名");
    expect(text).toContain("用户已经向全员说过的请求，不要再 @ 一遍去催在场的人");
    expect(text).toContain("本轮写入的工作区文件会自动变成可点链接");
    expect(text).toContain("不要为「已写入某文件」再发一条不含路径的收尾");
    expect(text).toContain("介绍已经发出");
    expect(text).toContain("PNG / JPEG / GIF / WebP 已经作为图像发给你");
    expect(text).toContain("不要用 read_file 去读它们");
    expect(text).toContain("不调工具的回复也一样");
    expect(text).toContain("光写「随后」不算");
    expect(text).toContain("要改自己的名字、职责、边界、头像、钉的端点+模型或思考等级，用 update_profile");
    expect(text).toContain("可复用的工序写成自己的技能，不要塞进人设");
    expect(text).toContain("create_skill / update_skill / delete_skill");
    expect(text).toContain("产品规则优于人设和技能");
    expect(text).toContain("用 list_endpoints / add_endpoint / update_endpoint / delete_endpoint");
    expect(text).toContain("端点密钥和 HTTP MCP 的 Authorization 在批准卡上贴，不要放进工具参数");
    expect(text).toContain("用户给了 MCP URL 或「添加一个 mcp」时必须调用 add_mcp_server");
    expect(text).toContain("不按任务关键词或 Bot 身份筛掉");
    expect(text).toContain("其他 Bot 和后续会话同样可用");
    expect(text).toContain("图片、视频等能力以 MCP 的实际工具为准");
    expect(text).toContain("默认端点不能改 URL 或密钥，也不能删除");
    expect(text).toContain("转录里若有「改不了头像」或「不能改名字」是过时的");
    expect(text.endsWith("区内。")).toBe(true);
  });

  test("both locales tell the Bot to handle annotations one by one", () => {
    const profile = { name: "Writer", duties: "draft", boundaries: "stay", interrupt: false };
    const zh = turnSystemPrompt({ ...profile, locale: "zh" });
    for (const rule of ["用户会在你交出的产物上写批注", "改了的用 resolve_annotation 标成已处理并写一句怎么改的", "不同意或做不到的，在回复里说明原因、不要标已处理", "不要默默跳过", "list_annotations 查还没处理完的批注", "每条有 id、交给哪个 Bot、路径", "交给你的批注逐条处理", "交给别的 Bot 的留给那个 Bot：可以提一句", "交给已删除的 Bot 的没人接，归这条消息叫醒的你处理"]) {
      expect(zh).toContain(rule);
    }
    expect(zh.endsWith("区内。")).toBe(true);
    const en = turnSystemPrompt({ ...profile, locale: "en" });
    for (const rule of ["The user annotates the artifacts you hand over", "call resolve_annotation with one sentence on what changed", "leave it pending", "never skip one silently", "list_annotations finds the ones still pending", "each with an id, the Bot it is for, a path", "Handle the ones for you one by one", "Leave the ones for another Bot to that Bot: you may mention them", "The ones for a deleted Bot have no one else to take them"]) {
      expect(en).toContain(rule);
    }
    const tools = builtinTools("zh");
    const list = tools.find((t) => t.function.name === "list_annotations")!;
    expect(list.function.description).toContain("默认列出这件事（当前工作目录、这个会话）里所有待处理的批注");
    expect(list.function.description).toContain("for_bot（交给了哪个 Bot）");
    expect(list.function.description).toContain("交给别的 Bot 的留给它，可以提一句");
    expect(list.function.description).toContain("路径和 read_file 一样解析，工作区外的路径会报错");
    const resolve = tools.find((t) => t.function.name === "resolve_annotation")!;
    expect(resolve.function.parameters.required).toEqual(["id", "note"]);
    expect(resolve.function.description).toContain("不能重新打开、不能删、不能新建批注");
    expect(resolve.function.description).toContain("只标交给你的批注（交给已删除的 Bot 的也算你的）；交给别的 Bot 的留给它");
    const enTools = builtinTools("en");
    expect(enTools.find((t) => t.function.name === "list_annotations")!.function.description).toContain("leave the ones for another Bot to that Bot (you may mention them)");
    expect(enTools.find((t) => t.function.name === "resolve_annotation")!.function.description).toContain("Mark only the ones handed to you");
    expect(builtinTools("en").find((t) => t.function.name === "resolve_annotation")!.function.description).toContain("You cannot reopen, delete, or create annotations");
  });

  test("every locale requires active recovery before asking the user", () => {
    const profile = { name: "Writer", duties: "draft", boundaries: "stay", interrupt: false };
    const zh = turnSystemPrompt({ ...profile, locale: "zh" });
    for (const rule of [
      "遇到任何障碍，先主动排查并尝试解决",
      "不要原样重复已失败的调用",
      "full_result_path",
      "不要把截断当成原始结果丢失",
      "先核实是否已成功",
      "验证原始目标是否达成",
      "不能擅自降低要求或换成替代产物",
      "真正缺少只有用户能提供的权限、凭据、信息或决策",
      "send_message 会结束本轮",
      "不能绕过批准、用户拒绝、Stop 或人设边界",
      "denied 表示用户拒绝这个动作，不是工具故障",
      "不能换工具、换命令或改路径继续执行同一意图",
    ]) expect(zh).toContain(rule);
    const en = turnSystemPrompt({ ...profile, locale: "en" });
    for (const rule of [
      "When any obstacle arises, actively investigate and attempt to resolve it",
      "Do not repeat a failed call unchanged",
      "full_result_path",
      "Do not treat truncation as loss of the original result",
      "first check whether it already succeeded",
      "Verify the original goal",
      "do not silently lower requirements or substitute a different deliverable",
      "only the user can supply the missing permission, credentials, information, or decision",
      "send_message ends this turn",
      "never bypass approval, a user denial, Stop, or profile boundaries",
      "denied means the user refused the action, not that a tool malfunctioned",
      "Do not switch tools, commands, or paths to carry out the same intent",
    ]) expect(en).toContain(rule);
  });

  test("communication tools leave recoverable technical work to the Bot", () => {
    for (const locale of ["zh", "en"] as const) {
      const tools = builtinTools(locale);
      const ask = tools.find((t) => t.function.name === "ask_user")!.function.description;
      const send = tools.find((t) => t.function.name === "send_message")!.function.description;
      expect(ask).toContain(locale === "zh" ? "先主动排查" : "Investigate first");
      expect(send).toContain(locale === "zh" ? "会结束本轮" : "ends this turn");
    }
  });

  test("enabled skills sit between the profile and the system block", () => {
    const text = turnSystemPrompt({
      locale: "zh",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: false,
      skills: [{ name: "commits", description: "when committing" }],
    });
    expect(text.indexOf("# 人设")).toBeLessThan(text.indexOf("# 技能"));
    expect(text.indexOf("# 技能")).toBeLessThan(text.indexOf("# 系统指令"));
    expect(text).toContain("## commits");
    expect(text).toContain("when committing");
    expect(text).toContain("先 read_skill 再按正文做");
    expect(text).not.toContain("依赖 MCP");
    const withUses = turnSystemPrompt({
      locale: "zh",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: false,
      skills: [{ name: "release", description: "when releasing", uses: ["github", "slack"], unavailable: ["slack"] }],
    });
    expect(withUses).toContain("## release\n\nwhen releasing\n\n依赖 MCP：github、slack（本轮未连接）\n依赖的服务器不在时");
    const allConnected = turnSystemPrompt({
      locale: "en",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: false,
      skills: [{ name: "release", description: "when releasing", uses: ["github"], unavailable: [] }],
    });
    expect(allConnected).toContain("Uses MCP: github");
    expect(allConnected).not.toContain("not connected this turn");
    expect(allConnected).not.toContain("cannot be followed");
    const empty = turnSystemPrompt({
      locale: "zh",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: false,
      skills: [],
    });
    expect(empty).not.toContain("# 技能");
  });

  test("shared MCP instructions append after the locked system block", () => {
    const text = turnSystemPrompt({
      locale: "zh",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: false,
      mcpGuides: [
        {
          name: "github",
          instructions: "GitHub issues and pull requests.",
          tools: [{ modelName: "mcp_github_get_issue", description: "read a GitHub issue" }],
        },
      ],
    });
    expect(text).toContain("# 系统指令");
    expect(text).toContain("# 本轮 MCP");
    expect(text).toContain("这些已启用且连接成功的 MCP 由所有 Bot 共用");
    expect(text).toContain("## github");
    expect(text).toContain("GitHub issues and pull requests.");
    expect(text).toContain("- mcp_github_get_issue: read a GitHub issue");
  });

  test("the roster-level usage note renders above the server's own instructions", () => {
    for (const locale of ["zh", "en"] as const) {
      const text = turnSystemPrompt({
        locale,
        name: "Writer",
        duties: "draft",
        boundaries: "stay",
        interrupt: false,
        mcpGuides: [
          {
            name: "github",
            instructions: "GitHub issues and pull requests.",
            usageNote: "  Only for the real-bot repo; never open PRs from a group turn.  ",
            tools: [{ modelName: "mcp_github_get_issue", description: "read a GitHub issue" }],
          },
          {
            name: "time",
            instructions: null,
            usageNote: null,
            tools: [{ modelName: "mcp_time_now", description: "current time" }],
          },
        ],
      });
      const label = locale === "zh" ? "用法备注：" : "Usage note: ";
      const note = `${label}Only for the real-bot repo; never open PRs from a group turn.`;
      expect(text).toContain(note);
      expect(text.indexOf("## github")).toBeLessThan(text.indexOf(note));
      expect(text.indexOf(note)).toBeLessThan(text.indexOf("GitHub issues and pull requests."));
      // A server without a note renders exactly as before.
      const timeBlock = text.slice(text.indexOf("## time"));
      expect(timeBlock).not.toContain(label);
      expect(timeBlock).toContain(locale === "zh" ? "（服务器未提供 instructions）" : "(no server instructions)");
      expect(text).toContain(locale === "zh" ? "备注优先于服务器说明" : "the note outranks the server's text");
    }
  });

  test("the system block fixes the skill-then-MCP selection order", () => {
    for (const locale of ["zh", "en"] as const) {
      const text = turnSystemPrompt({
        locale,
        name: "Writer",
        duties: "draft",
        boundaries: "stay",
        interrupt: false,
        skills: [{ name: "release", description: "when cutting a release" }],
        mcpGuides: [
          {
            name: "github",
            instructions: null,
            tools: [{ modelName: "mcp_github_get_issue", description: "read a GitHub issue" }],
          },
        ],
      });
      if (locale === "zh") {
        expect(text).toContain("技能是工序，MCP 是能力");
        expect(text).toContain("正文里点到的 MCP 工具按 tools 数组里的名字调用");
        expect(text).toContain("没有匹配的技能时，再按「本轮 MCP」段");
        expect(text).toContain("技能不会新增工具，也不能替代 MCP");
        expect(text).toContain("有匹配的技能时按技能正文选工具");
      } else {
        expect(text).toContain("Skills are procedures, MCP is capability");
        expect(text).toContain("calling any MCP tool the body names by its name in the tools array");
        expect(text).toContain("When no skill matches, pick tools directly from the MCP-for-this-turn block");
        expect(text).toContain("A skill adds no tools and does not replace MCP");
        expect(text).toContain("When a skill matches the task, choose tools per its body");
      }
    }
  });

  test("turn system without a flag starts at the profile block", () => {
    const text = turnSystemPrompt({
      locale: "en",
      name: "Writer",
      duties: "draft",
      boundaries: "stay",
      interrupt: false,
    });
    expect(text.startsWith("# Profile")).toBe(true);
    expect(text).toContain("## Name\n\nWriter");
    expect(text).toContain("# System");
    expect(text).toContain("（本轮触发）");
    expect(text).toContain("forces that teammate to take the floor");
    expect(text).toContain("pass parent_id (one level only)");
    expect(text).toContain("then the situation and the transcript around it");
    expect(text).toContain("If the group already agrees on the same artifact and the same conclusion");
    expect(text).toContain("Do not mention someone who is already present and in agreement");
    expect(text).toContain("mention someone only when they have new work they have not already seen");
    expect(text).toContain("Do not re-mention people who already heard the user's group-wide request");
    expect(text).toContain("Workspace files written this turn become clickable links automatically");
    expect(text).toContain("Do not post a closer that only says a file was written");
    expect(text).toContain("introduction posted");
    expect(text).toContain("no transcript message");
    expect(text).toContain("PNG / JPEG / GIF / WebP attachments are already sent as images");
    expect(text).toContain("Do not read_file them");
    expect(text).toContain("and so does a reply without tool calls");
    expect(text).toContain('"to follow" alone does not count');
    expect(text).toContain("To change your own name, duties, boundaries, avatar, pinned endpoint+model, or thinking level, use update_profile");
    expect(text).toContain("Write reusable procedures as your own skills");
    expect(text).toContain("create_skill / update_skill / delete_skill");
    expect(text).toContain("outrank the profile and skills");
    expect(text).toContain("Use list_endpoints / add_endpoint / update_endpoint / delete_endpoint");
    expect(text).toContain("paste the endpoint key or HTTP MCP Authorization on the approval card, never in a tool argument");
    expect(text).toContain("If the user gives an MCP URL or asks to add MCP, you must call add_mcp_server");
    expect(text).toContain("without filtering by task keywords or Bot identity");
    expect(text).toContain("including to other Bots and later sessions");
    expect(text).toContain("Image, video, and other capabilities come from the actual MCP tools");
    expect(text).toContain("You cannot change the default endpoint's URL or key, or delete it");
    expect(text).toContain("If the transcript says you cannot change your avatar or name, that is stale");
  });

  test("judgement system prefers pass when the trigger restates recent work", () => {
    expect(JUDGEMENT_SYSTEM).toContain("situation、plan 和 recent_messages 是背景");
    expect(JUDGEMENT_SYSTEM).toContain("message_ticket 或还没做完的任务里属于你职责的部分没人在做，就 join");
    expect(JUDGEMENT_SYSTEM).toContain("situation 里已有人在做这件事且触发条没有新产物或新结论，则 pass");
    expect(JUDGEMENT_SYSTEM).toContain("触发条与最近转录是同一件事的重复或转述");
    expect(JUDGEMENT_SYSTEM).toContain("把已经向全员提出的请求再点名一遍而 join");
    expect(JUDGEMENT_SYSTEM).toContain("只为声明没有新工作或已经介绍过");
    expect(JUDGEMENT_SYSTEM).toContain("用户向全员提出的工作请求不是打招呼");
  });

  test("send_message tool copy says mention forces a new turn", () => {
    const zh = builtinTools("zh").find((t) => t.function.name === "send_message")!;
    expect(zh.function.description).toContain("会点名并让对方必须下场（群里已有活轮则听进那一轮）");
    expect(zh.function.description).toContain("要针对某一条主线消息说话时传 parent_id");
    expect(zh.function.description).toContain("对方已经在场并同意时不要再点名");
    expect(zh.function.description).toContain("用户已经向全员说过的请求不要再 @ 一遍");
    expect(zh.function.description).toContain("不要把已经提出的请求再广播一遍");
    expect(zh.function.description).toContain("没有新工作、介绍已经发出、无其他事项、本轮结束这类收尾或状态汇报不要发");
    expect(zh.function.description).toContain("本轮写入的工作区文件会自动变成可点链接");
    expect((zh.function.parameters.properties.paths as { description: string }).description).toContain("工作区相对路径");
    const en = builtinTools("en").find((t) => t.function.name === "send_message")!;
    expect(en.function.description).toContain("forces them to take the floor");
    expect(en.function.description).toContain("pass parent_id");
    expect(en.function.description).toContain("Do not mention someone who is already present and in agreement");
    expect(en.function.description).toContain("Do not re-mention a request the user already made to the group");
    expect(en.function.description).toContain("Do not rebroadcast a request already in the transcript");
    expect(en.function.description).toContain("Do not post a closer or status note such as \"no new work\"");
    expect(en.function.description).toContain("Workspace files written this turn become clickable links automatically");
  });

  test("builtin tools include the file set and shell with locked zh descriptions", () => {
    const tools = builtinTools("zh");
    const names = tools.map((t) => t.function.name);
    expect(names.slice(0, 5)).toEqual(["read_file", "write_file", "delete_file", "list_dir", "shell"]);
    const write = tools.find((t) => t.function.name === "write_file")!;
    expect(write.function.description).toBe(
      "写入或新建 UTF-8 文本（整文件覆盖，中间目录按需创建）。区内直接执行；区外会停下来等用户批准。拒绝后工具结果是 denied。",
    );
    expect((write.function.parameters.properties.path as { description: string }).description).toBe(
      "工作区相对 POSIX，或宿主绝对路径。`.` 是工作区根。开头的 `/` 不是工作区根。",
    );
    const list = tools.find((t) => t.function.name === "list_dir")!;
    expect((list.function.parameters.properties.path as { description: string }).description).toBe(
      "工作区相对 POSIX，或宿主绝对路径。`.` 是工作区根。开头的 `/` 不是工作区根。省略则为 `.`。",
    );
  });

  test("update_profile can change name and avatar", () => {
    const zh = builtinTools("zh").find((t) => t.function.name === "update_profile")!;
    expect(zh.function.description).toContain("改自己的名字、职责、边界、头像、钉的端点+模型和/或思考等级");
    expect(zh.function.parameters.properties.thinking_level).toMatchObject({ type: "string" });
    expect(
      (zh.function.parameters.properties.thinking_level as { enum?: unknown }).enum,
    ).toBeUndefined();
    expect(zh.function.description).toContain("avatar_style");
    expect(zh.function.description).toContain("avatar_path");
    expect(zh.function.description).not.toContain("不能改名字");
    expect(zh.function.description).not.toContain("人设变更");
    expect(zh.function.description).toContain("不要为这次改人设再发一条聊天消息");
    expect(Object.keys(zh.function.parameters.properties)).toEqual([
      "name",
      "duties",
      "boundaries",
      "avatar_style",
      "avatar_seed",
      "avatar_path",
      "endpoint_id",
      "model",
      "thinking_level",
    ]);
    const en = builtinTools("en").find((t) => t.function.name === "update_profile")!;
    expect(en.function.description).toContain("Change your own name, duties, boundaries, avatar, pinned endpoint+model, and/or thinking level");
    expect(en.function.description).not.toContain("You cannot rename yourself");
    expect(en.function.description).not.toContain("profile-change");
    expect(en.function.description).toContain("Do not send a chat message about this profile change");
  });

  test("builtin tools include endpoint and MCP catalog CRUD", () => {
    const names = builtinTools("zh").map((t) => t.function.name);
    expect(names).toContain("list_endpoints");
    expect(names).toContain("add_endpoint");
    expect(names).toContain("update_endpoint");
    expect(names).toContain("delete_endpoint");
    expect(names).toContain("list_mcp_servers");
    expect(names).toContain("add_mcp_server");
    expect(names).toContain("update_mcp_server");
    expect(names).toContain("delete_mcp_server");
    const add = builtinTools("zh").find((t) => t.function.name === "add_endpoint")!;
    expect(add.function.description).toContain("不要传密钥");
    expect(Object.keys(add.function.parameters.properties)).not.toContain("api_key");
    const addMcp = builtinTools("zh").find((t) => t.function.name === "add_mcp_server")!;
    expect(addMcp.function.description).toContain("HTTP / Streamable HTTP 传 url");
    expect(Object.keys(addMcp.function.parameters.properties)).toContain("url");
    expect(Object.keys(addMcp.function.parameters.properties)).not.toContain("api_key");
  });

  test("builtin tools include calendar routine CRUD with nested schedule copy", () => {
    const tools = builtinTools("zh");
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("list_routines");
    expect(names).toContain("create_routine");
    expect(names).toContain("update_routine");
    expect(names).toContain("delete_routine");
    expect(names).toContain("list_skills");
    expect(names).toContain("read_skill");
    expect(names).toContain("create_skill");
    expect(names).toContain("update_skill");
    expect(names).toContain("delete_skill");
    const createSkill = tools.find((t) => t.function.name === "create_skill")!;
    expect(createSkill.function.description).toContain("可复用工序写成技能");
    expect(createSkill.function.description).toContain("不要为这次改技能再发一条聊天消息");
    const create = tools.find((t) => t.function.name === "create_routine")!;
    const schedule = create.function.parameters.properties.schedule as {
      description: string;
      properties: { kind: { description: string }; time: { description: string }; weekdays: { description: string } };
    };
    expect(schedule.description).toBe("日历日程，不是 cron，不是事件触发。");
    expect(schedule.properties.kind.description).toBe("daily 或 weekly。");
    expect(schedule.properties.time.description).toBe("本机本地时区的时刻，HH:MM（24 小时）。");
    const update = tools.find((t) => t.function.name === "update_routine")!;
    expect((update.function.parameters.properties.schedule as { description: string }).description).toBe("新的日历");
  });
});

describe("mention spelling", () => {
  test("system and send_message copy demand the exact member name in both locales", () => {
    const base = { name: "Writer", duties: "draft", boundaries: "stay", interrupt: false } as const;
    expect(turnSystemPrompt({ ...base, locale: "zh" })).toContain(
      "名字必须与局面块列出的在场成员逐字一致，不要缩写或省略后缀，写错的 @ 叫不到人。",
    );
    expect(turnSystemPrompt({ ...base, locale: "en" })).toContain(
      "Write the name exactly as the situation block lists it; do not abbreviate or drop a suffix, a misspelt @ wakes nobody.",
    );
    const zh = builtinTools("zh").find((t) => t.function.name === "send_message")!;
    expect(zh.function.description).toContain(
      "群里 @ 的名字必须与在场成员逐字一致，写错会返回 unknown_mention 且消息不会发出。",
    );
    const en = builtinTools("en").find((t) => t.function.name === "send_message")!;
    expect(en.function.description).toContain(
      "In a group, an @ that matches no member exactly fails with unknown_mention and nothing is sent.",
    );
  });

  test("the unknown-mention note names the tokens and the members present", () => {
    expect(unknownMentionBody("zh", ["分镜"], ["选题策划", "分镜师"])).toBe(
      "@分镜 没有匹配到群成员。在场：选题策划、分镜师。点名请逐字写全名。",
    );
    expect(unknownMentionBody("zh", ["分镜"], [])).toBe("@分镜 没有匹配到群成员。在场：（无）。点名请逐字写全名。");
    expect(unknownMentionBody("en", ["storyboard", "x"], ["Writer"])).toBe(
      "@storyboard, @x do not match any member here. Members: Writer. Mention people by their exact full name.",
    );
    expect(unknownMentionBody("en", ["x"], ["Writer"])).toBe(
      "@x does not match any member here. Members: Writer. Mention people by their exact full name.",
    );
  });
});
