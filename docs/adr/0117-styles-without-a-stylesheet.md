# 样式自定义不靠样式表：工具先说真话，再换成一组固定的样式选项 / Styles without a stylesheet: the tools tell the truth first, then a fixed set of style choices

Status: accepted 2026-11-23. Step 1, the tools telling the truth, is implemented. Step 2, the style choices, is decided and not built. For the native app it supersedes [ADR 0106](0106-the-interface-is-yours-too.md)'s stylesheet layer and [ADR 0108](0108-interface-profile-on-nsh.md)'s milestone 2: there is no `classes` layer, and the window reports and catalog are done here.

2026-11-18 起 Svelte 应用删掉了（[ADR 0114](0114-the-svelte-messenger-is-removed.md)），每个窗口和手机页都是 NSH。NSH 不读方案里的 `css`（ADR 0108 决定 1），说好替它的 `classes` 层没做。结果是一串「改成功了但没变化」：

- 设置 › 界面 的 CSS 页照样存字，什么都不套用。
- `edit_interface` 的说明还教 Bot 用 `[data-ui]` 写 CSS，改完读窗口的回报。可 NSH 的窗口什么都不报（`nshLook` 没有 `found` 和 `catalog`），所以 `describe_interface` 里的窗口回报和令牌目录永远是空的。
- `theme.json` 里的 `font`、`mono`、`text-display` 到 `text-micro`、`chat-max-width` 能设，也算进了主题，可没有哪个视图读它们：字号和宽度都写在类名里。

于是 Bot 会说「改好了」，界面却没变，正好违背「应用负责当真」。2026-11-23 你说自己不用自定义 CSS，但 CSS 用不了，就要想一个新办法解决样式自定义。

Since 2026-11-18 the Svelte app is gone (ADR 0114), and every window and the phone's page are NSH. NSH never read the profile's `css` (ADR 0108 decision 1), and the `classes` layer meant to replace it was never built. The result was a run of changes that said done and did nothing:

- Settings › Interface kept saving a stylesheet that nothing applied.
- `edit_interface` still taught Bots to write `[data-ui]` CSS and read the windows' reports, yet NSH windows reported nothing (`nshLook` had no `found` or `catalog`), so `describe_interface` always showed no reports and no catalog.
- `theme.json`'s `font`, `mono`, `text-display` to `text-micro` and `chat-max-width` could be set and went into the theme, but no view reads them: sizes and widths are written in classes.

A Bot would say "done" and nothing changed, the opposite of the app holding work to account. On 2026-11-23 you said you do not use custom CSS yourself, but if CSS cannot work, styles need another way to be customised.

## 决定 / Decisions

1. **没有样式表，也不做按钩子写类名 / No stylesheet, and no classes per hook.** 类名层在 NSH 上靠不住：
   - 没有继承，也没有后代选择器，挂在外层的字号、行距管不到里面的 `Text`；
   - 组件自己写的内联 `style` 会盖过类名；
   - `hidden`、`opacity-0`、`absolute inset-0` 能把停止、批准按钮藏掉或盖住，NSH 又量不出遮挡；
   - 模型给一个它不熟的引擎写类名，正是「说改好了却没变」的来路。

   这里的历史也一样：内容区毛玻璃和代码配色都是先用 CSS 做、做不对，最后收成了固定选项（ADR 0106 的补记）。

   A classes layer is unreliable on NSH:
   - there is no inheritance and no descendant selector, so a size or line height on a container never reaches the `Text` inside;
   - a component's inline `style` beats its classes;
   - `hidden`, `opacity-0` or `absolute inset-0` can hide or cover Stop and the approval buttons, and NSH cannot measure covering;
   - a model writing classes for an engine it does not know is exactly how "done" turns into nothing.

   The history here agrees: glass content and code colours both began as CSS, went wrong, and ended as fixed choices (ADR 0106's addenda).

2. **旧样式照存，只能清掉 / A saved stylesheet is kept, and can only be cleared.**
   - 方案里的 `css` 字段留着：`normalizeInterfaceProfile` 照读，修改记录照存，撤销和恢复会原样带回它。
   - 对它的改动只剩清空，`{ css: { set: "" } }` 或 `reset: ["css"]`。别的写法在协议的 `applyInterfacePatch` 里报 `unsupported`，所以 Bot 的工具、本机接口和手机一样被拒。
   - 拦在协议层，不在工具里：不经工具的 `PATCH /v1/interface` 也要拦住。

   - The profile keeps its `css` field: `normalizeInterfaceProfile` reads it, revisions keep it, and undo or restore bring it back as it was.
   - The only change it takes is clearing, `{ css: { set: "" } }` or `reset: ["css"]`. Anything else is refused as `unsupported` in the protocol's `applyInterfacePatch`, so the Bots' tool, the local API and the phone refuse alike.
   - The refusal lives in the protocol rather than the tool because `PATCH /v1/interface` does not pass through the tool.

3. **工具说真话 / The tools tell the truth.**
   - **说明：** 两个工具的说明删掉 `css`、`css_from` 和钩子。系统指令列出能改的：配色、圆角、代码配色、内容区毛玻璃、哪个键发送、窗口从哪打开、界面上的字、主题和语言；也写明字体、字号、布局和自定义 CSS 现在改不了，要照实告诉用户，别拿别的令牌凑。
   - **`describe_interface`：** 存着旧样式时给 `old_stylesheet` 一句，窗口回报里给 `not_taken`。
   - **`edit_interface`：** 结果说「已存下，所有窗口马上套用」，不再说「已生效」。有目录时，当场点名目录里没有的令牌（`not_taken` 加一句 `warning`）。恢复带回旧样式时也说一句。

   - **Descriptions:** both tools drop `css`, `css_from` and the hooks. The System section lists what can change: colours, corners, code colours, glass content, which key sends, where windows open, words on screen, theme and language. It also says fonts, type sizes, layout and custom CSS cannot change for now, and that the Bot should say so plainly instead of bending other tokens to it.
   - **`describe_interface`:** names a saved stylesheet (`old_stylesheet`) and gives each window's `not_taken`.
   - **`edit_interface`:** says "saved; every window applies it now" rather than "applied". Where a catalog exists, it names at once the tokens the catalog lacks (`not_taken` and a `warning`). A restore that brings an old stylesheet back says so.

4. **原生窗口回报 / Native windows report.**
   - **`found`：** 没生效的令牌写成 `light:--font (not used here)` 或 `light:--accent (value not read)`。不套用样式表，`unmatched` 和 `dropped` 总是空的。
   - **桌面窗口的目录：** 方案能设的令牌按方案里的名字给出（`brand` 报回 `--accent`，`var()` 里也一样改回），连同两种外观下的默认值；应用的字来自没叠过改动的原表（`copyLeaves`）。
   - **补报的时机：** 新连接一来报一次，窗口种类变了也报一次。守护进程只在内存里记回报，方案没变时也不会重新套用；没有这两处补报，守护进程重启以后目录就一直是空的。

   - **`found`:** gives each token that did not take as `light:--font (not used here)` or `light:--accent (value not read)`. No stylesheet is applied, so `unmatched` and `dropped` are always empty.
   - **A desktop window's catalog:** the tokens a profile can set, under the profile's names (`brand` back to `--accent`, inside `var()` too), with the app's value in each look; and the app's words from the tables without overrides (`copyLeaves`).
   - **When it reports again:** on a new connection, and when the kind of window changes. The daemon keeps reports in memory only, and a profile that did not change is not applied again, so without these a restarted daemon would never get a catalog.

5. **没人读的令牌不算位置 / Tokens nothing reads are no place.** `font`、`mono`、`text-display` 到 `text-micro`、`chat-max-width` 设了也报「not used here」，目录里不列。圆角令牌留着：`rounded-(--radius-*)` 类读它们，改了看得见。 / These are reported as not used here and left out of the catalog. The radius tokens stay: the `rounded-(--radius-*)` classes read them, and a change shows.

6. **设置 › 界面 / Settings › Interface.**
   - CSS 那页拿掉。
   - 存着旧样式时，顶上提示一次，能复制或清掉。
   - 回报卡不再列「没选中的选择器」和「丢掉的规则」，「读不了的令牌」改叫「没生效的令牌」。
   - 「全部恢复默认」照旧连旧样式一起清掉。

   - The stylesheet page is gone.
   - A saved stylesheet gets one notice at the top, with Copy and Clear.
   - The reports card no longer lists unmatched selectors or dropped rules, and its unread tokens become tokens that did not take.
   - "Put everything back" still clears an old stylesheet too.

7. **第二步：一组固定的样式选项（定了，没做）/ Step 2: a fixed set of style choices (decided, not built).**
   - **单独一层：** 方案加一层 `style`，和令牌并列，跟令牌一起停：总开关、⌥⇧⌘U、底线没过都停它。用法不受影响。
   - **第一批四个选项：**
     - `radius`：sharp / default / round，换主题的圆角令牌；
     - `elevation`：default / flat，改 `styles.ts` 的 `shadow()` 一处；
     - `chat_width`：narrow / default / wide / full，改 `Composer`、`ProjectChat` 和 `project-chat-composer` 里写死的 760 / 800；
     - `font`：system / rounded / serif，外加等宽字体，经主题的 `font-sans` / `font-mono`。
   - **规矩：** 每个都是协议校验的固定选项，每个值都看得出变化，没有一个能藏住底线。手机上守住触控尺寸，`chat_width` 在窄屏上不起作用。
   - **之后：** 疏密、字号倍数，各自接到读它的视图上再开。
   - **不做的：** 内置配色预设（品牌方向 A 不再提新配色）；ADR 0107 说的第三层，Bot 写的 TSX 界面模块。

   - **A layer of its own:** the profile gains a `style` layer beside the tokens that pauses with them (the switch, ⌥⇧⌘U, a failed floor), leaving behaviour as it is.
   - **The first four choices:**
     - `radius`: sharp / default / round, through the theme's radius tokens;
     - `elevation`: default / flat, through `shadow()` in `styles.ts`;
     - `chat_width`: narrow / default / wide / full, replacing the 760 / 800 written into `Composer`, `ProjectChat` and `project-chat-composer`;
     - `font`: system / rounded / serif, plus a mono, through the theme's `font-sans` / `font-mono`.
   - **Rules:** each is a closed choice the protocol checks, every value visibly changes something, and none can hide a floor. The phone keeps its touch sizes, and `chat_width` does nothing on a narrow screen.
   - **Later:** density and a text scale, each once the views that read it are wired.
   - **Not done:** built-in palettes (brand direction A proposes no new palettes), and ADR 0107's third layer of Bot-written TSX modules.

## 后果 / Consequences

- **你可能看到：** 存过样式的人会在设置里看到一次提示；Bot 不再被教去做不生效的事。
- **手机和平板：** 窗口第一次真的回报了。远程白名单本来就放行，上限 20 KB，不带目录。
- **内置提示词：** 系统指令和两个工具的说明改了字，改过它们的人照 ADR 0064 走合并。

- **What you may notice:** whoever saved a stylesheet sees one notice in Settings, and Bots stop being taught things that do nothing.
- **Phone and tablet:** their windows now really report. The remote allowlist already took it, capped at 20 KB and without a catalog.
- **Built-in prompts:** the System section and the two tools' descriptions changed wording; edited copies merge as ADR 0064 says.

## 取舍 / Trade-offs

- **放弃了「什么都能改」/ Giving up "change anything".**
  CSS 什么都够得着，固定选项只够得着列出来的那几样。换来的是改一个就一定看得到，底线也守得住。要改的东西不在单子上，就照实说改不了，再看值不值得加一个选项。
  CSS reached everything; fixed choices reach only what they list. In return every change shows and the floor holds. What is not on the list is said to be out of reach, and then weighed as a new choice.
- **旧样式不删 / Old stylesheets are not deleted.**
  删掉会改写修改记录，或者让恢复变成「没有变化」。留着不套用，再提示一次，代价最小。
  Deleting would rewrite revisions or turn a restore into no change. Keeping it unapplied, with one notice, costs least.

## 实现 / Implementation

- **协议 / Protocol:** `packages/protocol/src/interface.ts`：`applyInterfacePatch` 只收清空；去掉 `applyCss`、`InterfaceCssEdit`、`INTERFACE_CSS_EDITS_MAX`；`content_glass` 的说明不再提钩子。 / `applyInterfacePatch` takes only clearing; `applyCss`, `InterfaceCssEdit` and `INTERFACE_CSS_EDITS_MAX` are gone; `content_glass`'s description no longer mentions hooks.
- **守护进程 / Daemon:**
  - `prompts/system.ts`（中英两段）、`prompts/tools/interface.ts`；
  - `collab-tools/interface.ts`：去掉 `cssTraps`，加 `tokensSet`、`old_stylesheet`、`not_taken`；`unsupported` 原样交回 Bot，不当成 `conflict`。
  - `prompts/system.ts` (both languages) and `prompts/tools/interface.ts`;
  - `collab-tools/interface.ts`: `cssTraps` gone; `tokensSet`, `old_stylesheet` and `not_taken` added; `unsupported` is passed back to the Bot as it is, not read as a `conflict`.
- **原生应用 / Native app:**
  - `ui/interface/theme.ts`：`NOT_READ`、`catalogTokens`；
  - `ui/interface/look.ts`：`found`、`catalog`、`tokensNotTaken`；
  - `m/interface/controller.svelte.ts`：新连接和窗口种类变了时补报；
  - 设置 › 界面：CSS 页和 `InterfaceCssCard` 删掉，加旧样式的提示，改回报卡和文案。
  - `ui/interface/theme.ts`: `NOT_READ` and `catalogTokens`;
  - `ui/interface/look.ts`: `found`, `catalog` and `tokensNotTaken`;
  - `m/interface/controller.svelte.ts`: reports again on a new connection and on a change of window kind;
  - Settings › Interface: the stylesheet page and `InterfaceCssCard` are gone; there is a notice for an old stylesheet, and the reports card and words are changed.
- **还没做 / Not done:**
  - NSH 里从没调用过 `setAppVersion`，所以回报、目录和修改记录里的应用版本还是 `null`；
  - `ui()` 钩子还挂着，什么都不做；
  - `m/interface/floor.ts` 里还留着网页时代读 DOM 的那份底线检查。
  - NSH never calls `setAppVersion`, so the app version in reports, the catalog and revisions is still `null`;
  - the `ui()` hooks are still in place and do nothing;
  - `m/interface/floor.ts` still holds the floor check from the web page, which read the DOM.
