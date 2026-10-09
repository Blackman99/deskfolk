import type { CopyShape } from "./shape.ts";

/** Settings › Behavior › where each kind of window opens on the workbench. */
export const zh = {
  title: "窗口打开方式",
  subtitle: "宽窗口里，一种窗口还没开着时放在哪。已经开着的只会切过去，不会再开一个。",
  kinds: {
    chat: { name: "会话", hint: "你和 Bot、群、文件：侧栏、搜索、通知里点开的" },
    "bot-bot": { name: "Bot ↔ Bot 私聊", hint: "侧栏和消息里「开了私聊」点开的" },
    trace: { name: "流程", hint: "消息、会话的右键菜单和标签 ⋯ 里的「流程」" },
    board: { name: "看板", hint: "右键菜单里的「看板」，要点里的任务编号和状态" },
    spec: { name: "要点", hint: "右键菜单里的「要点」，看板上的「在要点里看」" },
    preview: { name: "产物", hint: "附件、消息里的文件链接、流程卡片和任务上的文件" },
    workspace: { name: "工作区", hint: "侧栏底部的「工作区」、⌘O" },
    terminal: { name: "终端", hint: "工具里的「新建终端」、文件树里的「在此位置打开终端」" },
    routines: { name: "日程", hint: "工具里的「日程」" },
    spend: { name: "花费", hint: "工具里的「花费」、菜单栏 视图 › 花费" },
  },
  groups: { tabs: "标签页", split: "分屏：新开一块", side: "相邻窗格：有就放进去，没有再分出", float: "浮窗" },
  placements: {
    tab: "新标签页",
    replace: "替换同类标签",
    "tab-background": "后台新标签页",
    "split-right": "向右分屏",
    "split-down": "向下分屏",
    "split-left": "向左分屏",
    "split-up": "向上分屏",
    "side-right": "右侧窗格",
    "side-down": "下侧窗格",
    "side-left": "左侧窗格",
    "side-up": "上侧窗格",
    float: "浮窗",
  },
  changed: "已改",
  reset: "恢复默认",
  notListed:
    "不在这里的：会话设置和 Bot 资料是会话标签里的侧栏；设置、搜索、新建 Bot 和群这些是弹窗；从某块窗格的「＋」或空窗格里挑的，就放进那一块。",
};

export const en: CopyShape<typeof zh> = {
  title: "Where windows open",
  subtitle: "On a wide window, where a kind of window goes when it is not open yet. One that is open is only brought forward, never opened twice.",
  kinds: {
    chat: { name: "Conversation", hint: "You and a Bot, groups, files: from the sidebar, search and notifications" },
    "bot-bot": { name: "Bot ↔ Bot direct", hint: "From the sidebar and a message's “opened a direct”" },
    trace: { name: "Trace", hint: "Trace in a message's or a conversation's menu and a tab's ⋯" },
    board: { name: "Board", hint: "Board in those menus, and ticket numbers and states in the plan" },
    spec: { name: "Plan", hint: "Plan in those menus, and “See in the plan” on the board" },
    preview: { name: "Artifacts", hint: "Attachments, file links in messages, files on cards and tickets" },
    workspace: { name: "Workspace", hint: "Workspace at the foot of the sidebar, ⌘O" },
    terminal: { name: "Terminal", hint: "New terminal in Tools, and “Open terminal here” in a file tree" },
    routines: { name: "Calendar", hint: "Calendar in Tools" },
    spend: { name: "Spend", hint: "Spend in Tools, and View › Spend in the menu bar" },
  },
  groups: { tabs: "Tabs", split: "Split: a new pane", side: "Neighbouring pane: into it, or split one off", float: "Floating" },
  placements: {
    tab: "New tab",
    replace: "Replace the same kind",
    "tab-background": "New tab in the background",
    "split-right": "Split right",
    "split-down": "Split down",
    "split-left": "Split left",
    "split-up": "Split up",
    "side-right": "Pane on the right",
    "side-down": "Pane below",
    "side-left": "Pane on the left",
    "side-up": "Pane above",
    float: "Floating pane",
  },
  changed: "Changed",
  reset: "Back to defaults",
  notListed:
    "Not here: a conversation's settings and a Bot's profile slide out inside its tab; settings, search, new Bot and new group are dialogs; what you pick from a pane's + or an empty pane goes into that pane.",
};
