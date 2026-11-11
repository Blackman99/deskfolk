# 把信使的界面移植到 NSH

信使（`apps/messenger`，Svelte 5）的界面一屏一屏改写成 NSH 的 TSX（`apps/desktop-nsh/app`）。逻辑不重写：信使 `src/lib` 里的模块已经镜像在 `app/src/m/`（见 README「信使逻辑怎么复用」），界面照旧读同一个运行时、同一份文案、同一套令牌。这份文件是移植的规矩。

## 一个组件怎么对应

- 信使的 `apps/messenger/src/lib/<区域>/<Name>.svelte` 对应 `app/src/ui/<区域>/<Name>.tsx`，同名，一个组件一个文件。顶层的（`src/lib/Select.svelte`）对应 `app/src/ui/<Name>.tsx`。
- 组件导出同名函数：`export function SessionRow(props: {...})`。props 的名字和含义照 Svelte 组件的 `Props`，但 `runtime` 和 `t` 这两个不传：组件里直接 `import { runtime, copy }`，`t.x` 写成 `copy().x`（每个窗口只有一个运行时和一份文案，外壳接线就简单了）；`bind:x` 改成 `x` 加 `onXChange`（或照 nsh/base 的 `value` / `onChange`）；Svelte 的 snippet 改成 `children` 或 render 函数（`(item) => JSX.Element`）。
- 行为、结构、文案、`data-testid` 都照原样：`data-testid="x"` 写成 `testID="x"`，测试按它找。信使的组件测试（`*.test.ts`）说明了它该怎么表现，移植时读一读。
- 单个文件不超过 2000 行（`scripts/line-budget.ts`），过了 1000 行先想清楚拆到哪。

## 逻辑从哪来

- 运行时：`import { runtime, copy } from "../../runtime"`（路径按层数）。`runtime` 就是信使的 `MessengerRuntime`，每个窗口一个；Svelte 组件里的 `runtime.x` 原样写。
- 文案：`copy()` 是 `copyFor(runtime.snapshot.settings.locale)`；Svelte 里的 `t.sidebar.x` 写成 `copy().sidebar.x`（在 JSX 里调用，跟着语言变）。不要自己写中文或英文字面量。
- 其余逻辑：从 `../../m/<同样的相对路径>` 导入（`../../m/sidebar/session-groups.ts`）。`src/m/` 是镜像，**不要改它**；要的模块不在镜像里（README 列了排除的），在报告里说明。
- 不要重新实现 `src/m/` 里已有的函数。Svelte 组件 `<script>` 里只为这个组件写的派生逻辑，搬进 TSX 文件，或者放进 `app/src/ui/<区域>/<name>.ts`（纯函数，好测试）。

## Svelte 写法怎么换成 NSH

| Svelte | NSH TSX |
|---|---|
| `let { a, b } = $props()` | `function X(props: {...})`，在 JSX 里读 `props.a`；**不要解构 props**（解构只读一次，不会跟着变） |
| `let x = $state(0)` | `const x = signal(0)`；读 `x()`，写 `x.set(v)` |
| `$derived(expr)` / `$derived.by(fn)` | `computed(() => expr)` 或直接写函数 `const v = () => expr` |
| `$effect(fn)` | `effect(fn)`（`nsh`），清理用返回函数或 `cleanup` |
| `onMount` / `onDestroy` | 组件函数体里直接做 / `cleanup(fn)` |
| `{#if a}…{:else}…{/if}` | `<If when={a} else={…}>…</If>`；要用值时 `{(v) => …v()…}` |
| `{#each list as item (item.id)}` | `<Each of={list} key={(i) => i.id}>{(item) => …item()…}</Each>`；长列表（会话、消息、文件）用 `List`（虚拟化） |
| `<div>` / `<span>` / `<p>` | `View` / `Text`（文字必须在 `Text` 里） |
| `<button onclick>` | `<View role="button" onPress>`，或用 `src/ui/Button`、`IconButton` |
| `<input bind:value>` / `<textarea>` | `Input`（`nsh/base`）：`value` + `onChange`，`multiline`，`onSubmit`，`onKeyPress`；输入法组字时不要提交（`onCompositionChange`） |
| 菜单、弹出层、对话框 | `nsh/base` 的 `Menu` / `ContextMenu` / `Popover` / `Dialog` / `Sheet` / `AlertDialog` |
| 滚动区 | `Scroll`；要定位、要虚拟化的用 `List` 和它的 ref（`scrollToIndex`、`scrollToEnd`） |
| `bind:this` 拿 DOM 元素 | `ref={(node) => …}` 拿 NSH 的 ref（`focus()`、`measure()`、`scrollTo()`），没有 DOM |
| `window` / `document` 的事件、`addEventListener("keydown")` | `keymap.bind("mod+k", fn)`（`nsh`），组件卸载时自动解绑 |
| `matchMedia` / `@media (max-width: 680px)` / 容器查询 | 断点用 `widthAtMost(680)`（`src/platform/viewport.ts`，缓存的布尔值，窗口跨过断点才通知读者；`narrowWindow()` 就是它），别写 `windowSize().width <= 680`：改窗口大小时每一帧都会让读者重跑，一百多处加起来让排版落后窗口好几秒。要真实尺寸（弹层宽高）才读 `windowSize()`；自己的宽度用 `onLayout` 量；手机布局看 `platform.desktop` 和宽度 |
| `tooltip` / `title=` | `<View tooltip={tip("…")}>`（`src/ui/tip`） |
| `data-ui="x"`（界面钩子） | `class={ui("x", "…原来的类名")}`（`src/ui/interface/hooks`，ADR 0108） |
| `data-floor="x"`（底线） | `ref={floor("x", { ink: "字或图标的令牌", ground: ["底下的令牌", …] })}`（`src/ui/interface/floor`，底从下往上写，颜色可以是函数、不是底线时返回 null）；`Button` 用 `floor="x"`（再加 `floorOn` 说它放在哪种底上，默认 `pane`） |
| 拖动改宽 | `PanResponder` 或 `nsh/base` 的 `ResizablePanelGroup` |
| `{@html …}` / Markdown | `TextView`（`nsh/base`）的 `markdown`，不要拼 HTML |
| 预览生成的 HTML 页面（`<iframe srcdoc>`、blob URL） | `WebView`（`nsh`）的 `html`；页面和应用之间用 `injectedJavaScript` 和 `window.nsh.postMessage` / `onMessage`、ref 的 `postMessage`。**只有 HTML 产物预览和 HTML 批注能用 WebView**，别的界面一律原生 |
| 代码 | `Editor`、`DiffView`（`nsh/base`）；聊天里的代码块由 `TextView` 画 |

## 样式

- 类名用 Tailwind，令牌就是 `tokens.css` 的名字：`var(--ink)` → `text-ink`，`var(--pane)` → `bg-pane`，`var(--line)` → `border-line`，`var(--radius-md)` → `rounded-(--radius-md)`。两个改了名：`--accent` 是 `brand`（`bg-brand`、`text-brand`），`--muted` 是 `ink-muted`。`accent-tint`、`accent-hover` 这些照原名。
- 半透明色用类名的 `/NN`：`color-mix(in srgb, var(--accent) 14%, transparent)` → `bg-brand/14`。不要拿 `token()` 的值自己拼透明度，它给的是 `#rrggbbaa`，按 `#rrggbb` 拼会落空，变成不透明（拖拽分屏的落点框就这样盖住了窗格）。
- 阴影不是令牌：`style={{ boxShadow: shadow("menu") }}`（`src/ui/styles`，按明暗自动换）。字号照信使写字面量（`text-[13px]`），对照表在 `styles.ts` 的 `TEXT`。
- 状态用变体：`hover:`、`active:`、`disabled:`、`focus-visible:`、`group` 加 `group-hover:`、`selected:`、`dark:`。
- **能按的东西自己写出手形指针**：NSH 没有信使 `button { cursor: pointer }` 那样一条管全部的规则，视图的 `class`（或 `style`）里写了 `cursor` 才有手形，`nsh/base` 的 `Tab`、`MenuItem`、`Radio`、`Switch`、`Link` 也都不带。`role` 是 button / menuitem / tab / radio / checkbox / option 的视图写 `cursor-pointer select-none`，带 `disabled` 的再加 `disabled:cursor-default`。`select-none` 不能省：在可选文字的区域（聊天气泡、`MarkdownBody`）里，NSH 先给最里面那段字的 I 形光标，轮不到外面视图的手形；不选的字才让手形露出来，按钮上的字也不会被一起选走。链接（`role="link"`）的字要能选，不写 `select-none`，把 `cursor-pointer` 也写到它的 `Text` 上（字自己的指针比 I 形先算）。`Select`、`Combobox`、`DatePicker` 的选项写在 `itemClass`。背景遮罩、只为挡住点击的视图不写。`scripts/press-cursor.test.ts` 读源码查这几条，故意不要手形的视图登记在它的 `PLAIN` 里。
- **按下去会放大图片的地方是放大镜**（信使的 `cursor: zoom-in`）：消息里的图片附件、Markdown 的图片小标签（框和字都写）、输入框里待发的图片、文件预览里的图片，写 `cursor-zoom-in` 而不是 `cursor-pointer`；放大后的图片是 `zoom-out`，在它上面点一下就关。打开放大的地方把按下的那张图交出去（`chat/image-origin` 的 `PressedPicture`：缩略图自己的视图，不是整个小标签；还有它正显示的 `data:` URL），灯箱从缩略图的位置长出来，先显示这张缩略图，按图片的比例一次长到位，和信使的 `pictureOrigin` / `pictureStandIn` 一样。图片上挂了 `onLongPress`（复制菜单）时它自己就是按下的目标，点击不会落到下面的视图，要关的话它自己也得有 `onPress`。
- 图标：`<Icon name="plus" size={16} class="tint-ink-muted" />`（`src/ui/Icon`），颜色只用 `tint-*` 类，悬停跟随用 `group-hover:tint-ink`。名字照 `src/m/icons.ts`。
- 现成的组件先找 `src/ui/`（见下面「已经移植的共享组件」）。没有的、几个区域都要用的，报告里说，不要各写一份。
- `transition-*`（`transition-all` 也一样）只动颜色、透明度、transform、阴影、圆角，**不动位置和尺寸**：Svelte 里 `transition: top/left/width/height` 的地方照搬过来会直接跳。要动框的位置、大小，在改它的那一次提交之前调 `LayoutAnimation.configureNext({ duration, update: { type: "easeInEaseOut" } })`（只给 `update`，新插入的不跟着动）。它管的是整次提交，同一次里别处的布局变化也会一起动；窗口缩放时别调。例子：`ui/chat/MessageImageLightbox.tsx` 的 `frameBox` 那个 effect。**旁边有大段文字的框改宽度时别用它**：文字当场按终点宽度折好，行里嵌的视图（回复里的路径芯片）各自从旧位置滑过去、压在字上，整段回复也上下跳。这种情况逐帧改宽度，每帧真正重排一次（`requestAnimationFrame`，和拖分隔条一样）；曲线每帧的步子别太大，长回复旁一步 50–100 pt 要重排约 40 ms，十几 pt 跟得上一帧。例子：侧边栏收起展开（`ui/shell/shell-state.ts` 的 `foldSidebar`、`sidebar-fold.ts`）。
- 盖在别的视图上的透明层（标注层这类）不会把按压让给下面的兄弟视图：Svelte 里 `pointer-events: none` 的层，这里要写 `pointerEvents: "box-none"`（自己不接，子视图照接），否则下面的 `onPress` 永远收不到。`app.press(selector)` 直接按指定的视图，测不出这种遮挡。
- `List` 的单元格按创建的先后叠放，core 从不给它们重排，行里的 `z-*` 也出不了自己的单元格：伸出本行、要压在相邻行上的东西（消息的悬停操作条），倒序列表里常被上一行盖住。这种东西放进 `<Overlay anchor={本行的视图} placement=… />`，它画在所有行之上、跟着滚动，但不受列表裁切，要自己在离开列表可视范围时藏起来。例子：`ui/chat/message-pill.tsx`。悬停计数改动要用 `batch` 一次落定，否则中间那一刻「不显示」会让浮层重建，指针下的新浮层收不到进入事件。测试里 `A >> B` 不穿过 Overlay，按它自己的 testID 找。

## 已经移植的共享组件

信使里被几个区域共用的组件，移植好的都在这里，直接导入，不要另写：

| 信使 | NSH | 用法要点 |
|---|---|---|
| `Icon.svelte` | `src/ui/Icon` | `name`、`size`、`filled`、颜色只用 `class="tint-…"`；`iconUri()` 给 `Image` 用 |
| `Button.svelte` | `src/ui/Button` | `variant`（primary / secondary / ghost / danger / danger-soft）、`size`、`icon`、`trailingIcon`、`onPress` |
| `IconButton.svelte` | `src/ui/IconButton` | `icon`、`label`（必填，也是提示）、`size`（xs/sm/md/lg）、`pressed` |
| `Switch.svelte` | `src/ui/Switch` | `checked` + `onChange` |
| 提示 `title=` | `src/ui/tip` | `tooltip={tip("…")}` |
| `Select.svelte` | `src/ui/Select` | `value`、`options`（字符串或 `{ value, label, hint, group, disabled }`）、`onChange`；桌面弹出、手机底部弹出 |
| `MultiSelect.svelte` | `src/ui/MultiSelect` | 多选，选中的成小标签 |
| `BottomSheet.svelte` | `src/ui/BottomSheet` | `open`、`onClose`、`onBack`；行用同文件的 `SheetItem`、`SheetSeparator` |
| `EmptyState.svelte` | `src/ui/EmptyState` | 空列表的说明和下一步 |
| `ToastHost.svelte` | `src/ui/ToastHost` | 外壳挂一个；发提示照信使用 `src/m/toast` 的函数 |
| `ImageContextMenu.svelte` | `src/ui/ImageContextMenu` | 图片右键菜单 |
| `BuildUpdateNotice.svelte`、`MobileNavigation.svelte` | `src/ui/` 同名 | 外壳用 |
| `FolkAvatar.svelte`、`SessionAvatar.svelte` | `src/ui/` 同名 | Bot 和对话的头像；存下来的头像用 `src/ui/AvatarPicture` |
| `AvatarEditor.svelte` | `src/ui/AvatarEditor` | 选图、缩到 256 |
| `BrandMark.svelte` | `src/ui/BrandMark` | |
| `ModelPicker.svelte`、`ModelSourceMark.svelte` | `src/ui/` 同名 | 模型选择器（桌面弹出、手机底部弹出）、模型来源标志 |
| `settings/AgentLogo.svelte`、`ConnectorLogo.svelte`、`ClaudeSpark.svelte` | `src/ui/settings/` 同名 | 三个都画在 `AgentLogo.tsx` 里，另两个文件是转出 |
| `MarkdownBody.svelte` | `src/ui/MarkdownBody` | `source`、`options`（`mentionBots`、`extraPaths`、`streaming`）、`copyLabel`、`inverted`、`onOpenArtifact`、`onOpenImage`、`loadArtifactImage`、`onOpenProfile`、`hideStandaloneArtifactLinks`；文件和 Bot 画成小标签。信使的 `markdown.ts`（`renderMarkdown`）不在镜像里，NSH 这边是 `src/ui/markdown.ts` 的 `prepareMarkdown`；要 HTML 的地方都改用 `MarkdownBody` |
| 弹窗框架 `.modal-backdrop` / `.modal-dialog` / `.modal-head` / `.modal-body` / `.modal-foot` | `src/ui/Modal` | `Modal`（`title`、`closeLabel`、`onClose`、`width`、`foot`、`pageOnPhone`、`busy`、`alert`）和底部按钮 `ModalAction`（`kind`：primary / secondary / deny，`busy`）；信使里用这套 class 的 16 个对话框都套它 |
| `overlays/DangerDialog.svelte` | `src/ui/overlays/DangerDialog` | 危险操作确认，`copy`、`onDismiss`、`onConfirm`、`busy`、`optionChecked` |
| `overlays/FileIcon.svelte` | `src/ui/overlays/FileIcon` | `icon={fileIconFor(path)}`（`src/m/overlays/file-icon.ts`） |
| 设置页的骨架：`settings/SettingsCard`、`SettingsCardHeader`、`SettingsRow`、`SettingsSectionList`、`SettingsSectionTabs`、`SettingsSubpageButton`、`AutosaveState`、`HelpTip`、`WorkspaceField`、`WorkspacePicker`、`IndependentConfirm` | `src/ui/settings/` 同名 | 每个文件开头的注释写了 props；snippet 成了 `children`、`icon`、`after`、`end` 这些 JSX 参数。**一张卡片的最后一个 `SettingsRow` 要传 `last`**（NSH 没有 `:last-child`，不传会多一条分隔线） |
| `<input type="checkbox">` | `src/ui/Checkbox` | 整行可点，`checked` + `onChange`、`label` |
| 阴影、时长、字号、CSS 颜色 | `src/ui/styles` | `shadow("menu")`、`DURATION`、`TEXT`；镜像模块给的 `var(--x)` 颜色（头像色板）用 `cssColor()` 换成主题值 |
| 字节转图片 | `src/ui/data-url` | `blobDataUrl(blob)`：NSH 没有 object URL，`Image` 吃 `data:` URL |
| 界面方案（ADR 0108） | `src/ui/interface/` | 钩子 `ui()`、底线 `floor()`、动效开关 `reduceMotion()`（`motion.ts`：方案说「一直减弱」或系统要求时为真；**别从 `nsh` 导入 `reduceMotion`**，它只听系统）；令牌由 `theme.ts` 换进主题，组件照旧写 `bg-pane` 这些类 |

两个信使的外壳级组件不单独移植：`ImageCopy.svelte`（document 级右键监听，NSH 没有 document）由显示图片的组件自己挂 `ImageContextMenu`；`WorkspaceDragGhost.svelte` 跟文件树拖动一起，由移植 `overlays/WorkspaceExplorer` 的任务做。

样式的几个坑：Tailwind 的 `em` 单位不认（`px-[0.35em]` 会被忽略，换成 px）；`font-mono` 是平台自己的等宽字体，不要写具体字体名；文字里嵌的视图（小标签）用 `style={{ verticalAlign: "middle" }}` 对齐。

移植中踩到的 NSH 行为（先照这些写）：

- `role` 只认 NSH 的 `AccessibilityRole`：没有 `dialog`、`alertdialog`、`status`，对话框用 `group` / `alert`，状态文字用 `text`，卡片用 `region`。
- `Overlay`（和放在它里面的弹层）里，`<Each>` 画不出东西：那里的列表写成函数子节点 `{() => list().map((x) => …)}`。
- `keymap` 同一个键只有最新绑定的那个生效：同时开着两个都绑 Escape 的东西，旧的听不到。焦点在输入框里还要响应的快捷键加 `{ when: "always" }`。
- **输入法组字时，不带 ⌘、⌃ 的键归输入法**，`keymap` 听不到（连 `{ when: "always" }` 也一样）：NSH 0.4.0 的 keymap 比输入框先看到按键，消息框（`RichEditor`）自己绑的退格、回车、方向键会把它们从拼音那里拿走，宿主的 `NSApplication` 子类（`host/src/ime_keys.rs`）在组字时把这些键直接交给窗口。带 ⌘、⌃ 的照旧先过 keymap，组字时要不要响应，处理函数自己看（`Terminal.tsx` 组字时解除绑定）。别想着再加一个按键监视器排到 NSH 前面：AppKit 调本地监视器的顺序不固定。候选框开在屏幕左下角也不是应用的事：消息框藏起来的输入框留着已上屏的字，AppKit 答不出组字的位置，宿主（`host/src/ime_rect.rs`）改报光标那一行；要看输入法拿到的位置，用开发检查的 `compose`。
- 键名没有 `"+"`、`"-"`：写 `plus`、`minus`。
- `flex-shrink` 不认，写 `shrink`；CSS 变量做圆角（`rounded-(--radius-bot)`）要是主题里没有就换成具体值。
- 横排里的子项默认不收缩（照 RN，`flex-shrink` 是 0）：CSS 里会让位、折行的 `<strong>` / `<span>`，在这里按一整行的宽度排开，把后面的东西挤出框外（任务地图侧栏的名字曾把「跟随」挤出卡片）。要让位的那段文字写 `shrink min-w-0`；所在的纵列宽度由外面定（`flex-1`）时，它照常折行，行跟着长高，不会碰上后面那条说的高度问题。
- `If` 的函数子节点拿到的是读取函数，别把它存下来到别处再读：在用的地方直接从原数据取。
- **NSH 的视图收不到滚轮**（只有它自己的 `Scroll` / `List` 能滚）。要自己缩放、平移、滚动的视图（画布、看图、轨迹、地图、终端回滚）用 `src/platform/wheel` 的 `onWheel(() => ref, (e, at) => …)`：外壳把滚轮、触控板双指滚动和捏合转给应用，事件照 DOM 的 `WheelEvent`（`dy` 向下为正，捏合是 `ctrl` 加 `dy = -100·ln(倍数)`），`at` 是视图里的坐标。信使里 `onwheel` 的处理照搬过来就行。外壳转来的是窗口里每一下滚轮，不管指针底下盖着什么，所以带遮罩的弹层（`Dialog`、`Sheet`、铺满窗口的 `Overlay`）要把内容包进 `src/platform/wheel-layer.tsx` 的 `WheelLayer`：开着时只有最上层里的 `onWheel` 收得到，遮罩上的滚轮不落到底下。在组件体里自己调 `onWheel` 的弹层（看大图）拿 `openWheelLayer()` 的返回值当第三个参数。
- **`Popover` / `Overlay` 的「点外部」在 macOS 上会漏**：按在原生输入（消息框的 `RichEditor`）和 `windowDrag` 区域（侧边栏空白）上的按下，NSH 有时根本不告诉浮层，菜单就不收起。要点外部必收的菜单，再用 `src/platform/press` 的 `onPressOutside(() => Promise.all([frameOf(面板), frameOf(触发器)]), 关闭)`：外壳把每次鼠标按下转给应用（`shell.press`，窗口坐标），落在这些框外就关；关闭要能重复调用（NSH 看到的时候两边都会关）。触发器要算在框里，不然按下就关、松开又被它打开。`Modal` 里别用（`InModal()`）：那里量出来的是对话框里的坐标，不是窗口的。例子：`ui/chat/TunePicker.tsx`。
- **点在别处，输入框会失焦**（和信使一样；NSH 自己按 AppKit 的习惯把焦点留在输入框里，上游现在也是这样）：有输入框在编辑、按在应用自己的视图上时，外壳（`host/src/press.rs`）在按下的那一刻就让它失焦，组字中的拼音先按提交处理。按在另一个输入框、滚动条上不算；自绘文字、靠隐藏输入打字的视图（消息框的 `RichEditor`、代码的 `Editor`、终端、远程屏幕的键盘：隐藏输入宽或高不到 2pt，或完全透明）里的按下算在它的输入框里；`TimeField`、`OtpInput` 的透明输入框盖满整个控件，按在上面本来就是按在输入框里。信使在 `onmousedown` 里 `preventDefault` 留住焦点的地方（替输入框挑选的列表：@ 列表、/ 命令、筛选的行），这里用 `keepFocusIn(() => frameOf(列表))` 登记，组件卸载时自动撤掉。登记着的时候外壳不再自己动手，把按下交给应用判断（`shell.keepers` 报数量）；和 `onPressOutside` 一样，`Modal` 里量出来的不是窗口坐标。例子：`ui/chat/MentionPopup.tsx`。
- **倒置 `List` 的 `scrollToIndex` 里，`viewPosition` 是镜像的**：0 是那一行的下沿对齐视口下沿，1 是它的上沿对齐视口上沿。回到底部曾写成 `{ index: 0, viewPosition: 1 }`，最新一条比视口矮时被夹到底部，看不出毛病；比视口高（长回复、大代码块）就停在它的开头，下半截在视口外（距底部 = 行高 + 顶部内边距 − 视口高）。要「到底」写 `viewPosition: 0` 加一个超过底部内边距的 `viewOffset`，列表会按内容夹取。`scrollToOffset` 对独立列表不夹取，别拿它去「够到底」。`stories/stage-scroll.tsx` 和 `.ui/stage-scroll.test.tsx` 拿最新一行 900pt 高的列表量落点。
- **`List` 的 `contentStyle` 和 `contentClass` 只认一个**：`contentStyle` 里只要有一项，`contentClass` 给的内边距和间距就整份作废，不是逐项合并。`contentClass="py-5 gap-4"` 旁边放一个只写左右内边距的 `contentStyle`，结果行与行之间是 0（两个对话列表曾经这样，消息首尾相贴）。用了 `contentStyle` 就把内边距和 `gap` 全写进去。倒置列表里 `paddingTop` 是靠消息框那一端，`paddingBottom` 在最早一行上方。`Scroll` 的 `contentStyle` 是普通内联样式，和 `contentClass` 逐项合并，没有这个问题。`scripts/list-content.test.ts` 读源码查这一条。例子：`ui/chat/ChatStage.tsx`、`ui/chat/ProjectChat.tsx`。
- 会换行的长文字别放进横排（`flex-row`），尤其当外面的框按内容收缩（`self-start`、`items-start` 的父级）：NSH 0.4 按文字不换行时的宽度算高度，框比文字矮，后面的东西压到文字上。文字直接放进纵向的框；旁边要有图标就让图标 `absolute` 放在文字的左边距里（`TranscriptSystem.tsx` 的系统卡片）。给文字加 `flex-1 min-w-0` 更糟：框缩成一条，文字不见。
- 信使里靠内容撑宽的居中块（`self-center` / `m-auto`、带 `max-w-[…]`、没写宽度），在 NSH 里按子项的 flex-basis 定宽：里面横排的 `flex-1` 文字 basis 是 0，不算宽度，块就缩到其余子项（头像）那么宽，文字一字一行地竖下去（空会话的欢迎页曾缩成一条，建议卡片压到消息框底下）。浏览器里它被文字的 max-content 撑到上限，写成 `w-full max-w-[…]` 就一样。例子：`ui/chat/ChatWelcome.tsx`。
- 信使里一个滚动容器先后装着几种状态（`.stream` 里的消息列表、空会话的欢迎页），移植时拆成几个分支，每个分支都要自己能滚：只有列表那支是 `List`，欢迎页曾放在不滚的 `View` 里，舞台一矮，后面的建议卡片就压到消息框底下够不着。要在放得下时居中，写 `<Scroll class="flex-1 min-h-0" contentClass="grow">`，里面的块照旧 `m-auto`。例子：`ui/chat/ChatStage.tsx` 的 `StageWelcome`。
- `<Each of={…}>` 吃 `state()` 的深层代理数组时什么都画不出来：写 `of={list.slice()}`（或 `snapshot(list)`）。组件内部 `Each` 的东西也一样：把镜像类里的 `state()` 整个交给移植好的组件（比如 `ShellWorkbench.layout` 交给 `Workbench`，它在里面 `Each` 每个窗格的 `tabs`）之前，先 `computed(() => snapshot(x))` 变成普通对象；故事里传的是普通对象，测不出来。
- 桌面引擎的 `Intl` 只有 `DateTimeFormat` 和 `NumberFormat`；`RelativeTimeFormat` 由 `src/platform/relative-time.ts` 补了中英文，`PluralRules`、`Collator`、`ListFormat`、`Segmenter` 都没有，用到的话报告里说。
- `RichEditor` 有焦点时，应用级 `keymap.bind`（连 `{ when: "always" }` 也一样）不触发：在测试宿主里，一个没用到的 `mod+j` 在 `RichEditor` 有焦点时不响应，换成 `Input` 就响应。`RichEditor` 里的 Enter 只会分段。要在它里面接管按键，用 `RichEditorPlugin(key).captureKeys(["Enter", "ArrowUp", "Mod-Enter"], handler)` 放进 `createRichEditor({ plugins })`：`capturing` 为真时原生编辑器吞掉这些键、事后把键名交给 handler（所以「是否吞」要在按下之前由 `capturing` 定好，例如 Backspace 只在光标紧挨小标签时设 `capturing`）。一个插件的 `capturing` 管它所有的键，不同条件的键拆成不同插件；同一个键可以出现在几个插件里，开着的那个起作用。例子：`ui/chat/ComposerEditor.tsx`。
- 弹层不知道背后的滚动：信使里「背后滚了就关」的菜单，这里靠点外面和 Escape 关。
- **`Popover` 按内容的尺寸放，贴着触发器的是靠它那条边**：朝上开时底边在触发器上方，内容变高只能往上长，内容顶部跟着走。里面几块并排、后开的会更高（级联选择的列）时，按靠触发器的那条边对齐（朝上 `items-end` 加 `marginBottom`，朝下 `items-start` 加 `marginTop`），不然后开的高列把先开的整块推走。哪一边、那一边还有多少地方，读 `onPosition` 的 `placement` 和 `available`，并把内容收在 `available` 里，否则它会翻到另一边。例子：`ui/chat/TunePicker.tsx` 的 `columnShifts`。
- 窗口是否有焦点、是否在后台（信使的 `document.hasFocus()`、`visibilityState`）：从 `src/platform/lifecycle` 导入 `lifecycle`，不要从 `nsh` 导入——NSH 0.4 的 web 包里 `nsh` 模块没有 `lifecycle`，调用就抛错；平台那份在桌面上就是 NSH 的，web 上读页面。
  - 信使里还有一处直接读 `document` 的地方：`runtime.reportDesktopNotificationView`、`sendPresenceHeartbeat`。NSH 没有 `document`，前者在 `try` 里抛错被吞，从不到达宿主，后者开头就返回。所以 `runtime.nativeFocusFacts` 永远停在初始的「什么都不可见、什么都没焦点」，**不要拿它当闸**：会话的已读（`ui/chat/stage-reading.ts`）曾因此在桌面上一条都读不了，项目会话的未读标记一直在。已读只认 `lifecycle()`。
  - 在场上报（宿主把「哪个会话在看」告诉守护进程，用来压掉正在看的会话的桌面通知）因此在 NSH 上还没接通；要接，把这两处改成读 `lifecycle()`，并先看通知抑制的行为。
- `ref` 只能是函数（或 `let` 变量）：`ref={undefined}`、`ref={条件 ? fn : undefined}` 会在运行时抛错。只在某些情况下才要的 ref，写成总是存在的函数，里面再判断。
- **跨几段文字的选择要一个外层选区**：每个 `selectable` 视图（`MarkdownBody` 自己就是）各管各的选区，拖选到它的末尾就停，进不了下一条消息。要像网页那样一路选下去，在外面包一个 `<View selectable>`（里面的选区并进外层的）；`List` 不认 `selectable`（JS 只把它交给 `View`），包在 `List` 外面。不该进选区的字（时间、日期线）写 `select-none`，拖选从上面跨过去，复制出来也没有它们。NSH 会把列表回收的单元格按位置排回阅读顺序，倒置列表也对。例子：`ui/chat/ProjectChat.tsx`、`ui/chat/project-chat-lines.tsx`。
- **拖窗口的区域（`desktop={{ windowDrag: true }}`）由按下的那一点往外找**：最近的写了 `windowDrag` 的视图说了算；在那之前碰到带 `onPress`、`onTouch*`、responder 的视图或输入框，这一点就是按钮，不拖窗口。所以拖窗口的那块自己别挂这些（挂了的话同一视图上 `windowDrag` 先算，但别靠这个）；里面没挂任何处理的包装视图（标签的内边距、⋯ 和 × 旁边的空隙）会一路找到外面的 `windowDrag`，按在那里就拖走窗口，要算作按钮的给它写 `windowDrag: false`。按住拖超过几点才交给系统拖窗口，原地点一下仍作为按下交给应用，双击照系统标题栏缩放。系统拖窗口跟的是真的鼠标：开发检查里合成的拖动（`drag`、`postEvent`）拖不动窗口，只能看出按下没交给应用。例子：`ui/workbench/leaf-strip.tsx`（平铺窗格标签条的空白）、`ui/sidebar/Sidebar.tsx`。
- **`List` 的一行里后来才挂上的 `Scroll`，内容会一直是空的**：`Scroll` 只先做视口附近的内容，其余的等内核再核对；这次核对排在列表给单元格摆位之前，刚挂上的 `Scroll` 还没有位置，被跳过，之后要等窗口里别的东西让页面重排才补上（对话里展开的命令卡片曾这样空着，见 ADR 0107 补记二十七）。这种 `Scroll` 挂载后第一次拿到位置时（`onLayout`）发一次 `scrollTo`，内核就会重新核对它，内容不用滚也行。只在第一次：之后每次变高（点开里面的东西）也会触发 `onLayout`，再滚就把刚点开的东西滚走了。挂载时就由 effect 滚一次的（`TurnStepList`）不受影响；外层已经摆好位置以后，里面再挂上的 `Scroll`（命令的输出）也不受影响。网页版不做这种裁剪；macOS 的滚动命令不管动没动都会回报，所以管用；Windows、Linux 也开着裁剪，回报没核对过。无头测试关了这种裁剪，测不出来，要在真窗口里看。例子：`ui/chat/CommandActivity.tsx`。

## 不要做的

- 不要跑任何 git 命令。
- 不要碰 17890（你日常用的那一份：装好的稳定版，或 `--stable-instance` 起的 NSH 版）和 17990（开发实例），不要起 `scripts/dev.ts`、`dev-runtime.ts`；测试只用 `scripts/ui-tests.ts`（它自己起一个隔离的运行时，用空闲端口）。
- 不要改 `src/m/`、`src/platform/`、`src/runtime.ts`、`host/`、`native/`、`app/native/`、`nsh.json`、`theme.json`，也不要跑 `pnpm install`。要改它们，写进报告。
- 不要往别的区域的目录里写文件。

## 验证

1. 类型检查：在 `apps/desktop-nsh/app` 里跑 `nsh check App.tsx` 和 `nsh check Story.tsx`，零错误。这里的 `nsh` 是 `bun apps/desktop-nsh/scripts/nsh-cli.ts --check` 给出的那一个（和宿主同一个 NSH 提交编的，见 README「NSH 的版本」），不是 `~/.local/bin/nsh`；PATH 里要有 `~/.cargo/bin`。故事只从 `Story.tsx` 进，`nsh check stories/x.tsx` 会在 `stories/` 下生成一个多余的 `.nsh/`，不要这样跑。
2. 开一个故事：在 `app/stories/<区域>.tsx` 写一个默认导出的组件，把这个区域的界面摆出来，`stories/index.ts` 加一行登记。
3. 写测试：`app/.ui/<区域>-<主题>.test.tsx`，用 `.ui/fixture.ts` 的 `openStory("<区域>")`（整个应用用 `openApp()`）。测试本身连不了网（`nsh test` 的测试宿主没有网络栈，`.ui/fixture.ts` 的 `api()` 在那里会报错）：要造数据或读回运行时里的值，在故事里放按钮，经 `runtime.client` 去做，测试按按钮再读屏幕上的字（参照 `stories/settings-general.tsx` 的 `story-read`）。夹具只预置了 Writer、Editor、Writer 的私聊（两行，其中一行带 Markdown）和「周报小组」。按 `testID`（`id:x`）、文字（`text:x`）找，`press`、`type`、`waitFor` 操作；测的是行为，不是像素。`press` 会先看手指落点上画的是不是目标：被别的视图盖住就失败（`` `id:x` is covered: a press there reaches … ``），和真人点不到一样。真盖住了就改界面（引导页的语言切换曾被欢迎区压住，`z-[1]`）；目标在滚动区外，先 `app.scroll("id:x", 距离)` 把它滚进来；手机尺寸下整页的弹层盖住故事的按钮，先 `app.back()` 退出来，或者给故事的动作配一个快捷键（`keymap.bind`，测试里 `app.keyboard.press`）。无头运行器的文字是估算的（`ApproxTextEngine`），段落不会为行内的卡片撑高，后面的块会压在卡片上，真窗口里没有这回事：故事里把这种卡片放在最后一段。
4. 在仓库根目录跑 `bun apps/desktop-nsh/scripts/ui-tests.ts <文件名的一部分>`，全部通过。
5. 跑 `bun scripts/line-budget.ts`，通过。

## 报告

做完写清楚：新建了哪些文件；每个 Svelte 组件移植到了哪里；哪些行为没移植、为什么（NSH 缺什么能力、要动共享文件）；用了哪些需要别人提供的共享组件。
