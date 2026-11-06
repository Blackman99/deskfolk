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
| 代码 | `Editor`、`DiffView`（`nsh/base`）；聊天里的代码块由 `TextView` 画 |

## 样式

- 类名用 Tailwind，令牌就是 `tokens.css` 的名字：`var(--ink)` → `text-ink`，`var(--pane)` → `bg-pane`，`var(--line)` → `border-line`，`var(--radius-md)` → `rounded-(--radius-md)`。两个改了名：`--accent` 是 `brand`（`bg-brand`、`text-brand`），`--muted` 是 `ink-muted`。`accent-tint`、`accent-hover` 这些照原名。
- 阴影不是令牌：`style={{ boxShadow: shadow("menu") }}`（`src/ui/styles`，按明暗自动换）。字号照信使写字面量（`text-[13px]`），对照表在 `styles.ts` 的 `TEXT`。
- 状态用变体：`hover:`、`active:`、`disabled:`、`focus-visible:`、`group` 加 `group-hover:`、`selected:`、`dark:`。
- 图标：`<Icon name="plus" size={16} class="tint-ink-muted" />`（`src/ui/Icon`），颜色只用 `tint-*` 类，悬停跟随用 `group-hover:tint-ink`。名字照 `src/m/icons.ts`。
- 现成的组件先找 `src/ui/`（`Button`、`IconButton`、`Icon`、`Switch`、`tip`……）。没有的、几个区域都要用的，报告里说，不要各写一份。

## 不要做的

- 不要跑任何 git 命令。
- 不要碰 17890（装好的稳定版）和 17990（开发实例），不要起 `scripts/dev.ts`、`dev-runtime.ts`；测试只用 `scripts/ui-tests.ts`（它自己起一个隔离的运行时，用空闲端口）。
- 不要改 `src/m/`、`src/platform/`、`src/runtime.ts`、`host/`、`native/`、`app/native/`、`nsh.json`、`theme.json`，也不要跑 `pnpm install`。要改它们，写进报告。
- 不要往别的区域的目录里写文件。

## 验证

1. 类型检查：在 `apps/desktop-nsh/app` 里跑 `nsh check App.tsx`，零错误（PATH 里要有 `~/.local/bin` 和 `~/.cargo/bin`）。
2. 开一个故事：在 `app/stories/<区域>.tsx` 写一个默认导出的组件，把这个区域的界面摆出来，`stories/index.ts` 加一行登记。
3. 写测试：`app/.ui/<区域>-<主题>.test.tsx`，用 `.ui/fixture.ts` 的 `openStory("<区域>")`（整个应用用 `openApp()`）。要什么数据就在测试里用 `api(method, path, body)` 现建（Bot、会话、消息、设置），夹具只预置了 Writer、Editor、Writer 的私聊（两行，其中一行带 Markdown）和「周报小组」。按 `testID`（`id:x`）、文字（`text:x`）找，`press`、`type`、`waitFor` 操作；测的是行为，不是像素。
4. 在仓库根目录跑 `bun apps/desktop-nsh/scripts/ui-tests.ts <文件名的一部分>`，全部通过。
5. 跑 `bun scripts/line-budget.ts`，通过。

## 报告

做完写清楚：新建了哪些文件；每个 Svelte 组件移植到了哪里；哪些行为没移植、为什么（NSH 缺什么能力、要动共享文件）；用了哪些需要别人提供的共享组件。
