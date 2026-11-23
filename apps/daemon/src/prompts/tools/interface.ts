import type { ToolDef } from "../tool-schema";

/**
 * The interface tools (ADR 0106, ADR 0117): reading the profile is free; a change applies at once in every
 * window and can be taken back. It is a change, not a change to the app's setup: a Bot that asks
 * first puts up a card, a read-only one is refused.
 */

export const DESCRIBE_INTERFACE: ToolDef = {
  name: "describe_interface",
  description: {
    zh: "读用户的界面方案：改了哪些令牌、用法和文案，用法清单，各窗口套用后的回报（没生效的令牌和原因、被挡住的底线），最近的修改。find 在桌面窗口报上来的目录里搜应用认的令牌（名字或默认值）和应用的文案。只有目录里的令牌起作用：颜色和圆角；字体、字号和布局没有令牌能改。改之前先读，改完过几秒再读一次看回报。",
    en: "Read the user's interface profile: the tokens, behaviour and words changed, the behaviour list, what each window found after applying it (tokens that did not take and why, floors hidden), recent changes. find searches the catalog a desktop window reported: the tokens the app takes (name or default value) and its words. Only tokens in the catalog do anything: colours and corners; no token changes fonts, type sizes or layout. Read it before a change, and again a few seconds after to see the reports.",
  },
  properties: {
    find: { type: "string", description: { zh: "要找的令牌名、颜色值或界面上的字。", en: "A token name, a colour value, or words on screen." } },
  },
};

const MAP = (zh: string, en: string) => ({ type: "object", description: { zh, en } });

export const EDIT_INTERFACE: ToolDef = {
  name: "edit_interface",
  description: {
    zh: "照用户在对话里说的改应用的外观和用法：存下后所有窗口马上套用，能撤销。只在用户开口要时改，别顺手改。tokens 覆盖设计令牌（light / dark / both，值给 null 恢复默认），只用 describe_interface 目录里有的；behaviour 只认清单里的项（内容区毛玻璃用 content_glass，代码配色用 code_theme）；copy 改界面上的字（key 用 describe_interface 的 find 查）；theme / locale 改主题和语言；reset 把几部分恢复成应用自己的（css 清掉旧版本存下的样式）；restore 恢复到某次修改之后的样子。应用不再套用自定义 CSS，字体、字号和布局也没有能改的：用户要这些就照实说现在做不到。停止按钮、等用户的卡片和设置入口不能被盖住：令牌让它们看不清时，那个窗口就停用令牌。改完过几秒用 describe_interface 看哪些没生效。",
    en: "Change how the app looks and works as the user asked in the conversation: once saved every window applies it, and it can be undone. Only when the user asks; never on your own. tokens override design tokens (light / dark / both; null puts one back), only ones in describe_interface's catalog; behaviour takes only what is on its list (glass content is content_glass, code colours code_theme); copy changes words on screen (find their keys with describe_interface); theme / locale change the theme and language; reset puts parts back to the app's own (css clears a stylesheet an earlier version saved); restore goes back to how it was after a given change. The app no longer applies a stylesheet of the user's, and nothing changes fonts, type sizes or layout: when the user wants those, say plainly it cannot be done for now. Stop, the cards waiting on the user and the way to Settings must stay readable: where tokens make them hard to see, that window drops the tokens. A few seconds after, read describe_interface for what did not take.",
  },
  properties: {
    reason: { type: "string", description: { zh: "一句：用户要的是什么。", en: "A sentence: what the user asked for." } },
    tokens: {
      type: "object",
      description: { zh: "{ light?, dark?, both? }，每个是 {\"--令牌\": \"值\" 或 null}。", en: "{ light?, dark?, both? }, each {\"--token\": \"value\" or null}." },
      properties: {
        light: MAP("浅色下的令牌。", "Tokens in the light look."),
        dark: MAP("深色下的令牌。", "Tokens in the dark look."),
        both: MAP("两种都设。", "Tokens in both."),
      },
    },
    behaviour: {
      type: "object",
      description: { zh: "清单里的用法；给 null 恢复默认。", en: "Behaviour from the list; null puts one back." },
      properties: {
        focus_mode: { type: ["boolean", "null"], description: { zh: "专注模式。", en: "Focus mode." } },
        open_placement: MAP("每种窗口在桌面上从哪打开：{\"preview\": \"float\"}。", "Where each kind of window opens on the desktop: {\"preview\": \"float\"}."),
        send_key: { type: ["string", "null"], enum: ["enter", "mod_enter"], description: { zh: "哪个键发送。", en: "Which key sends." } },
        time_format: { type: ["string", "null"], enum: ["24h", "12h"], description: { zh: "时间格式。", en: "Time format." } },
        motion: { type: ["string", "null"], enum: ["system", "reduce"], description: { zh: "动效。", en: "Motion." } },
        content_glass: { type: ["string", "null"], enum: ["solid", "frosted", "clear"], description: { zh: "内容区毛玻璃（只在有窗口材质的桌面上）。", en: "Glass content cards (on a desktop whose window has a material)." } },
        code_theme: MAP("代码高亮配色，按外观各选一个：{\"light\": \"solarized-light\", \"dark\": \"dracula\"}；名单见 describe_interface。", "Code colours, one per look: {\"light\": \"solarized-light\", \"dark\": \"dracula\"}; the list is in describe_interface."),
      },
    },
    copy: {
      type: "object",
      description: { zh: "{ zh?, en? }，每个是 {\"键\": \"新的字\" 或 null}。", en: "{ zh?, en? }, each {\"key\": \"new words\" or null}." },
      properties: { zh: MAP("中文界面的字。", "Words in Chinese."), en: MAP("英文界面的字。", "Words in English.") },
    },
    theme: { type: "string", enum: ["system", "light", "dark"], description: { zh: "主题。", en: "Theme." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "界面语言。", en: "The app's language." } },
    enabled: { type: "boolean", description: { zh: "false 暂停令牌和改过的字，用法照旧。", en: "false pauses the tokens and changed words; behaviour still holds." } },
    reset: {
      type: "array",
      items: { type: "string", enum: ["tokens", "behaviour", "css", "copy"] },
      description: { zh: "恢复成应用自己的部分，先于其余改动；css 清掉旧版本存下的样式。", en: "Parts put back to the app's own, before the rest; css clears a stylesheet an earlier version saved." },
    },
    restore: { type: "string", description: { zh: "修改记录的 id：恢复到它之后的样子（不和别的一起给）。", en: "A change's id: go back to how it was after it (alone)." } },
  },
  required: ["reason"],
};
