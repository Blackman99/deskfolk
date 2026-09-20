import { expect, test } from "bun:test";
import { COPY, JAIL_COPY, copyFor } from "./copy.ts";

test("jail copy is the locked 26 sentences", () => {
  expect(JAIL_COPY.zh).toBe(
    "工作区壳把当前目录放在工作区并在启动前检查看得见的路径，不是操作系统囚笼。",
  );
  expect(JAIL_COPY.en).toBe(
    "The workspace shell puts the current directory in the workspace and checks paths visible in the command before start; it is not an operating-system jail.",
  );
});

test("zh and en trees have the same keys and function arities", () => {
  assertSameShape(COPY.zh, COPY.en, "copy");
});

test("the composer labels its icon actions and explains keyboard behavior in both locales", () => {
  expect(COPY.zh.composer.stopGeneration).toBe("停止回复");
  expect(COPY.en.composer.stopGeneration).toBe("Stop reply");
  expect(COPY.zh.chat.sendHintShortcut).toBe("发送（Enter）");
  expect(COPY.en.chat.sendHintShortcut).toBe("Send (Enter)");
  expect(COPY.zh.composer.waitingHint).toContain("回复结束后可发送");
  expect(COPY.en.composer.waitingHint).toContain("Send after the reply ends");
  expect(COPY.zh.chat.replyMessage).toBe("回复");
  expect(COPY.en.chat.replyMessage).toBe("Reply");
  expect(COPY.zh.chat.replyTo("Writer")).toBe("回复 Writer");
  expect(COPY.en.chat.replyTo("Writer")).toBe("Replying to Writer");
  expect(COPY.zh.chat.suggestNext).toBe("建议下一步");
  expect(COPY.en.chat.suggestNext).toBe("Suggested next");
});

test("wizard field errors are the locked 32 sentences", () => {
  expect(COPY.zh.settings.workspaceEmpty).toBe("选择一个本机目录。");
  expect(COPY.en.settings.workspaceEmpty).toBe("Choose a local folder.");
  expect(COPY.zh.settings.workspaceInvalid).toBe(
    "需要本机绝对路径；不能是文件。目录不存在时会自动创建。",
  );
  expect(COPY.en.settings.workspaceInvalid).toBe(
    "Use an absolute local path; it cannot be a file. Missing folders are created.",
  );
  expect(COPY.zh.settings.endpointEmpty).toBe("填写端点 URL。");
  expect(COPY.en.settings.endpointEmpty).toBe("Enter the endpoint URL.");
  expect(COPY.zh.settings.endpointInvalid).toBe("端点必须是 http 或 https 的 URL。");
  expect(COPY.en.settings.endpointInvalid).toBe("The endpoint must be an http or https URL.");
  expect(COPY.zh.settings.keyEmpty).toBe("粘贴端点密钥。");
  expect(COPY.en.settings.keyEmpty).toBe("Paste the endpoint key.");
  expect(COPY.zh.settings.models).toBe("可用模型");
  expect(COPY.en.settings.models).toBe("Available models");
  expect(COPY.zh.settings.defaultModel).toBe("默认模型");
  expect(COPY.en.settings.defaultModel).toBe("Default model");
  expect(COPY.zh.settings.modelPrice).toBe("价格");
  expect(COPY.en.settings.modelPrice).toBe("Price");
  expect(COPY.zh.settings.modelThinking).toBe("思考等级");
  expect(COPY.en.settings.modelThinking).toBe("Thinking levels");
  expect(COPY.zh.settings.modelStrengths).toBe("擅长领域");
  expect(COPY.en.settings.modelStrengths).toBe("Strengths");
  expect(COPY.zh.settings.saveFailed).toBe("没能保存。");
  expect(COPY.en.settings.saveFailed).toBe("Couldn’t save.");
});

test("provider settings chrome lives on settings.*", () => {
  expect(COPY.zh.settings.providerAdd).toBe("添加端点");
  expect(COPY.en.settings.providerAdd).toBe("Add endpoint");
  expect(COPY.zh.settings.providerEdit).toBe("编辑端点");
  expect(COPY.en.settings.providerEdit).toBe("Edit endpoint");
  expect(COPY.zh.settings.providerEmpty).toBe("还没有模型端点。");
  expect(COPY.en.settings.providerEmpty).toBe("No model endpoints yet.");
  expect(COPY.zh.settings.providerSetDefault).toBe("设为默认");
  expect(COPY.en.settings.providerSetDefault).toBe("Set as default");
  expect(COPY.zh.settings.providerDelete).toBe("删除");
  expect(COPY.en.settings.providerDelete).toBe("Delete");
  expect(COPY.zh.settings.providerDeleteBody).toBe(
    "删除后，钉了这个端点的 Bot 会改回空钉。若删的是默认端点，默认会换成剩下的第一个。",
  );
  expect(COPY.en.settings.providerDeleteBody).toBe(
    "Bots pinned to this endpoint revert to an empty pin. If this is the default, the first remaining endpoint becomes default.",
  );
  expect(COPY.zh.settings.providerConfirmDelete).toBe("确认删除");
  expect(COPY.en.settings.providerConfirmDelete).toBe("Confirm delete");
  expect(COPY.zh.settings.providerModelCount(2)).toBe("2 个模型");
  expect(COPY.en.settings.providerModelCount(1)).toBe("1 model");
});

test("independent runtime copy stays gated and bilingual", () => {
  expect(COPY.zh.settings.independentRuntime).toBe("独立运行时");
  expect(COPY.en.settings.independentRuntime).toBe("Independent runtime");
  expect(COPY.zh.settings.independentRuntimeGated).toContain("G-pack");
  expect(COPY.en.settings.independentRuntimeGated).toContain("G-pack");
  expect(COPY.zh.settings.independentRuntimeConfirmEnable).toBe("确认开启独立运行时");
  expect(COPY.en.settings.independentRuntimeConfirmDisable).toBe("Disable independent runtime");
});

test("theme settings chrome lives on settings.*", () => {
  expect(COPY.zh.settings.tabPreferences).toBe("基础偏好");
  expect(COPY.en.settings.tabPreferences).toBe("Preferences");
  expect(COPY.zh.settings.theme).toBe("外观");
  expect(COPY.en.settings.theme).toBe("Appearance");
  expect(COPY.zh.settings.themeSystem).toBe("跟随系统");
  expect(COPY.en.settings.themeSystem).toBe("System");
  expect(COPY.zh.settings.themeLight).toBe("亮色");
  expect(COPY.en.settings.themeLight).toBe("Light");
  expect(COPY.zh.settings.themeDark).toBe("暗色");
  expect(COPY.en.settings.themeDark).toBe("Dark");
});

test("mcp settings chrome lives on settings.*", () => {
  expect(COPY.zh.settings.mcp).toBe("MCP");
  expect(COPY.en.settings.mcp).toBe("MCP");
  expect(COPY.zh.settings.mcpConfirmAdd).toBe("确认添加");
  expect(COPY.en.settings.mcpConfirmAdd).toBe("Confirm add");
  expect(COPY.zh.settings.mcpConfirmEdit).toBe("确认改连接");
  expect(COPY.en.settings.mcpConfirmEdit).toBe("Confirm connection");
  expect(COPY.zh.settings.mcpMustConfirm).toBe(
    "新增和改 command / args / URL / headers 必须确认，没有 Always allow。",
  );
  expect(COPY.en.settings.mcpMustConfirm).toBe(
    "Adding and changing command / args / URL / headers must be confirmed. There is no Always allow.",
  );
  expect(COPY.zh.settings.mcpTransportHttp).toBe("HTTP");
  expect(COPY.en.settings.mcpUrl).toBe("URL");
  expect(COPY.zh.settings.mcpEdit).toBe("编辑 MCP 服务器");
  expect(COPY.en.settings.mcpEdit).toBe("Edit MCP server");
  expect(COPY.zh.settings.mcpSearch).toBe("搜索名称、传输或连接地址");
  expect(COPY.en.settings.mcpSearch).toBe("Search names, transports or connections");
  expect(COPY.zh.settings.mcpNoResults).toBe("没有匹配的 MCP 服务器。");
  expect(COPY.en.settings.mcpNoResults).toBe("No matching MCP servers.");
});

test("profile / archive / delete chrome is the locked 43 sentences on top, stream, sidebar, and detail", () => {
  expect(COPY.zh.top.groupSettings).toBe("群组设置");
  expect(COPY.en.top.groupSettings).toBe("Group settings");
  expect(COPY.zh.top.botSettings).toBe("Bot 设置");
  expect(COPY.en.top.botSettings).toBe("Bot settings");
  expect(COPY.zh.top.profile).toBe("人设");
  expect(COPY.en.top.profile).toBe("Profile");
  expect(COPY.zh.top.archived).toBe("已归档");
  expect(COPY.en.top.archived).toBe("Archived");
  expect(COPY.zh.top.deleted).toBe("已删除");
  expect(COPY.en.top.deleted).toBe("Deleted");
  expect(COPY.zh.sidebar.profile).toBe("人设");
  expect(COPY.en.sidebar.profile).toBe("Profile");
  expect(COPY.zh.sidebar.skills).toBe("技能");
  expect(COPY.en.sidebar.skills).toBe("Skills");
  expect(COPY.zh.sidebar.skillsEmpty).toBe("还没有技能。");
  expect(COPY.en.sidebar.skillsEmpty).toBe("No skills yet.");
  expect(COPY.zh.sidebar.skillAdd).toBe("添加技能");
  expect(COPY.en.sidebar.skillAdd).toBe("Add skill");
  expect(COPY.zh.sidebar.skillName).toBe("名称");
  expect(COPY.en.sidebar.skillName).toBe("Name");
  expect(COPY.zh.sidebar.skillDescription).toBe("何时用");
  expect(COPY.en.sidebar.skillDescription).toBe("When to use");
  expect(COPY.zh.sidebar.skillBody).toBe("怎么干");
  expect(COPY.en.sidebar.skillBody).toBe("How to do it");
  expect(COPY.zh.sidebar.skillEnabled).toBe("启用");
  expect(COPY.en.sidebar.skillEnabled).toBe("Enabled");
  expect(COPY.zh.sidebar.skillNameEmpty).toBe("填写一个名称。");
  expect(COPY.en.sidebar.skillNameEmpty).toBe("Enter a name.");
  expect(COPY.zh.sidebar.skillDescriptionEmpty).toBe("填写何时用。");
  expect(COPY.en.sidebar.skillDescriptionEmpty).toBe("Enter when to use it.");
  expect(COPY.zh.sidebar.skillBodyEmpty).toBe("填写怎么干。");
  expect(COPY.en.sidebar.skillBodyEmpty).toBe("Enter how to do it.");
  expect(COPY.zh.sidebar.skillNameConflict).toBe("这个名称已经有了。");
  expect(COPY.en.sidebar.skillNameConflict).toBe("That name is already used.");
  expect(COPY.zh.sidebar.skillDelete).toBe("删除技能");
  expect(COPY.en.sidebar.skillDelete).toBe("Delete skill");
  expect(COPY.zh.sidebar.skillDeleteBody).toBe("删除后，这个 Bot 下一跳就看不见这条技能。");
  expect(COPY.en.sidebar.skillDeleteBody).toBe(
    "After this, the Bot will not see the skill on the next hop.",
  );
  expect(COPY.zh.sidebar.skillConfirmDelete).toBe("确认删除");
  expect(COPY.en.sidebar.skillConfirmDelete).toBe("Confirm delete");
  expect(COPY.zh.sidebar.skillEdit).toBe("编辑技能");
  expect(COPY.en.sidebar.skillEdit).toBe("Edit skill");
  expect(COPY.zh.sidebar.skillSave).toBe("保存技能");
  expect(COPY.en.sidebar.skillSave).toBe("Save skill");
  expect(COPY.zh.sidebar.skillCancel).toBe("取消");
  expect(COPY.en.sidebar.skillCancel).toBe("Cancel");
  expect(COPY.zh.sidebar.archive).toBe("归档");
  expect(COPY.en.sidebar.archive).toBe("Archive");
  expect(COPY.zh.sidebar.restore).toBe("恢复");
  expect(COPY.en.sidebar.restore).toBe("Restore");
  expect(COPY.zh.sidebar.archiveBody).toBe("从名册移入已归档。会话还在，历史消息保留。");
  expect(COPY.en.sidebar.archiveBody).toBe("Move the bot into Archived. Sessions stay; history is kept.");
  expect(COPY.zh.sidebar.restoreBody).toBe("把这个 Bot 放回名册。");
  expect(COPY.en.sidebar.restoreBody).toBe("Put this bot back on the roster.");
  expect(COPY.zh.sidebar.delete).toBe("删除");
  expect(COPY.en.sidebar.delete).toBe("Delete");
  expect(COPY.zh.sidebar.deleteBody).toBe(
    "删除后，这个 Bot 从名册去掉。会话还在，标题会变成「已删除」。工作区文件不动。",
  );
  expect(COPY.en.sidebar.deleteBody).toBe(
    "This removes the bot from the roster. Sessions stay, titled Deleted. Workspace files are not touched.",
  );
  expect(COPY.zh.sidebar.confirmDelete).toBe("确认删除");
  expect(COPY.en.sidebar.confirmDelete).toBe("Confirm delete");
  expect(COPY.zh.sidebar.cancel).toBe("取消");
  expect(COPY.en.sidebar.cancel).toBe("Cancel");
  expect(COPY.zh.detail.titleGroup).toBe("群组设置");
  expect(COPY.en.detail.titleGroup).toBe("Group settings");
  expect(COPY.zh.detail.titleBot).toBe("Bot 设置");
  expect(COPY.en.detail.titleBot).toBe("Bot settings");
  expect(COPY.zh.detail.botBasics).toBe("Bot 基础信息");
  expect(COPY.en.detail.botBasics).toBe("Bot basics");
  expect(COPY.zh.detail.sessionActions).toBe("会话操作");
  expect(COPY.en.detail.sessionActions).toBe("Actions");
  expect(COPY.zh.detail.dangerZone).toBe("危险区域");
  expect(COPY.en.detail.dangerZone).toBe("Danger Zone");
  expect(COPY.zh.detail.backToGroup).toBe("返回群组设置");
  expect(COPY.en.detail.backToGroup).toBe("Back to group settings");
  expect(COPY.zh.detail.backToBot).toBe("返回 Bot 设置");
  expect(COPY.en.detail.backToBot).toBe("Back to bot settings");
  expect(COPY.zh.detail.saveName).toBe("保存");
  expect(COPY.en.detail.saveName).toBe("Save");
  expect(COPY.zh.detail.pullIn).toBe("拉入");
  expect(COPY.en.detail.pullIn).toBe("Pull in");
  expect(COPY.zh.detail.remove).toBe("移出");
  expect(COPY.en.detail.remove).toBe("Remove");
  expect(COPY.zh.detail.members).toBe("成员");
  expect(COPY.en.detail.members).toBe("Members");
  expect(COPY.zh.detail.saveFailed).toBe("没能保存。");
  expect(COPY.en.detail.saveFailed).toBe("Couldn’t save.");
  expect(COPY.zh.detail.clearHistory).toBe("清空历史");
  expect(COPY.en.detail.clearHistory).toBe("Clear history");
  expect(COPY.zh.detail.clearHistoryBody).toBe(
    "清空后，本会话的消息、轮次和判断都去掉。会话还在。进行中的轮会 Stop。",
  );
  expect(COPY.en.detail.clearHistoryBody).toBe(
    "This removes the session’s messages, turns, and judgements. The session stays. Live turns are stopped.",
  );
  expect(COPY.zh.detail.confirmClearHistory).toBe("确认清空");
  expect(COPY.en.detail.confirmClearHistory).toBe("Confirm clear");
  expect(COPY.zh.detail.deleteGroup).toBe("删除群聊");
  expect(COPY.en.detail.deleteGroup).toBe("Delete group");
  expect(COPY.zh.detail.deleteGroupBody).toBe(
    "删除后，这个群和里面的消息、轮次都去掉。名册上的 Bot 还在。",
  );
  expect(COPY.en.detail.deleteGroupBody).toBe(
    "This removes the group and its messages and turns. Bots on the roster stay.",
  );
  expect(COPY.zh.detail.confirmDeleteGroup).toBe("确认删除");
  expect(COPY.en.detail.confirmDeleteGroup).toBe("Confirm delete");
  expect(COPY.zh.detail.cancel).toBe("取消");
  expect(COPY.en.detail.cancel).toBe("Cancel");
});

test("sidebar search chrome names sessions and messages in both locales", () => {
  expect(COPY.zh.sidebar.search).toBe("搜索会话、消息、文件、日程");
  expect(COPY.en.sidebar.search).toBe("Search sessions, messages, files, routines");
  expect(COPY.zh.sidebar.searchKindMessage).toBe("消息");
  expect(COPY.en.sidebar.searchKindMessage).toBe("Message");
  expect(COPY.zh.sidebar.searchKindSession).toBe("会话");
  expect(COPY.en.sidebar.searchKindSession).toBe("Session");
});

test("sidebar work and unread labels exist in both locales", () => {
  expect(COPY.zh.sidebar.statusRunning).toBe("思考中");
  expect(COPY.en.sidebar.statusRunning).toBe("Thinking");
  expect(COPY.zh.sidebar.statusReplying).toBe("回复中");
  expect(COPY.en.sidebar.statusReplying).toBe("Replying");
  expect(COPY.zh.sidebar.unread).toBe("未读");
  expect(COPY.en.sidebar.unread).toBe("Unread");
  expect(COPY.zh.sidebar.resize).toBe("拖动调整会话列表宽度");
  expect(COPY.en.sidebar.resize).toBe("Drag to resize the session list");
});

test("create-bot and create-group chrome lives on sidebar.*, empty roster on top.emptyRoster", () => {
  expect(COPY.zh.top.emptyRoster).toBe("名册是空的。点名册那一行的 + 建 Bot。");
  expect(COPY.en.top.emptyRoster).toBe(
    "The roster is empty. Use + on the roster row to create a bot.",
  );
  expect(COPY.zh.sidebar.addBot).toBe("新建 Bot");
  expect(COPY.en.sidebar.addBot).toBe("New bot");
  expect(COPY.zh.sidebar.addGroup).toBe("新建群");
  expect(COPY.en.sidebar.addGroup).toBe("New group");
  expect(COPY.zh.sidebar.botName).toBe("名字");
  expect(COPY.en.sidebar.botName).toBe("Name");
  expect(COPY.zh.sidebar.botDuties).toBe("职责");
  expect(COPY.en.sidebar.botDuties).toBe("Duties");
  expect(COPY.zh.sidebar.botBoundaries).toBe("边界");
  expect(COPY.en.sidebar.botBoundaries).toBe("Boundaries");
  expect(COPY.zh.sidebar.botAvatarRefresh).toBe("换一个");
  expect(COPY.en.sidebar.botAvatarRefresh).toBe("Randomize");
  expect(COPY.zh.sidebar.botAvatarStyle).toBe("风格");
  expect(COPY.en.sidebar.botAvatarStyle).toBe("Style");
  expect(COPY.zh.sidebar.botAvatarCustom).toBe("上传图片");
  expect(COPY.en.sidebar.botAvatarCustom).toBe("Upload image");
  expect(COPY.zh.sidebar.botAvatarCustomHint).toBe("PNG、JPEG 或 WebP，最大 8 MB。");
  expect(COPY.en.sidebar.botAvatarCustomHint).toBe("PNG, JPEG, or WebP, up to 8 MB.");
  expect(COPY.zh.sidebar.botAvatarInvalidType).toBe("请选 PNG、JPEG 或 WebP 图片。");
  expect(COPY.en.sidebar.botAvatarInvalidType).toBe("Pick a PNG, JPEG, or WebP image.");
  expect(COPY.zh.sidebar.botAvatarTooLarge).toBe("图片太大了。");
  expect(COPY.en.sidebar.botAvatarTooLarge).toBe("That image is too large.");
  expect(COPY.zh.sidebar.botAvatarDecodeFailed).toBe("没能读这张图片。");
  expect(COPY.en.sidebar.botAvatarDecodeFailed).toBe("Couldn’t read that image.");
  expect(COPY.zh.sidebar.botModel).toBe("模型");
  expect(COPY.en.sidebar.botModel).toBe("Model");
  // Automatic is both: the app picks the model and the level that goes with it.
  expect(COPY.zh.sidebar.botModelDefault).toBe("自动");
  expect(COPY.en.sidebar.botModelDefault).toBe("Automatic");
  expect(COPY.zh.sidebar.botModelAutoHint).toContain("思考等级跟着那个模型走");
  expect(COPY.en.sidebar.botModelAutoHint).toContain("thinking level that goes with it");
  expect(COPY.zh.sidebar.botThinkingHint).toBe("只列这个模型支持的档。换模型时会落到新模型的默认档。");
  expect(COPY.zh.sidebar.groupName).toBe("群名");
  expect(COPY.en.sidebar.groupName).toBe("Group name");
  expect(COPY.zh.sidebar.groupMembers).toBe("成员");
  expect(COPY.en.sidebar.groupMembers).toBe("Members");
  expect(COPY.zh.sidebar.create).toBe("保存");
  expect(COPY.en.sidebar.create).toBe("Save");
  expect(COPY.zh.sidebar.nameEmpty).toBe("填写一个名字。");
  expect(COPY.en.sidebar.nameEmpty).toBe("Enter a name.");
  expect(COPY.zh.sidebar.dutiesEmpty).toBe("填写职责。");
  expect(COPY.en.sidebar.dutiesEmpty).toBe("Enter duties.");
  expect(COPY.zh.sidebar.boundariesEmpty).toBe("填写边界。");
  expect(COPY.en.sidebar.boundariesEmpty).toBe("Enter boundaries.");
  expect(COPY.zh.sidebar.nameConflict).toBe("这个名字已经有了。");
  expect(COPY.en.sidebar.nameConflict).toBe("That name is already used.");
  expect(COPY.zh.sidebar.groupNameEmpty).toBe("填写一个群名。");
  expect(COPY.en.sidebar.groupNameEmpty).toBe("Enter a group name.");
  expect(COPY.zh.sidebar.membersTooFew).toBe("至少挑两个 Bot。");
  expect(COPY.en.sidebar.membersTooFew).toBe("Pick at least two bots.");
  expect(COPY.zh.sidebar.saveFailed).toBe("没能保存。");
  expect(COPY.en.sidebar.saveFailed).toBe("Couldn’t save.");
});

test("about card and update chrome are locked in both locales", () => {
  expect(COPY.zh.settings.tabAbout).toBe("关于");
  expect(COPY.en.settings.tabAbout).toBe("About");
  expect(COPY.zh.settings.sectionAbout).toBe("关于");
  expect(COPY.en.settings.sectionAbout).toBe("About");
  expect(COPY.zh.settings.version("0.1.0")).toBe("版本 0.1.0");
  expect(COPY.en.settings.version("0.1.0")).toBe("Version 0.1.0");
  expect(COPY.zh.settings.checkUpdates).toBe("检查更新");
  expect(COPY.en.settings.checkUpdates).toBe("Check for updates");
  expect(COPY.zh.settings.checkingUpdates).toBe("检查中...");
  expect(COPY.en.settings.checkingUpdates).toBe("Checking...");
  expect(COPY.zh.settings.upToDate).toBe("已是最新版本。");
  expect(COPY.en.settings.upToDate).toBe("You’re on the latest version.");
  expect(COPY.zh.settings.updateAvailable("0.2.0")).toBe("有新版本 0.2.0 可用。");
  expect(COPY.en.settings.updateAvailable("0.2.0")).toBe("Version 0.2.0 is available.");
  expect(COPY.zh.settings.updateDownload).toBe("下载更新");
  expect(COPY.en.settings.updateDownload).toBe("Download update");
  expect(COPY.zh.settings.updateNotes).toBe("查看发布说明");
  expect(COPY.en.settings.updateNotes).toBe("Release notes");
  expect(COPY.zh.settings.updateIgnore).toBe("忽略此版本");
  expect(COPY.en.settings.updateIgnore).toBe("Skip this version");
  expect(COPY.zh.settings.updateFailed).toBe("没能检查更新。");
  expect(COPY.en.settings.updateFailed).toBe("Couldn’t check for updates.");
  expect(COPY.zh.sidebar.updateAvailable).toBe("有新版本");
  expect(COPY.en.sidebar.updateAvailable).toBe("Update available");
});

test("copyFor takes the whole en tree or otherwise zh", () => {
  expect(copyFor("en").settings.save).toBe("Save");
  expect(copyFor("zh").settings.save).toBe("保存");
});

test("live-turn chrome lives on stream and composer, with interpolating redirect copy", () => {
  expect(COPY.zh.stream.mentionUnresolved).toBe("这个 @ 没有匹配到群成员");
  expect(COPY.en.stream.mentionUnresolved).toBe("This @ matches no member here");
  expect(COPY.zh.stream.streaming).toBe("正在写");
  expect(COPY.en.stream.streaming).toBe("streaming");
  expect(COPY.zh.stream.artifactTree).toBe("引用的文件");
  expect(COPY.en.stream.artifactTree).toBe("Cited files");
  expect(COPY.zh.stream.artifactBundle).toBe("工作区文件");
  expect(COPY.en.stream.artifactBundle).toBe("Workspace files");
  expect(COPY.zh.stream.artifactBundleCount(12)).toBe("12 个文件");
  expect(COPY.en.stream.artifactBundleCount(1)).toBe("1 file");
  expect(COPY.en.stream.artifactBundleCount(12)).toBe("12 files");
  expect(COPY.zh.stream.artifactWrap).toBe("换行");
  expect(COPY.en.stream.artifactWrap).toBe("Wrap");
  expect(COPY.zh.stream.artifactSource).toBe("源码");
  expect(COPY.en.stream.artifactSource).toBe("Source");
  expect(COPY.zh.stream.artifactRendered).toBe("预览");
  expect(COPY.en.stream.artifactRendered).toBe("Preview");
  expect(COPY.zh.stream.artifactFind).toBe("查找");
  expect(COPY.en.stream.artifactFind).toBe("Find");
  expect(COPY.zh.stream.artifactFindNext).toBe("下一个");
  expect(COPY.en.stream.artifactFindNext).toBe("Next");
  expect(COPY.zh.sidebar.workspace).toBe("工作区");
  expect(COPY.en.sidebar.workspace).toBe("Workspace");
  expect(COPY.zh.sidebar.workspaceUnset).toBe("先在设置里选择工作区目录。");
  expect(COPY.en.sidebar.workspaceUnset).toBe("Choose a workspace folder in Settings first.");
  expect(COPY.zh.settings.workspaceChoose).toBe("选择文件夹");
  expect(COPY.en.settings.workspaceChoose).toBe("Choose folder");
  expect(COPY.zh.settings.workspaceChange).toBe("更换文件夹");
  expect(COPY.en.settings.workspaceChange).toBe("Change folder");
  expect(COPY.zh.stream.workspaceExplorer).toBe("工作区");
  expect(COPY.en.stream.workspaceExplorer).toBe("Workspace");
  expect(COPY.zh.stream.artifactSave).toBe("保存");
  expect(COPY.en.stream.artifactSave).toBe("Save");
  expect(COPY.zh.stream.artifactDiscard).toBe("丢弃");
  expect(COPY.en.stream.artifactDiscard).toBe("Discard");
  expect(COPY.zh.stream.replying).toBe("回复中");
  expect(COPY.en.stream.replying).toBe("replying");
  expect(COPY.zh.stream.continueInterrupt).toBe("继续");
  expect(COPY.en.stream.continueInterrupt).toBe("Continue");
  expect(COPY.zh.stream.continueInterruptHint).toBe("从中断处继续，不重试断掉的那一下");
  expect(COPY.en.stream.continueInterruptHint).toBe(
    "Continue from the interruption without retrying the cut action",
  );
  expect(COPY.zh.stream.ask).toBe("提问");
  expect(COPY.en.stream.ask).toBe("ask");
  expect(COPY.zh.stream.reply).toBe("回复");
  expect(COPY.en.stream.reply).toBe("Reply");
  expect(COPY.zh.stream.approval).toBe("批准");
  expect(COPY.en.stream.approval).toBe("approval");
  expect(COPY.zh.stream.allowOnce).toBe("允许一次");
  expect(COPY.en.stream.allowOnce).toBe("Allow once");
  expect(COPY.zh.stream.alwaysAllow).toBe("Always allow");
  expect(COPY.en.stream.alwaysAllow).toBe("Always allow");
  expect(COPY.zh.stream.deny).toBe("拒绝");
  expect(COPY.en.stream.deny).toBe("Deny");
  expect(COPY.zh.stream.mcpAuthHintAdd).toBe(
    "允许一次前必须粘贴 Authorization（可含 Bearer）。不会写进转录。",
  );
  expect(COPY.en.stream.mcpAuthHintAdd).toBe(
    "Paste Authorization (Bearer allowed) before Allow once. It is not written into the transcript.",
  );
  expect(COPY.zh.composer.redirect("Writer")).toBe(
    "发送会改道眼前这轮（Writer）。已做完的不回滚。",
  );
  expect(COPY.en.composer.redirect("Writer")).toBe(
    "Send redirects the live turn (Writer). Done work is not rolled back.",
  );
  expect(COPY.zh.composer.forkLive("Writer")).toBe("发送会另开一轮；Writer 当前轮继续。");
  expect(COPY.en.composer.forkLive("Writer")).toBe(
    "Send forks a new turn; Writer's current turn keeps running.",
  );
});

test("the model choice log names the log, the outcomes and the message kinds in both locales", () => {
  expect(COPY.zh.routes.title).toBe("模型选择记录");
  expect(COPY.zh.routes.topAction).toBe("模型选择记录");
  expect(COPY.en.routes.topAction).toBe("Model log");
  expect(COPY.zh.routes.subtitle("视频组", 383)).toBe("视频组 · 383 轮");
  expect(COPY.en.routes.subtitle("Writer", 1)).toBe("Writer · 1 turn");
  expect(COPY.en.routes.subtitle("Writer", 2)).toBe("Writer · 2 turns");
  expect(COPY.zh.routes.subtitleFiltered("视频组", 4, 383)).toBe("视频组 · 4 / 383 轮");
  expect(COPY.en.routes.subtitleFiltered("Writer", 1, 2)).toBe("Writer · 1 of 2 turns");
  expect(COPY.zh.routes.filterFeedback).toBe("有反馈");
  expect(COPY.en.routes.filterBlamed).toBe("Model blamed");
  expect(COPY.zh.routes.filterNoMatch).toBe("没有匹配的记录");
  expect(COPY.en.routes.title).toBe("Model choice log");
  expect(COPY.zh.routes.none).toBe("还没有模型选择记录。");
  expect(COPY.en.routes.none).toBe("No model choices yet.");
  expect(COPY.zh.routes.outcome.live).toBe("进行中");
  expect(COPY.zh.routes.outcome.completed).toBe("完成");
  // A failed completion is not a fifth terminal state for the turn; it is this choice's failure.
  expect(COPY.zh.routes.outcome.failed).toBe("补全失败");
  expect(COPY.en.routes.outcome.failed).toBe("Completion failed");
  expect(COPY.zh.routes.outcome.stopped).toBe("被 Stop");
  expect(COPY.zh.routes.outcome.redirected).toBe("改道");
  expect(COPY.zh.routes.outcome.interrupted).toBe("中断");
  expect(Object.keys(COPY.zh.routes.signature)).toEqual([
    "coding",
    "writing",
    "reasoning",
    "simple",
    "general",
  ]);
  // The chip reads "思考 无", so the log keeps its own short level words instead of "不思考".
  expect(COPY.zh.routes.thinking.none).toBe("无");
  expect(COPY.zh.sidebar.thinkingLevels.none).toBe("不思考");
  expect(COPY.zh.sidebar.thinkingLevels.xhigh).toBe("极高");
  expect(COPY.zh.sidebar.thinkingLevels.max).toBe("最大");
  expect(COPY.en.routes.thinking.none).toBe("None");
  expect(COPY.zh.routes.feedbackCount(2)).toBe("2 条模型反馈");
  expect(COPY.en.routes.feedbackCount(1)).toBe("1 model note");
  expect(COPY.en.routes.feedbackCount(2)).toBe("2 model notes");
});

test("the model choice log covers every fail kind the daemon can record", () => {
  // Mirrors FAIL_REASON in apps/daemon/src/prompts/transcript-copy.ts.
  expect(Object.keys(COPY.zh.routes.failReason).sort()).toEqual([
    "busy",
    "endpoint_error",
    "first_byte",
    "incomplete",
    "no_model",
    "refused",
    "stalled",
    "unreachable",
  ]);
  expect(COPY.zh.routes.failReason.refused).toBe("端点拒绝了这次补全");
  expect(COPY.en.routes.failReason.refused).toBe("Endpoint refused this completion");
  expect(COPY.zh.routes.failReason.incomplete).toBe("回复不完整");
  expect(COPY.en.routes.failReason.incomplete).toBe("Incomplete reply");
});

function assertSameShape(a: unknown, b: unknown, path: string): void {
  if (typeof a === "function" || typeof b === "function") {
    expect(typeof a).toBe("function");
    expect(typeof b).toBe("function");
    expect((a as (...args: never[]) => string).length).toBe(
      (b as (...args: never[]) => string).length,
    );
    return;
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
    return;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  expect({ path, keys: bKeys }).toEqual({ path, keys: aKeys });
  for (const key of aKeys) {
    assertSameShape((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  }
}
