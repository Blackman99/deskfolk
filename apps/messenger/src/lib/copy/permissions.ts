import type { CopyShape } from "./shape.ts";

/** Permission modes (ADR 0092): Settings › General, the Bot panel and the approval card. */
export const zh = {
  title: "权限模式",
  subtitle: "Bot 不问你就能做什么，和路径在不在工作区里无关。某个 Bot 要不一样，在它的面板里另选。",
  modes: { read_only: "只读", ask_first: "改动先问", auto: "自动", allow_all: "全部允许" },
  descriptions: {
    read_only: "只读文件、查资料；写文件、跑命令、改应用配置都不做。",
    ask_first: "写文件、跑命令、改应用配置，每次都先问你。",
    auto: "写文件、跑命令直接做；加改 MCP、端点和内置提示词先问你。",
    allow_all: "什么都不问，直接做。",
  },
  defaultTag: "默认",
  /** What no mode lets through: refusals, not approvals. */
  alwaysRefused: "任何模式下，Bot 都读不到本机 Agent 的登录凭据，也不会搜遍整个家目录。",
  overrides: (items: string[]) => `自己选了模式的 Bot：${items.join("、")}`,
  overrideItem: (name: string, mode: string) => `${name}（${mode}）`,
  saveFailed: "没改成，再试一次。",
  botLabel: "权限模式",
  follow: (mode: string) => `跟随应用（${mode}）`,
  followHint: (description: string) => `跟随设置 › 通用里的应用权限模式：${description}`,
  /** The approval card's third button and the line under it. */
  allowFromNow: "以后都直接干",
  allowFromNowCovers: (bot: string, mode: string, description: string) => `${bot} 改成「${mode}」：${description}`,
};

export const en: CopyShape<typeof zh> = {
  title: "Permission mode",
  subtitle: "What a Bot may do without asking you, wherever the path is. For a Bot that should differ, choose its own in its panel.",
  modes: { read_only: "Read-only", ask_first: "Ask first", auto: "Auto", allow_all: "Allow all" },
  descriptions: {
    read_only: "Reads files and looks things up; writes no files, runs no commands, changes no setup.",
    ask_first: "Asks you before every file write, command and change to the app's setup.",
    auto: "Writes files and runs commands; asks before adding or changing MCP servers, endpoints or built-in prompts.",
    allow_all: "Asks nothing.",
  },
  defaultTag: "Default",
  alwaysRefused: "In every mode, Bots cannot read your local agents' sign-ins, and never search your whole home folder.",
  overrides: (items: string[]) => `Bots with their own mode: ${items.join(", ")}`,
  overrideItem: (name: string, mode: string) => `${name} (${mode})`,
  saveFailed: "Not changed. Try again.",
  botLabel: "Permission mode",
  follow: (mode: string) => `Follow the app (${mode})`,
  followHint: (description: string) => `Follows the app's permission mode in Settings › General: ${description}`,
  allowFromNow: "Allow from now on",
  allowFromNowCovers: (bot: string, mode: string, description: string) => `${bot} moves to ${mode}: ${description}`,
};
