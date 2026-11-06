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
| `matchMedia` / `@media (max-width: 680px)` / 容器查询 | `windowSize().width`（`nsh`）或 `onLayout` 量自己的宽度；手机布局看 `platform.desktop` 和宽度 |
| `tooltip` / `title=` | `<View tooltip={tip("…")}>`（`src/ui/tip`） |
| 拖动改宽 | `PanResponder` 或 `nsh/base` 的 `ResizablePanelGroup` |
| `{@html …}` / Markdown | `TextView`（`nsh/base`）的 `markdown`，不要拼 HTML |
| 预览生成的 HTML 页面（`<iframe srcdoc>`、blob URL） | `WebView`（`nsh`）的 `html`；页面和应用之间用 `injectedJavaScript` 和 `window.nsh.postMessage` / `onMessage`、ref 的 `postMessage`。**只有 HTML 产物预览和 HTML 批注能用 WebView**，别的界面一律原生 |
| 代码 | `Editor`、`DiffView`（`nsh/base`）；聊天里的代码块由 `TextView` 画 |

## 样式

- 类名用 Tailwind，令牌就是 `tokens.css` 的名字：`var(--ink)` → `text-ink`，`var(--pane)` → `bg-pane`，`var(--line)` → `border-line`，`var(--radius-md)` → `rounded-(--radius-md)`。两个改了名：`--accent` 是 `brand`（`bg-brand`、`text-brand`），`--muted` 是 `ink-muted`。`accent-tint`、`accent-hover` 这些照原名。
- 阴影不是令牌：`style={{ boxShadow: shadow("menu") }}`（`src/ui/styles`，按明暗自动换）。字号照信使写字面量（`text-[13px]`），对照表在 `styles.ts` 的 `TEXT`。
- 状态用变体：`hover:`、`active:`、`disabled:`、`focus-visible:`、`group` 加 `group-hover:`、`selected:`、`dark:`。
- 图标：`<Icon name="plus" size={16} class="tint-ink-muted" />`（`src/ui/Icon`），颜色只用 `tint-*` 类，悬停跟随用 `group-hover:tint-ink`。名字照 `src/m/icons.ts`。
- 现成的组件先找 `src/ui/`（见下面「已经移植的共享组件」）。没有的、几个区域都要用的，报告里说，不要各写一份。

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

两个信使的外壳级组件不单独移植：`ImageCopy.svelte`（document 级右键监听，NSH 没有 document）由显示图片的组件自己挂 `ImageContextMenu`；`WorkspaceDragGhost.svelte` 跟文件树拖动一起，由移植 `overlays/WorkspaceExplorer` 的任务做。

样式的几个坑：Tailwind 的 `em` 单位不认（`px-[0.35em]` 会被忽略，换成 px）；`font-mono` 是平台自己的等宽字体，不要写具体字体名；文字里嵌的视图（小标签）用 `style={{ verticalAlign: "middle" }}` 对齐。

移植中踩到的 NSH 行为（先照这些写）：

- `role` 只认 NSH 的 `AccessibilityRole`：没有 `dialog`、`alertdialog`、`status`，对话框用 `group` / `alert`，状态文字用 `text`，卡片用 `region`。
- `Overlay`（和放在它里面的弹层）里，`<Each>` 画不出东西：那里的列表写成函数子节点 `{() => list().map((x) => …)}`。
- `keymap` 同一个键只有最新绑定的那个生效：同时开着两个都绑 Escape 的东西，旧的听不到。焦点在输入框里还要响应的快捷键加 `{ when: "always" }`。
- 键名没有 `"+"`、`"-"`：写 `plus`、`minus`。
- `flex-shrink` 不认，写 `shrink`；CSS 变量做圆角（`rounded-(--radius-bot)`）要是主题里没有就换成具体值。
- `If` 的函数子节点拿到的是读取函数，别把它存下来到别处再读：在用的地方直接从原数据取。
- 弹层不知道背后的滚动：信使里「背后滚了就关」的菜单，这里靠点外面和 Escape 关。

## 不要做的

- 不要跑任何 git 命令。
- 不要碰 17890（装好的稳定版）和 17990（开发实例），不要起 `scripts/dev.ts`、`dev-runtime.ts`；测试只用 `scripts/ui-tests.ts`（它自己起一个隔离的运行时，用空闲端口）。
- 不要改 `src/m/`、`src/platform/`、`src/runtime.ts`、`host/`、`native/`、`app/native/`、`nsh.json`、`theme.json`，也不要跑 `pnpm install`。要改它们，写进报告。
- 不要往别的区域的目录里写文件。

## 验证

1. 类型检查：在 `apps/desktop-nsh/app` 里跑 `nsh check App.tsx` 和 `nsh check Story.tsx`，零错误（PATH 里要有 `~/.local/bin` 和 `~/.cargo/bin`）。故事只从 `Story.tsx` 进，`nsh check stories/x.tsx` 会在 `stories/` 下生成一个多余的 `.nsh/`，不要这样跑。
2. 开一个故事：在 `app/stories/<区域>.tsx` 写一个默认导出的组件，把这个区域的界面摆出来，`stories/index.ts` 加一行登记。
3. 写测试：`app/.ui/<区域>-<主题>.test.tsx`，用 `.ui/fixture.ts` 的 `openStory("<区域>")`（整个应用用 `openApp()`）。要什么数据就在测试里用 `api(method, path, body)` 现建（Bot、会话、消息、设置），夹具只预置了 Writer、Editor、Writer 的私聊（两行，其中一行带 Markdown）和「周报小组」。按 `testID`（`id:x`）、文字（`text:x`）找，`press`、`type`、`waitFor` 操作；测的是行为，不是像素。
4. 在仓库根目录跑 `bun apps/desktop-nsh/scripts/ui-tests.ts <文件名的一部分>`，全部通过。
5. 跑 `bun scripts/line-budget.ts`，通过。

## 报告

做完写清楚：新建了哪些文件；每个 Svelte 组件移植到了哪里；哪些行为没移植、为什么（NSH 缺什么能力、要动共享文件）；用了哪些需要别人提供的共享组件。
