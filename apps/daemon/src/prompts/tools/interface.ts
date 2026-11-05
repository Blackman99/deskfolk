import type { ToolDef } from "../tool-schema";

/**
 * The interface tools (ADR 0106): reading the profile is free; a change applies at once in every
 * window and can be taken back. It is a change, not a change to the app's setup: a Bot that asks
 * first puts up a card, a read-only one is refused.
 */

export const DESCRIBE_INTERFACE: ToolDef = {
  name: "describe_interface",
  description: {
    zh: "读用户的界面方案：改了哪些令牌、用法、自定义 CSS 和文案，用法清单，稳定钩子（[data-ui=\"…\"]），各窗口套用后的回报（没选中的选择器、读不了的值、被挡住的底线），最近的修改。find 搜令牌（名字或默认值）和应用的文案；css_from 从第几个字往后读自定义 CSS。改之前先读，改完过几秒再读一次看回报。",
    en: "Read the user's interface profile: the tokens, behaviour, custom CSS and words changed, the behaviour list, the stable hooks ([data-ui=\"…\"]), what each window found after applying it (selectors matching nothing, values not taken, floors hidden), recent changes. find searches tokens (name or default value) and the app's words; css_from reads the custom CSS from that character on. Read it before a change, and again a few seconds after to see the reports.",
  },
  properties: {
    find: { type: "string", description: { zh: "要找的令牌名、颜色值或界面上的字。", en: "A token name, a colour value, or words on screen." } },
    css_from: { type: "integer", description: { zh: "自定义 CSS 从第几个字读起。", en: "Read the custom CSS from this character on." } },
  },
};

const MAP = (zh: string, en: string) => ({ type: "object", description: { zh, en } });

export const EDIT_INTERFACE: ToolDef = {
  name: "edit_interface",
  description: {
    zh: "照用户在对话里说的改应用的外观和用法：所有窗口立刻生效，能撤销。只在用户开口要时改，别顺手改。tokens 覆盖设计令牌（light / dark / both，值给 null 恢复默认）；behaviour 只认清单里的项；css 是自定义样式（set 整份，或 edits：old + new 替换恰好出现一次的原文、after + add 在后面补、只给 add 追加），选择器用 [data-ui=\"…\"] 钩子，别靠类名，钩子上别写 backdrop-filter、filter、transform（会把弹出的图片和菜单困在窗格里），内容区毛玻璃用 behaviour.content_glass；copy 改界面上的字（key 用 describe_interface 的 find 查）；theme / locale 改主题和语言；reset 把几部分恢复成应用自己的；restore 恢复到某次修改之后的样子。停止按钮、等用户的卡片和设置入口不能被盖住：盖住了，那个窗口就停用令牌和 CSS。改完过几秒用 describe_interface 看回报。",
    en: "Change how the app looks and works as the user asked in the conversation: it applies in every window at once and can be undone. Only when the user asks; never on your own. tokens override design tokens (light / dark / both; null puts one back); behaviour takes only what is on its list; css is a stylesheet of the user's own (set it whole, or edits: old + new replaces a passage occurring once, after + add inserts after one, add alone appends), with [data-ui=\"…\"] hooks as selectors, not class names, and no backdrop-filter, filter or transform on hooks (they shut pictures and menus that pop up inside a pane) — glass content is behaviour.content_glass; copy changes words on screen (find their keys with describe_interface); theme / locale change the theme and language; reset puts parts back to the app's own; restore goes back to how it was after a given change. Stop, the cards waiting on the user and the way to Settings must stay visible: where they are hidden, that window drops the tokens and CSS. A few seconds after, read describe_interface for the reports.",
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
    css: {
      type: "object",
      description: { zh: "{ set: 整份 } 或 { edits: [...] }。", en: "{ set: the whole sheet } or { edits: [...] }." },
      properties: {
        set: { type: "string", description: { zh: "整份自定义 CSS（空字符串清空）。", en: "The whole custom CSS (empty clears it)." } },
        edits: {
          type: "array",
          description: { zh: "1 到 10 处，按顺序套用。", en: "1 to 10 changes, applied in order." },
          items: {
            type: "object",
            properties: {
              old: { type: "string", description: { zh: "要换掉的原文（恰好出现一次）。", en: "Exact text to replace (occurs once)." } },
              new: { type: "string", description: { zh: "换成什么。", en: "What replaces it." } },
              after: { type: "string", description: { zh: "在这段原文后补（恰好出现一次）。", en: "Exact text to insert after (occurs once)." } },
              add: { type: "string", description: { zh: "要补的；单独给就追加到末尾。", en: "Text to insert, or to append when alone." } },
            },
          },
        },
      },
    },
    copy: {
      type: "object",
      description: { zh: "{ zh?, en? }，每个是 {\"键\": \"新的字\" 或 null}。", en: "{ zh?, en? }, each {\"key\": \"new words\" or null}." },
      properties: { zh: MAP("中文界面的字。", "Words in Chinese."), en: MAP("英文界面的字。", "Words in English.") },
    },
    theme: { type: "string", enum: ["system", "light", "dark"], description: { zh: "主题。", en: "Theme." } },
    locale: { type: "string", enum: ["zh", "en"], description: { zh: "界面语言。", en: "The app's language." } },
    enabled: { type: "boolean", description: { zh: "false 暂停令牌和 CSS，用法照旧。", en: "false pauses the tokens and CSS; behaviour still holds." } },
    reset: {
      type: "array",
      items: { type: "string", enum: ["tokens", "behaviour", "css", "copy"] },
      description: { zh: "恢复成应用自己的部分，先于其余改动。", en: "Parts put back to the app's own, before the rest." },
    },
    restore: { type: "string", description: { zh: "修改记录的 id：恢复到它之后的样子（不和别的一起给）。", en: "A change's id: go back to how it was after it (alone)." } },
  },
  required: ["reason"],
};
