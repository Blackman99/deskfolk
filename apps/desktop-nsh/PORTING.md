# 在 NSH 上写界面

桌面应用和手机的网页都是同一个 NSH 应用（`apps/desktop-nsh/app`，TSX）：界面在 `app/src/ui/<区域>/`，共用的逻辑在 `app/src/m/`（见 README「共用逻辑」），界面读同一个运行时（`MessengerRuntime`）、同一份文案、同一套令牌。这份文件是写 NSH 界面的规矩，和这个应用踩过的 NSH 行为。

## 一个界面怎么放

- 屏幕放进 `app/src/ui/<区域>/<Name>.tsx`，一个组件一个文件；几个区域共用的放 `app/src/ui/<Name>.tsx`。
- 组件导出同名函数：`export function SessionRow(props: {...})`。运行时和文案不当 props 传：组件里直接 `import { runtime, copy }`，文案写 `copy().x`（每个窗口只有一个运行时和一份文案，外壳接线就简单了）。双向的值写成 `x` 加 `onXChange`（或照 nsh/base 的 `value` / `onChange`）；插槽用 `children` 或 render 函数（`(item) => JSX.Element`）。
- 测试按 `testID` 找视图：`<View testID="x">`。
- 单个文件不超过 2000 行（`scripts/line-budget.ts`），过了 1000 行先想清楚拆到哪。

## 逻辑放哪

- 运行时：`import { runtime, copy } from "../../runtime"`（路径按层数）。`runtime` 是 `MessengerRuntime`，每个窗口一个。
- 文案：`copy()` 是 `copyFor(runtime.snapshot.settings.locale)`，在 JSX 里调用，跟着语言变。不要自己写中文或英文字面量。
- 共用的、像 store 一样的、要单独测试的逻辑放 `app/src/m/<区域>/`（普通的应用代码，直接改；`*.svelte.ts` 是写在 `app/src/lib/reactive.ts` 上的 store，不是 Svelte，文件名没改）。只为一个界面服务的纯函数放在它旁边的 `app/src/ui/<区域>/<name>.ts`，好测试。
- 先找 `app/src/m/` 里有没有现成的函数，不要重新实现。

## NSH 的写法

- 组件读 props 时**不要解构**（解构只读一次，不会跟着变），在 JSX 里读 `props.a`。
- 状态用 `signal(0)`，读 `x()`，写 `x.set(v)`；组件内的深层响应状态用 `app/src/lib/reactive.ts` 的 `state`。
- 派生值用 `computed(() => expr)`；直接写函数 `const v = () => expr` 只适合便宜、读的地方少的值。**函数不记忆**：每读一次算一次，每一行都读的派生值（`available()[index]`）就成了 行数 × 整份的计算（⌘K 搜索曾因此卡死，`ui/search/GlobalSearch.tsx`）。
- 副作用用 `effect(fn)`（`nsh`），清理用返回函数或 `cleanup`；组件函数体里直接做初始化，卸载时的清理用 `cleanup(fn)`。
- 条件：`<If when={a} else={…}>…</If>`；要用值时 `{(v) => …v()…}`。
- 列表：`<Each of={list} key={(i) => i.id}>{(item) => …item()…}</Each>`；长列表（会话、消息、文件）用 `List`（虚拟化）。条数没有上限、又放在按内容定高的卡片里（搜索结果）时，分页建行：先建一页，滚近底部再加（`GlobalSearch.tsx`）。选中、悬停这类每行的状态在行里读，别放进 `{() => list.map(…)}` 这样的跟踪插入，否则一变就重建整个列表。
- 布局和文字：`View` / `Text`（文字必须在 `Text` 里）。能按的用 `<View role="button" onPress>`，或 `src/ui/Button`、`IconButton`。
- 输入：`Input`（`nsh/base`）：`value` + `onChange`，`multiline`，`onSubmit`，`onKeyPress`；输入法组字时不要提交（`onCompositionChange`）。
- 菜单、弹出层、对话框：`nsh/base` 的 `Menu` / `ContextMenu` / `Popover` / `Dialog` / `Sheet` / `AlertDialog`。
- 滚动区：`Scroll`；要定位、要虚拟化的用 `List` 和它的 ref（`scrollToIndex`、`scrollToEnd`）。
- 拿视图：`ref={(node) => …}` 拿 NSH 的 ref（`focus()`、`measure()`、`scrollTo()`），没有 DOM。
- 键盘：`keymap.bind("mod+k", fn)`（`nsh`），组件卸载时自动解绑；没有 `window` / `document` 的事件。
- 断点用 `widthAtMost(680)`（`src/platform/viewport.ts`，缓存的布尔值，窗口跨过断点才通知读者；`narrowWindow()` 就是它），别写 `windowSize().width <= 680`：改窗口大小时每一帧都会让读者重跑，一百多处加起来让排版落后窗口好几秒。要真实尺寸（弹层宽高）才读 `viewportSize()`（同一个文件；桌面上 NSH 的 `windowSize()` 是看不见的宿主的尺寸，不是窗口的，只有 `viewport.ts` 读它，`scripts/viewport-reads.test.ts` 守着）；自己的宽度用 `onLayout` 量；手机布局看 `platform.desktop` 和宽度。没有媒体查询和容器查询。
- 提示：`<View tooltip={tip("…")}>`（`src/ui/tip`）。
- 界面钩子（`data-ui`）：`class={ui("x", "…类名")}`（`src/ui/interface/hooks`，ADR 0108）。
- 底线（`data-floor`）：`ref={floor("x", { ink: "字或图标的令牌", ground: ["底下的令牌", …] })}`（`src/ui/interface/floor`，底从下往上写，颜色可以是函数、不是底线时返回 null）；`Button` 用 `floor="x"`（再加 `floorOn` 说它放在哪种底上，默认 `pane`）。
- 拖动改宽：`PanResponder` 或 `nsh/base` 的 `ResizablePanelGroup`。
- Markdown：`TextView`（`nsh/base`）的 `markdown`，不要拼 HTML。
- 预览生成的 HTML 页面：`WebView`（`nsh`）的 `html`；页面和应用之间用 `injectedJavaScript` 和 `window.nsh.postMessage` / `onMessage`、ref 的 `postMessage`。**只有 HTML 产物预览和 HTML 批注能用 WebView**，别的界面一律原生。
- 代码：`Editor`、`DiffView`（`nsh/base`）；聊天里的代码块由 `TextView` 画。

## 样式

- 类名用 Tailwind，令牌就是 `tokens.css` 的名字：`var(--ink)` → `text-ink`，`var(--pane)` → `bg-pane`，`var(--line)` → `border-line`，`var(--radius-md)` → `rounded-(--radius-md)`。两个改了名：`--accent` 是 `brand`（`bg-brand`、`text-brand`），`--muted` 是 `ink-muted`。`accent-tint`、`accent-hover` 这些照原名。
- 半透明色用类名的 `/NN`：`color-mix(in srgb, var(--accent) 14%, transparent)` → `bg-brand/14`。不要拿 `token()` 的值自己拼透明度，它给的是 `#rrggbbaa`，按 `#rrggbb` 拼会落空，变成不透明（拖拽分屏的落点框就这样盖住了窗格）。
- 阴影不是令牌：`style={{ boxShadow: shadow("menu") }}`（`src/ui/styles`，按明暗自动换）。字号写字面量（`text-[13px]`），对照表在 `styles.ts` 的 `TEXT`。
- 状态用变体：`hover:`、`active:`、`disabled:`、`focus-visible:`、`group` 加 `group-hover:`、`selected:`、`dark:`。
- **能按的东西自己写出手形指针**：NSH 没有 CSS 里 `button { cursor: pointer }` 那样一条管全部的规则，视图的 `class`（或 `style`）里写了 `cursor` 才有手形，`nsh/base` 的 `Tab`、`MenuItem`、`Radio`、`Switch`、`Link` 也都不带。`role` 是 button / menuitem / tab / radio / checkbox / option 的视图写 `cursor-pointer select-none`，带 `disabled` 的再加 `disabled:cursor-default`。`select-none` 不能省：在可选文字的区域（聊天气泡、`MarkdownBody`）里，NSH 先给最里面那段字的 I 形光标，轮不到外面视图的手形；不选的字才让手形露出来，按钮上的字也不会被一起选走。链接（`role="link"`）的字要能选，不写 `select-none`，把 `cursor-pointer` 也写到它的 `Text` 上（字自己的指针比 I 形先算）。`Select`、`Combobox`、`DatePicker` 的选项写在 `itemClass`。背景遮罩、只为挡住点击的视图不写。`scripts/press-cursor.test.ts` 读源码查这几条，故意不要手形的视图登记在它的 `PLAIN` 里。
- **按下去会放大图片的地方是放大镜**：消息里的图片附件、Markdown 的图片小标签（框和字都写）、输入框里待发的图片、文件预览里的图片，写 `cursor-zoom-in` 而不是 `cursor-pointer`；放大后的图片是 `zoom-out`，在它上面点一下就关。打开放大的地方把按下的那张图交出去（`chat/image-origin` 的 `PressedPicture`：缩略图自己的视图，不是整个小标签；还有它正显示的 `data:` URL），灯箱从缩略图的位置长出来，先显示这张缩略图，按图片的比例一次长到位，（`chat/image-origin` 的 `pictureOrigin` / `pictureStandIn`）。图片上挂了 `onLongPress`（复制菜单）时它自己就是按下的目标，点击不会落到下面的视图，要关的话它自己也得有 `onPress`。
- 图标：`<Icon name="plus" size={16} class="tint-ink-muted" />`（`src/ui/Icon`），颜色只用 `tint-*` 类，悬停跟随用 `group-hover:tint-ink`。名字照 `src/m/icons.ts`。
- 现成的组件先找 `src/ui/`（见下面「共享组件」）。几个区域都要用、又没有现成的，加到 `src/ui/`，不要各写一份。
- `transition-*`（`transition-all` 也一样）只动颜色、透明度、transform、阴影、圆角，**不动位置和尺寸**：CSS 里 `transition: top/left/width/height` 的写法在这里会直接跳。要动框的位置、大小，在改它的那一次提交之前调 `LayoutAnimation.configureNext({ duration, update: { type: "easeInEaseOut" } })`（只给 `update`，新插入的不跟着动）。它管的是整次提交，同一次里别处的布局变化也会一起动；窗口缩放时别调。例子：`ui/chat/MessageImageLightbox.tsx` 的 `frameBox` 那个 effect。**旁边有大段文字的框改宽度时别用它**：文字当场按终点宽度折好，行里嵌的视图（回复里的路径芯片）各自从旧位置滑过去、压在字上，整段回复也上下跳。这种情况逐帧改宽度，每帧真正重排一次（`requestAnimationFrame`，和拖分隔条一样）；曲线每帧的步子别太大，长回复旁一步 50–100 pt 要重排约 40 ms，十几 pt 跟得上一帧。例子：侧边栏收起展开（`ui/shell/shell-state.ts` 的 `foldSidebar`、`sidebar-fold.ts`）。曲线别用线性，也别让框里的东西都跟着边一起被裁：侧边栏收起时文字先淡出、往头像那边收，头像不动，快到细栏时才和细栏的图标交接，细栏的图标从上到下一个接一个长出来；展开时反过来，文字最后进来。这些跟着一个原生动画值走（`ui/sidebar/fold-motion.ts`：`createAnimatedValue` 加 `interpolate`，每帧和宽度一起 `set` 一次；每个外壳一个，用 `context` 传给侧边栏和细栏，没有外壳的故事里不绑），不用 `transition-*` 类：刚挂上的视图没有起点可过渡，半路反向也接不上；静止时这个值让每个视图和没有动画时一模一样（窄窗口的花名册也是）。**动画开头要挂上的东西会推迟开头**：时钟从挂完之后的第一帧算，挂得慢，按下快捷键后就干等。细栏原来每个头像要 20 ms 左右（每次都重建 Bot 表、逐个扫全部会话），150 个会话时收起要先停 0.7 秒；现在照侧边栏的做法缓存这些答案，折叠时只挂窗口里看得见的那些，停稳后再每帧补几个（`SidebarRail.tsx` 的 `made`）。量法：把 `console.log(Date.now(), now - start, width)` 用 sed 加进构建好的 `bundle.js` 的 `step`，在宿主日志里看从按键到第一帧、每帧间隔。
- **列表里的行出不了列表的框**：`List` 裁掉超出它的部分，行上的 transform 也一样，所以要从列表外面（消息框）进来、或飞出去的东西，不能让行自己动。照 `ui/chat/send-flight.tsx` 的做法：行留在原位、透明，另画一个替身放进 `Overlay`（`pointerEvents: "none"`，里面再套一层按对话的框裁切），起点和终点都用 `ViewRef.measure()` 的 `pagePosition` 量（和 `Overlay` 是同一个根视图的坐标），替身的大小写死成行量出来的大小，落地时在同一次提交里撤掉替身、让行显形，像素对得上就看不出交接。路上列表可能在动（下面来了新行），替身的位置每帧再量一次行跟上去，动画只是叠在上面的偏移（两层视图各管横、竖，各用各的曲线）。做的时候先不带过渡属性挂在起点，下一帧再连同过渡一起改到终点：一挂上就带着过渡属性的视图，会先从样式的默认值（偏移 0）过渡到起点，在终点闪一下再跳回去（`ui/BottomSheet.tsx` 的 `SlidingSheet` 也是这样避开的）。任何一步失败（量不到、行没摆出来、发送被拒、切走了）都要让行照常显示，不能一直藏着。`nsh test`（不开应用的那条线）里 `requestAnimationFrame` 不走，要逐帧的逻辑把「下一帧」做成可注入的。
- CSS 里不占位置的描边（`outline`、`box-shadow: inset 0 0 0 1px`，键盘或悬停的高亮环）在 NSH 里写成 `border` 是占位置的：只在高亮时加 `border`，那一行就高出两倍边框宽，下面的行和弹层的底边跟着指针一进一出上下跳。每一行都写同宽的 `border` 加 `border-transparent`，内边距减去边框宽，高亮时只换 `border-accent-border` 的颜色。例子：`ui/model-picker/Rows.tsx` 的 `ring`。
- 没有 `::before` / `::after`（分隔条悬停、拖动时的那条线就是这类东西）：要写成子视图，悬停用父视图的 `group` 加子视图的 `group-hover:`，拖动中另看一个状态（指针会跑出握把）。线和握把放在看得见的那条边上：侧边栏自己没有边，边是右边卡片的边，宽屏时卡片在主列里缩进 4pt（窗格的 `mx-1`）。例子：`ui/shell/Shell.tsx` 的 `sidebar-split`。
- 盖在别的视图上的透明层（标注层这类）不会把按压让给下面的兄弟视图：CSS 里写 `pointer-events: none` 的层，这里要写 `pointerEvents: "box-none"`（自己不接，子视图照接），否则下面的 `onPress` 永远收不到。`app.press(selector)` 直接按指定的视图，测不出这种遮挡。
- `List` 的单元格按创建的先后叠放，core 从不给它们重排，行里的 `z-*` 也出不了自己的单元格：伸出本行、要压在相邻行上的东西（消息的悬停操作条），倒序列表里常被上一行盖住。这种东西放进 `<Overlay anchor={本行的视图} placement=… />`，它画在所有行之上、跟着滚动，但不受列表裁切，要自己在离开列表可视范围时藏起来。例子：`ui/chat/message-pill.tsx`。悬停计数改动要用 `batch` 一次落定，否则中间那一刻「不显示」会让浮层重建，指针下的新浮层收不到进入事件。测试里 `A >> B` 不穿过 Overlay，按它自己的 testID 找。
- 样式的几个坑：Tailwind 的 `em` 单位不认（`px-[0.35em]` 会被忽略，换成 px）；`font-mono` 是平台自己的等宽字体，不要写具体字体名；文字里嵌的视图（小标签）用 `style={{ verticalAlign: "middle" }}` 对齐。

## 共享组件

几个区域共用的组件都在这里，直接导入，不要另写：

| 组件 | 用法要点 |
|---|---|
| `src/ui/Icon` | `name`、`size`、`filled`、颜色只用 `class="tint-…"`；`iconUri()` 给 `Image` 用 |
| `src/ui/Button` | `variant`（primary / secondary / ghost / danger / danger-soft）、`size`、`icon`、`trailingIcon`、`onPress` |
| `src/ui/IconButton` | `icon`、`label`（必填，也是提示）、`size`（xs/sm/md/lg）、`pressed` |
| `src/ui/Switch` | `checked` + `onChange` |
| `src/ui/tip` | `tooltip={tip("…", options?)}` 或可控的 `<Tip label={…} open={…} onOpenChange={…} />`（自动限制宽高和行数，空文案不弹出） |
| `src/ui/Select` | `value`、`options`（字符串或 `{ value, label, hint, group, disabled }`）、`onChange`；桌面弹出、手机底部弹出 |
| `src/ui/MultiSelect` | 多选，选中的成小标签 |
| `src/ui/BottomSheet` | `open`、`onClose`、`onBack`；行用同文件的 `SheetItem`、`SheetSeparator` |
| `src/ui/EmptyState` | 空列表的说明和下一步 |
| `src/ui/ToastHost` | 外壳挂一个；发提示用 `src/m/toast.svelte.ts` 的函数 |
| `src/ui/ImageContextMenu` | 图片右键菜单 |
| `src/ui/BuildUpdateNotice`、`src/ui/MobileNavigation` | 外壳用 |
| `src/ui/FolkAvatar`、`src/ui/SessionAvatar` | Bot 和对话的头像；存下来的头像用 `src/ui/AvatarPicture` |
| `src/ui/AvatarEditor` | 选图、缩到 256 |
| `src/ui/BrandMark` | 品牌标记 |
| `src/ui/ModelPicker`、`src/ui/ModelSourceMark` | 模型选择器（桌面弹出、手机底部弹出）、模型来源标志 |
| `src/ui/settings/AgentLogo`、`ConnectorLogo`、`ClaudeSpark` | 三个都画在 `AgentLogo.tsx` 里，另两个文件是转出 |
| `src/ui/MarkdownBody` | `source`、`options`（`mentionBots`、`extraPaths`、`streaming`）、`copyLabel`、`inverted`、`onOpenArtifact`、`onOpenImage`、`loadArtifactImage`、`onOpenProfile`、`hideStandaloneArtifactLinks`；文件和 Bot 画成小标签。Markdown 的预处理是 `src/ui/markdown.ts` 的 `prepareMarkdown`；不要拼 HTML，用 `MarkdownBody` |
| `src/ui/Modal` | `Modal`（`title`、`closeLabel`、`onClose`、`width`、`foot`、`pageOnPhone`、`busy`、`alert`、`fill`）和底部按钮 `ModalAction`（`kind`：primary / secondary / deny，`busy`）；对话框都套它 |
| `src/ui/overlays/DangerDialog` | 危险操作确认，`copy`、`onDismiss`、`onConfirm`、`busy`、`optionChecked` |
| `src/ui/overlays/FileIcon` | `icon={fileIconFor(path)}`（`src/m/overlays/file-icon.ts`） |
| `src/ui/settings/` 的 `SettingsCard`、`SettingsCardHeader`、`SettingsRow`、`SettingsSectionList`、`SettingsSectionTabs`、`SettingsSubpageButton`、`AutosaveState`、`HelpTip`、`WorkspaceField`、`WorkspacePicker`、`IndependentConfirm`（设置页的骨架） | 每个文件开头的注释写了 props；插槽是 `children`、`icon`、`after`、`end` 这些 JSX 参数。**一张卡片的最后一个 `SettingsRow` 要传 `last`**（NSH 没有 `:last-child`，不传会多一条分隔线） |
| `src/ui/Checkbox` | 整行可点，`checked` + `onChange`、`label` |
| `src/ui/styles` | `shadow("menu")`、`DURATION`、`TEXT`；`src/m` 里的模块给的 `var(--x)` 颜色（头像色板）用 `cssColor()` 换成主题值 |
| `src/ui/data-url` | `blobDataUrl(blob)`：NSH 没有 object URL，`Image` 吃 `data:` URL。只给图片用，而且本机的图片先给路径（见下面「大文件不经过 JS」）；Base64 是分块拼成二进制串再交给引擎的 `btoa`，在 JS 里逐字拼要慢十几倍 |
| `src/ui/interface/` | 钩子 `ui()`、底线 `floor()`、动效开关 `reduceMotion()`（`motion.ts`：方案说「一直减弱」或系统要求时为真；**别从 `nsh` 导入 `reduceMotion`**，它只听系统）；令牌由 `theme.ts` 换进主题，组件照旧写 `bg-pane` 这些类 |

外壳级的两个例外：图片的右键菜单由显示图片的组件自己挂 `ImageContextMenu`（NSH 没有 document 级的右键监听）；工作区文件树的拖动幽灵是 `ui/WorkspaceDragGhost.tsx`，随 `overlays/WorkspaceExplorer`。

## NSH 的行为

踩到过的 NSH 行为（先照这些写）：

- `role` 只认 NSH 的 `AccessibilityRole`：没有 `dialog`、`alertdialog`、`status`，对话框用 `group` / `alert`，状态文字用 `text`，卡片用 `region`。
- `Overlay`（和放在它里面的弹层）里的 `<Each>` 吃普通数组能画出来（钉住的 7a2c11e0 上核对过：项目会话的命令列表和参数候选都是 Overlay 里的 `Each`）。画不出来时先看交进去的是不是 `state()` 的深层代理数组（见下面那条），而不是改成函数子节点。
- `keymap` 同一个键只有最新绑定的那个生效：同时开着两个都绑 Escape 的东西，旧的听不到。焦点在输入框里还要响应的快捷键加 `{ when: "always" }`。
- **输入法组字时，不带 ⌘、⌃ 的键归输入法**，`keymap` 听不到（连 `{ when: "always" }` 也一样）：NSH 0.4.0 的 keymap 比输入框先看到按键，消息框（`RichEditor`）自己绑的退格、回车、方向键会把它们从拼音那里拿走，宿主的 `NSApplication` 子类（`host/src/ime_keys.rs`）在组字时把这些键直接交给窗口。带 ⌘、⌃ 的照旧先过 keymap，组字时要不要响应，处理函数自己看。别想着再加一个按键监视器排到 NSH 前面：AppKit 调本地监视器的顺序不固定。候选框开在屏幕左下角也不是应用的事：消息框藏起来的输入框留着已上屏的字，AppKit 答不出组字的位置，宿主（`host/src/ime_rect.rs`）改报光标那一行；要看输入法拿到的位置，用开发检查的 `compose`。
- 键名没有 `"+"`、`"-"`：写 `plus`、`minus`。
- `flex-shrink` 不认，写 `shrink`；CSS 变量做圆角（`rounded-(--radius-bot)`）要是主题里没有就换成具体值。
- 横排里的子项默认不收缩（照 RN，`flex-shrink` 是 0）：CSS 里会让位、折行的 `<strong>` / `<span>`，在这里按一整行的宽度排开，把后面的东西挤出框外（任务地图侧栏的名字曾把「跟随」挤出卡片）。要让位的那段文字写 `shrink min-w-0`；所在的纵列宽度由外面定（`flex-1`）时，它照常折行，行跟着长高，不会碰上后面那条说的高度问题。
- 横排按内容定宽时（胶囊、chip），里面带 `max-w-[…]` 截断的文字（`line-clamp-1` 的名字）也要写 `shrink min-w-0`：不收缩的子项，taffy 把它的 flex-basis（一整行的宽度）当下限，`max-w` 压不住，横排照整行宽撑开，文字却只排到 `max-w`，省略号后面空出一截（子代理、Bot↔Bot 私聊、「正在回复」的胶囊曾这样）。能收缩时横排才按 `max-w` 算宽。例子：`ui/chat/ProjectSubagentEntry.tsx`。
- `If` 的函数子节点拿到的是读取函数，别把它存下来到别处再读：在用的地方直接从原数据取。`Each` 的 `item` 也一样：`{(task) => chip(task(), …)}` 把那一刻的对象交给了 `chip`，那一项留着，`chip` 却一直画旧对象（运行中的任务结束了，胶囊上的点还在）。把读取函数本身交下去，在用的地方 `task()`。例子：`ui/chat/ProjectSubagentEntry.tsx`。
- **NSH 的视图收不到滚轮**（只有它自己的 `Scroll` / `List` 能滚）。要自己缩放、平移、滚动的视图（画布、看图、轨迹、地图）用 `src/platform/wheel` 的 `onWheel(() => ref, (e, at) => …)`：外壳把滚轮、触控板双指滚动和捏合转给应用，事件照 DOM 的 `WheelEvent`（`dy` 向下为正，捏合是 `ctrl` 加 `dy = -100·ln(倍数)`），`at` 是视图里的坐标。`onwheel` 的处理按 DOM 的写法写就行。外壳转来的是窗口里每一下滚轮，不管指针底下盖着什么，所以带遮罩的弹层（`Dialog`、`Sheet`、铺满窗口的 `Overlay`）要把内容包进 `src/platform/wheel-layer.tsx` 的 `WheelLayer`：开着时只有最上层里的 `onWheel` 收得到，遮罩上的滚轮不落到底下。在组件体里自己调 `onWheel` 的弹层（看大图）拿 `openWheelLayer()` 的返回值当第三个参数。
- **`Popover` / `Overlay` 的「点外部」在 macOS 上会漏**：按在原生输入（消息框的 `RichEditor`）和 `windowDrag` 区域（侧边栏空白）上的按下，NSH 有时根本不告诉浮层，菜单就不收起。要点外部必收的菜单，再用 `src/platform/press` 的 `onPressOutside(() => Promise.all([frameOf(面板), frameOf(触发器)]), 关闭)`：外壳把每次鼠标按下转给应用（`shell.press`，窗口坐标），落在这些框外就关；关闭要能重复调用（NSH 看到的时候两边都会关）。触发器要算在框里，不然按下就关、松开又被它打开。`Modal` 里别用（`InModal()`）：那里量出来的是对话框里的坐标，不是窗口的。例子：`ui/chat/TunePicker.tsx`。
- **点在别处，输入框会失焦**（和网页一样；NSH 自己按 AppKit 的习惯把焦点留在输入框里，上游现在也是这样）：有输入框在编辑、按在应用自己的视图上时，外壳（`host/src/press.rs`）在按下的那一刻就让它失焦，组字中的拼音先按提交处理。按在另一个输入框、滚动条上不算；自绘文字、靠隐藏输入打字的视图（消息框的 `RichEditor`、代码的 `Editor`、终端、远程屏幕的键盘：隐藏输入宽或高不到 2pt，或完全透明）里的按下算在它的输入框里；`TimeField`、`OtpInput` 的透明输入框盖满整个控件，按在上面本来就是按在输入框里。网页里靠 `onmousedown` 的 `preventDefault` 留住焦点的地方（替输入框挑选的列表：@ 列表、/ 命令、筛选的行），这里用 `keepFocusIn(() => frameOf(列表))` 登记，组件卸载时自动撤掉。登记着的时候外壳不再自己动手，把按下交给应用判断（`shell.keepers` 报数量）；和 `onPressOutside` 一样，`Modal` 里量出来的不是窗口坐标。例子：`ui/chat/MentionPopup.tsx`。
- **倒置 `List` 的 `scrollToIndex` 里，`viewPosition` 是反着的**：0 是那一行的下沿对齐视口下沿，1 是它的上沿对齐视口上沿。回到底部曾写成 `{ index: 0, viewPosition: 1 }`，最新一条比视口矮时被夹到底部，看不出毛病；比视口高（长回复、大代码块）就停在它的开头，下半截在视口外（距底部 = 行高 + 顶部内边距 − 视口高）。要「到底」写 `viewPosition: 0` 加一个超过底部内边距的 `viewOffset`，列表会按内容夹取。`scrollToOffset` 对独立列表不夹取，别拿它去「够到底」。`stories/stage-scroll.tsx` 和 `.ui/stage-scroll.test.tsx` 拿最新一行 900pt 高的列表量落点。
- **`List` 的 `contentStyle` 和 `contentClass` 只认一个**：`contentStyle` 里只要有一项，`contentClass` 给的内边距和间距就整份作废，不是逐项合并。`contentClass="py-5 gap-4"` 旁边放一个只写左右内边距的 `contentStyle`，结果行与行之间是 0（两个对话列表曾经这样，消息首尾相贴）。用了 `contentStyle` 就把内边距和 `gap` 全写进去。倒置列表里 `paddingTop` 是靠消息框那一端，`paddingBottom` 在最早一行上方。`Scroll` 的 `contentStyle` 是普通内联样式，和 `contentClass` 逐项合并，没有这个问题。`scripts/list-content.test.ts` 读源码查这一条。例子：`ui/chat/ChatStage.tsx`、`ui/chat/ProjectChat.tsx`。
- 会换行的长文字别放进横排（`flex-row`），尤其当外面的框按内容收缩（`self-start`、`items-start` 的父级）：NSH 0.4 按文字不换行时的宽度算高度，框比文字矮，后面的东西压到文字上。文字直接放进纵向的框；旁边要有图标就让图标 `absolute` 放在文字的左边距里（`TranscriptSystem.tsx` 的系统卡片）。给文字加 `flex-1 min-w-0` 更糟：框缩成一条，文字不见。
- 靠内容撑宽的居中块（`self-center` / `m-auto`、带 `max-w-[…]`、没写宽度），在 NSH 里按子项的 flex-basis 定宽：里面横排的 `flex-1` 文字 basis 是 0，不算宽度，块就缩到其余子项（头像）那么宽，文字一字一行地竖下去（空会话的欢迎页曾缩成一条，建议卡片压到消息框底下）。浏览器里它被文字的 max-content 撑到上限，写成 `w-full max-w-[…]` 就一样。例子：`ui/chat/ChatWelcome.tsx`。
- 网格的自动行（不写行高的 `grid-template-rows`、`subgrid`）在这里拆成纵列里的一排排横排时，每排写 `grow`，别写 `flex-1`：纵列按内容定高时，`flex-1` 的 basis 是 0，几排平分整列的高度，矮的那排空出一截，高的那排装不下，最后几行压到下面的东西上（用量页窄到一个 Agent 的几个账号上下排时，Team 卡的最后一行曾压住 Codex 的标题）。`grow` 先按各排的内容排，只把多出来的高度（旁边更高的块撑出来的）分下去。例子：`ui/usage/UsageBoard.tsx`。
- 写死高度的弹窗（`height: min(92dvh, …)` 这类；Bot↔Bot 私聊在 `BotDmDialog.tsx` 里自己算了正文高度）给 `Modal` 传 `fill`，别让它按内容定高：`Modal` 默认只有 `maxHeight`，内容少时卡片扁成宽宽的一条（子代理还没动作时只剩一行），轮询读进新内容时又一跳一跳地变高。`fill` 让卡片固定那么高、正文撑满，正文里 `flex-1 items-center justify-center` 的块就能把「还没有内容」放在中间。例子：`ui/chat/ProjectSubagentDialog.tsx`。
- 一个滚动区先后装着几种状态（消息列表、空会话的欢迎页）时，拆成几个分支，每个分支都要自己能滚：只有列表那支是 `List`，欢迎页曾放在不滚的 `View` 里，舞台一矮，后面的建议卡片就压到消息框底下够不着。要在放得下时居中，写 `<Scroll class="flex-1 min-h-0" contentClass="grow">`，里面的块照旧 `m-auto`。例子：`ui/chat/ChatStage.tsx` 的 `StageWelcome`。
- `<Each of={…}>` 吃 `state()` 的深层代理数组时什么都画不出来：写 `of={list.slice()}`（或 `snapshot(list)`）。组件内部 `Each` 的东西也一样：把 `src/m` 里 store 的 `state()` 整个交给组件（比如 `ShellWorkbench.layout` 交给 `Workbench`，它在里面 `Each` 每个窗格的 `tabs`）之前，先 `computed(() => snapshot(x))` 变成普通对象；故事里传的是普通对象，测不出来。例子：项目会话的命令列表只打 `/` 时，`matchCommands` 原样交出仓库里的代理数组，列表是空的，多打一个字母才出来（ADR 0107 补记三十三）。
- 列表要带 `key` 写 `<Each>`，别写成 `{() => list().map(…)}`：后者读到的东西一变就把每一项重建一遍，项里自己记着的状态（展开、点开的那一行）跟着丢。轮询读来的数据每次都是新对象，内容没变也一样：子代理弹窗每 1.5 秒重读一次，展开的工具调用曾一会儿就自己收起。故事里让每次读都交出新对象，才测得出来。例子：`ui/chat/ProjectSubagentDialog.tsx`。
- 桌面引擎的 `Intl` 只有 `DateTimeFormat` 和 `NumberFormat`；`RelativeTimeFormat` 由 `src/platform/relative-time.ts` 补了中英文，`PluralRules`、`Collator`、`ListFormat`、`Segmenter` 都没有，用到的话报告里说。
- `RichEditor` 有焦点时，应用级 `keymap.bind`（连 `{ when: "always" }` 也一样）不触发：在测试宿主里，一个没用到的 `mod+j` 在 `RichEditor` 有焦点时不响应，换成 `Input` 就响应。`RichEditor` 里的 Enter 只会分段。要在它里面接管按键，用 `RichEditorPlugin(key).captureKeys(["Enter", "ArrowUp", "Mod-Enter"], handler)` 放进 `createRichEditor({ plugins })`：`capturing` 为真时原生编辑器吞掉这些键、事后把键名交给 handler（所以「是否吞」要在按下之前由 `capturing` 定好，例如 Backspace 只在光标紧挨小标签时设 `capturing`）。一个插件的 `capturing` 管它所有的键，不同条件的键拆成不同插件；同一个键可以出现在几个插件里，开着的那个起作用。例子：`ui/chat/ComposerEditor.tsx`。
- 弹层不知道背后的滚动：没有「背后滚了就关」，菜单靠点外面和 Escape 关。
- **`Popover` 按内容的尺寸放，贴着触发器的是靠它那条边**：朝上开时底边在触发器上方，内容变高只能往上长，内容顶部跟着走。里面几块并排、后开的会更高（级联选择的列）时，按靠触发器的那条边对齐（朝上 `items-end` 加 `marginBottom`，朝下 `items-start` 加 `marginTop`），不然后开的高列把先开的整块推走。哪一边、那一边还有多少地方，读 `onPosition` 的 `placement` 和 `available`，并把内容收在 `available` 里，否则它会翻到另一边。例子：`ui/chat/TunePicker.tsx` 的 `columnShifts`。
- 窗口是否有焦点、是否在后台（网页里的 `document.hasFocus()`、`visibilityState`）：从 `src/platform/lifecycle` 导入 `lifecycle`，不要从 `nsh` 导入——NSH 0.4 的 web 包里 `nsh` 模块没有 `lifecycle`，调用就抛错；平台那份在桌面上就是 NSH 的，web 上读页面。
  - 在场上报（`runtime.reportDesktopNotificationView`、`sendPresenceHeartbeat`）读 `document` 的写法在 NSH 上抛错被吞，从不到达宿主，`runtime.nativeFocusFacts` 一直停在「什么都不可见、什么都没焦点」，会话的已读（`ui/chat/stage-reading.ts`）曾因此在桌面上一条都读不了。现在两处都读 `lifecycle()`（`m/notifications/notification-center.svelte.ts` 的 `windowUse`），但 `nativeFocusFacts` 要等一次上报才动，**仍不要拿它当闸**，已读只认 `lifecycle()`。
  - 在场上报让守护进程压掉你正在看的那个会话的桌面横幅（在看、窗口有焦点、在最新一行）。「在最新一行」由选中会话的那个窗格报（`trackReading` 的 `report`，经 `runtime.noteConversationView`），五秒一次的心跳重复它最后说的；心跳不能总报「不在最新一行」，那样五秒内就把横幅压制收回去了。
- **`Video` / `Audio` 不收 `blob:` 地址**：桌面上的播放器（macOS 是 AVPlayer）只开文件路径和 http(s) 地址，`URL.createObjectURL` 做的 `blob:` 给它就报 unsupported URL；网页里 `<video>` 用 blob 没问题，在这里打不开。本机运行时的工作区文件给绝对路径（`ui/overlays/media-source.ts`），路径要在 `nsh.json` 的 `capabilities.fs.read` 里（现在是用户目录和 `/Volumes`），否则 `onError` 报 `ERR_ACCESS_DENIED`；web 上浏览器播 blob，照旧。这样的文件加载器不读字节（`ArtifactLoaderHost.mediaFile`，和 `mediaSource` 同一个判断）：注解要的哈希取同一个文件 GET 的 `ETag`（整份文件的 sha256；带 range 的 GET 只是那一段的），读到响应头就丢掉响应体。`Video` 也没有自己的尺寸可供排版：网页靠 `<video>` 的固有比例，这里要从 `onLoad` 的 `size` 算出框的宽高（`ui/annotations/media-fit.ts`）。
- **大文件不经过 JS**：QuickJS 里把文件字节挪一遍、拼一遍都很贵，窗口跟着停。本机运行时上，视频、音频、图片把绝对路径给原生控件（`mediaFilePath`，图片打不开时 `bytesInstead()` 退回字节），PDF、Office 让原生模块自己向运行时取（`pdfSourceOf`、`officeSourceOf`），加载器都不读字节（`ArtifactLoaderHost.localFile` / `viewerFetches`），注解要的哈希另取 `ETag`；文本类一次 `response.blob()`，不逐块跟进度条。`marked` 在 QuickJS 里是超线性的（2 万字 83 ms，6 万字超过 2 秒），Markdown 预览的分块用原生的 `Markdown.markdownBlocks`（markdown-rs，在后台线程），宿主没有这个函数时才退回 `marked`。对整份文本跑的正则（`viewportMeta`、`tooLargeToRender`、换行折叠）不要放在每次布局都调用的函数里：用 `computed` 按文本只算一次，能先用 `indexOf` 判断的先判断。原生模块里耗时的活（PDF 的页面图和解析、Office 的解析、文档里的图片缩放）放在阻塞线程上做（`nsh_core::prelude::blocking`，`renderPdfPageAsync`、`officeImageAsync`），JS 先看宿主有没有这些函数，没有就退回同步的老函数。
- **`Image` 按路径解码一次就一直是那张**：NSH 的解码缓存以 `file://<路径>` 为键（`Location::key`，不看修改时间，`file:` 地址带的查询也会被丢掉），本应用活着的期间文件改了也照样显示旧图，新开的窗格也一样，而且没有清缓存的接口。加载器记着每张按路径显示过的图当时的哈希（`decodedByPath`），再开时先问 `fileStat`，哈希变了就改用字节（`data:` 地址按内容做键）。
- **预览跟着磁盘走**：`ArtifactLoader.watchFile` 每秒（远程三秒）问一次 `GET /v1/workspace/stat`（附件是 `/v1/attachments/:id/stat`），运行时按大小、时间和 inode 记着哈希，文件没变就不读。`ETag` 和屏幕上的不一样就用 `loadPreview(…, { again: true, etag })` 再读：不出加载提示、不清 `missing` 和哈希，读失败也保持原样，下次再试；有未保存的修改（或正在画的批注）不读，字节到了时再看一次，这期间有了修改就丢掉这次读到的、哈希留原来的，保存照样 409。按路径读文件的播放器、PDF、Office 查看器靠 `loader.version` 在 `ArtifactBody` 里重建，哈希直接用这次问到的，不再整份读一遍；图片再读一律走字节。同一个版本最多读两次（`#tried` / `#tries`）：播放器不认的片子、一直读失败的、读回来的哈希和问到的对不上的（比如经中继的写法不同），不然每秒重建一次查看器、让运行时整份读一次。8 MB 以上、两秒内还在变的文件运行时回 409 `file_changing`，不在每次问时整份算哈希，停下来以后算一次。源码视图同一个文件的新文本用 `changedSpan` 算出变化的那一段，`EditorRef.edit` 一步替换（编程式编辑在只读的 Editor 上也生效），不重建 Editor，滚动位置和光标都留着。运行时太旧、没有这个路由时，问不到就当没变。
- **`shell.*` 只在桌面上有**：web 上 `host.available()` 也是真，宿主是页面自己的 `web/host.js`，只答 `runtime.endpoint`。要调外壳的地方先看 `platform.os !== "web"`（例子：`src/platform/press.ts` 的 `shell()`），别只看 `host.available()`。`web/host.js` 的 `call` 必须是 async：NSH 可能在拿着整个应用（排第一屏、按需加载的模块装好时）的当口发宿主调用，同步抛错或同步给出结果会重入，web 上直接 panic（`RefCell already borrowed`，`nsh-platform-web` 的 `send`），页面只剩「This app could not start」。
- **web 上嵌套的 `Scroll` 会吃掉自己滚不动的滑动**：NSH 的 web 运行时给每个滚动视图 `overscroll-behavior: contain`（两个方向）。嵌在会话里的滚动视图——只左右滚的（`TextView` 的代码块和表格、`horizontal` 的 `Scroll`），或内容不满、没东西可滚的纵向小块（命令卡片、命令输出）——在手机上会把滑动留在自己身上，外面的列表滚不动。手机包用 `scripts/phone-package.ts` 的 `PAGE_STYLE` 让嵌套在另一个滚动视图里的滚动视图回到 `auto`（最外层仍是 `contain`）；往会话里放能滚的东西时，用 `phone-web-e2e.ts` 的触摸手势量一下（ADR 0107 补记四十八）。
- **`minWidth` / `minHeight` 是硬下限，不会像 CSS 的 `minmax(min(<px>, <百分比>), …)` 那样随容器缩**：几个 flex 子项的下限加起来比容器大时，后面的子项直接被挤出去（`overflow-hidden` 就是被裁掉）。CSS 里用 `min()`、`calc()` 让下限随容器缩的地方，这里要量出容器的长度（工作台用 `computeGeometry` 给的每个分支的矩形），自己把下限按比例缩（`ui/workbench/cell-floors.ts`）。无头测试要用 `app.setViewport` 定下窗口大小，`app.shows` 才把窗口外的视图算作看不见。
- `ref` 只能是函数（或 `let` 变量）：`ref={undefined}`、`ref={条件 ? fn : undefined}` 会在运行时抛错。只在某些情况下才要的 ref，写成总是存在的函数，里面再判断。
- **跨几段文字的选择要一个外层选区**：每个 `selectable` 视图（`MarkdownBody` 自己就是）各管各的选区，拖选到它的末尾就停，进不了下一条消息。要像网页那样一路选下去，在外面包一个 `<View selectable>`（里面的选区并进外层的）；`List` 不认 `selectable`（JS 只把它交给 `View`），包在 `List` 外面。不该进选区的字（时间、日期线）写 `select-none`，拖选从上面跨过去，复制出来也没有它们。NSH 会把列表回收的单元格按位置排回阅读顺序，倒置列表也对。例子：`ui/chat/ProjectChat.tsx`、`ui/chat/project-chat-lines.tsx`。
- **选区会挡住右键**：右键也是从按下的那一点往外找，没有冒泡。最近的挂了 `onContextMenu` 的视图说了算；在那之前先碰到选区（`selectable` 视图，或 `select-text` 的字：`MarkdownBody` 两样都是），就弹 NSH 自己的「拷贝 / 全选」，不再往外找。窗格的右键菜单挂在窗格根上，所以窗格里的选区会把它整个挡掉（项目会话曾经在哪右键都只有拷贝）。窗格里的选区要把窗格菜单接过来：外层 `<View selectable>` 自己挂 `onContextMenu`（同一视图上监听先算），打开 `PaneMenu`（`ui/workbench/pane-menu.ts`，`WorkbenchLeaf` 提供，窗格外为 null，那里就别挂，留着 NSH 的拷贝菜单）；里面不能再有自己的选区：`MarkdownBody` 写 `selectable={false}`，内层的 `<View selectable>` 去掉 `selectable`，`TurnStepList` 传 `selectable={false}`。没写 `selectable` 的字照样并进外层选区，跨行拖选不受影响。无头测试的 `rightClick` 只找监听、不看选区，测不出来，要在真窗口里右键看（ADR 0107 补记二十八）。对话里的每一条消息也是这样：Bot 的回复、你的气泡、系统卡、提问卡各自的选区视图用 `ui/chat/transcript-parts.tsx` 的 `lineSelection` 铺上 `selectable`、`onSelectionChange` 和 `onContextMenu`，右键打开消息菜单，并把这一条里选中的字交给菜单的「复制内容」；里面的 `MarkdownBody` 写 `selectable={false}`，`WorkQuestionCard` 没有自己的 `selectable`。`scripts/line-menu.test.ts` 读源码守着这条（补记三十二）。消息里的文件块比行更近：`MarkdownBody` 的 `ArtifactChip` 在块本身和它的每段字上都挂 `onContextMenu`，右键打开文件菜单（`ui/FileChipMenu.tsx`，复用 `ArtifactTreeMenu`），不再落到行菜单；要传 `files`（`ui/file-on-disk.ts`：Bot 的用 `workspaceFiles()`，项目会话用 `project-chat-state` 的 `files()`），不传就没有文件菜单。`ui/chat` 里每个 `MarkdownBody` 都要传，`scripts/file-chip-menu.test.ts` 读源码守着（补记三十五）。
- **从访达拖进来的文件由最近的 `onFileDrop` 接**：视图上挂 `onFileDragEnter` / `onFileDragLeave` / `onFileDrop`（只有桌面有，给的是 `file:` 地址和按名字猜的类型），落点往外找第一个挂了的视图。输入框（消息框的 `RichEditor` 也是）不会把文件吃掉、插成路径：NSH 的 macOS 宿主把落在输入框上的文件拖动交给它外面的落点（`nsh-platform-macos` 的 `file_drop.rs`，`text_entered`；读源码得知，真窗口里没拖过）。几个落点挨着时，下一个的 enter 可能先于上一个的 leave 到，所以「谁设的谁清」（`ui/overlays/ArtifactTree.tsx` 的 `dropAt`）。读文件走 `fs`，只读得到 `nsh.json` 的 `capabilities.fs.read` 里的地方；要拷进工作区的（文件树）交给运行时按路径拷，字节不经过 JS。无头测试的 `app.dropFiles` 只有落下，没有 enter / leave。例子：`ui/chat/composer-drop.tsx`、`ui/chat/ChatStage.tsx`。
- **应用里拖着走的东西（树里的行）落在哪，靠量框**：拖动由按下那一行的 `PanResponder` 一路拿着，指针经过的别的视图收不到进入、移动，也没有拖放事件。落点各自登记一个视图（`ui/workspace-drag.ts` 的 `workspaceDropTarget`），拖动时按 `ViewRef.measure()` 量出的框找指针下的那个，框套在一起时取最小的；要知道落在里面哪一处的（文件树：哪一行），实现 `hover` / `leave`，`drop` 会带上松手的位置，再自己量里面各行的框。虚拟列表的行用 `ref` 登记、在行里 `cleanup` 注销，被收走的行量不到。例子：`ui/overlays/ArtifactTree.tsx`。真窗口里的行拖动可以用开发检查的 `drag x y x y` 请求（真的鼠标事件，发给那个窗口，不碰屏幕）在 `--background` 的宿主上验，见 README 的「开发版宿主的检查用参数」；运行时另起一个临时的（照 `scripts/ui-tests.ts` 开头起运行时的写法，数据目录放在用户目录下），别连 17890。
- **拖窗口的区域（`desktop={{ windowDrag: true }}`）由按下的那一点往外找**：最近的写了 `windowDrag` 的视图说了算；在那之前碰到带 `onPress`、`onTouch*`、responder 的视图或输入框，这一点就是按钮，不拖窗口。所以拖窗口的那块自己别挂这些（挂了的话同一视图上 `windowDrag` 先算，但别靠这个）；里面没挂任何处理的包装视图（标签的内边距、⋯ 和 × 旁边的空隙）会一路找到外面的 `windowDrag`，按在那里就拖走窗口，要算作按钮的给它写 `windowDrag: false`。按住拖超过几点才交给系统拖窗口，原地点一下仍作为按下交给应用，双击照系统标题栏缩放。系统拖窗口跟的是真的鼠标：开发检查里合成的拖动（`drag`、`postEvent`）拖不动窗口，只能看出按下没交给应用。例子：`ui/workbench/leaf-strip.tsx`（平铺窗格标签条的空白）、`ui/sidebar/Sidebar.tsx`。
- **`List` 的一行里后来才挂上的 `Scroll`，内容会一直是空的**：`Scroll` 只先做视口附近的内容，其余的等内核再核对；这次核对排在列表给单元格摆位之前，刚挂上的 `Scroll` 还没有位置，被跳过，之后要等窗口里别的东西让页面重排才补上（对话里展开的命令卡片曾这样空着，见 ADR 0107 补记二十七）。这种 `Scroll` 挂载后第一次拿到位置时（`onLayout`）发一次 `scrollTo`，内核就会重新核对它，内容不用滚也行。只在第一次：之后每次变高（点开里面的东西）也会触发 `onLayout`，再滚就把刚点开的东西滚走了。挂载时就由 effect 滚一次的（`TurnStepList`）不受影响；外层已经摆好位置以后，里面再挂上的 `Scroll`（命令的输出）也不受影响。网页版不做这种裁剪；macOS 的滚动命令不管动没动都会回报，所以管用；Windows、Linux 也开着裁剪，回报没核对过。无头测试关了这种裁剪，测不出来，要在真窗口里看。例子：`ui/chat/CommandActivity.tsx`。

## 别碰

- 17890（你日常用的那一份：装好的稳定版，或 `--stable-instance` 起的 NSH 版）和 17990（开发实例）：不要拿它们跑测试，也不要为测试起 `scripts/dev.ts`、`dev-runtime.ts`；界面测试只用 `scripts/ui-tests.ts`（它自己起一个隔离的运行时，用空闲端口）。

## 验证

1. 类型检查：在 `apps/desktop-nsh/app` 里跑 `nsh check App.tsx` 和 `nsh check Story.tsx`，零错误。这里的 `nsh` 是 `bun apps/desktop-nsh/scripts/nsh-cli.ts --check` 给出的那一个（和宿主同一个 NSH 提交编的，见 README「NSH 的版本」），不是 `~/.local/bin/nsh`；PATH 里要有 `~/.cargo/bin`。故事只从 `Story.tsx` 进，`nsh check stories/x.tsx` 会在 `stories/` 下生成一个多余的 `.nsh/`，不要这样跑。
2. 开一个故事（新界面或改动较大的界面）：在 `app/stories/<区域>.tsx` 写一个默认导出的组件，把这个区域的界面摆出来，`stories/index.ts` 加一行登记。
3. 写界面测试：`app/.ui/<区域>-<主题>.test.tsx`，用 `.ui/fixture.ts` 的 `openStory("<区域>")`（整个应用用 `openApp()`）。测试本身连不了网（`nsh test` 的测试宿主没有网络栈，`.ui/fixture.ts` 的 `api()` 在那里会报错）：要造数据或读回运行时里的值，在故事里放按钮，经 `runtime.client` 去做，测试按按钮再读屏幕上的字（参照 `stories/settings-general.tsx` 的 `story-read`）。夹具只预置了 Writer、Editor、Writer 的私聊（两行，其中一行带 Markdown）和「周报小组」。按 `testID`（`id:x`）、文字（`text:x`）找，`press`、`type`、`waitFor` 操作；测的是行为，不是像素。`press` 会先看手指落点上画的是不是目标：被别的视图盖住就失败（`` `id:x` is covered: a press there reaches … ``），和真人点不到一样。真盖住了就改界面（引导页的语言切换曾被欢迎区压住，`z-[1]`）；目标在滚动区外，先 `app.scroll("id:x", 距离)` 把它滚进来；手机尺寸下整页的弹层盖住故事的按钮，先 `app.back()` 退出来，或者给故事的动作配一个快捷键（`keymap.bind`，测试里 `app.keyboard.press`）。无头运行器的文字是估算的（`ApproxTextEngine`），段落不会为行内的卡片撑高，后面的块会压在卡片上，真窗口里没有这回事：故事里把这种卡片放在最后一段。
4. 在仓库根目录跑 `bun apps/desktop-nsh/scripts/ui-tests.ts <文件名的一部分>`，全部通过。
5. 跑 `bun scripts/line-budget.ts`，通过。
6. `app/src/m` 里的逻辑测试见 README「共用逻辑」：`*.test.ts` 在 `app/` 里跑 `nsh test`，`*.spec.ts` 由 `pnpm --filter @real-bot/desktop-nsh test` 跑。
