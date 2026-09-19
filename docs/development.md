# Real Bot 开发说明

> **WIP：**本文记录当前开发实现与限制，不是稳定版功能承诺。项目定位见 [README](../README.md)，建设方向见[路线图](../ROADMAP.md)。

本机 macOS 上的单人 agent 协作应用。词汇见 [`CONTEXT.md`](../CONTEXT.md)。以下命令均在项目根目录执行。

## 包

| 包 | 路径 | 运行时 |
|---|---|---|
| `@real-bot/daemon` | `apps/daemon` | Bun `>=1.2` |
| `@real-bot/messenger` | `apps/messenger` | Node `>=22` · SvelteKit SPA |
| `@real-bot/desktop` | `apps/desktop` | Tauri 2 壳 |
| `@real-bot/landing` | `apps/landing` | SvelteKit 静态落地页（GitHub Pages） |
| `@real-bot/protocol` | `packages/protocol` | 本机接口 TypeScript 类型 |

守护进程不是 sidecar（`externalBin` 为空）。窗在监督时若本机接口不是我们，会用本机 `bun` 拉起 `apps/daemon/src/main.ts`；已有我们则连，不新开第二个。登录项只登记窗口进程（参数 `--hidden`，登录不弹窗）。`pnpm dev` 不写登录项。退出（Cmd+Q / 托盘退出）先停监督再 `POST /v1/runtime/quit`。

## 守护进程源码布局

`apps/daemon/src` 按职责分文件，两处按目录组织：

- `store/`：SQLite 与钥匙串的唯一入口。`index.ts` 是 `Store` 门面（开库、跑 `migrate.ts` 的补列补表、把各模块函数绑上库上下文暴露成方法）；`shared.ts` 放行类型、设置读写和跨域共用的查询原语；其余每个文件一个领域：`settings`（设置与旧单端点镜像）、`providers`（端点、名单、钉模型校验）、`bots`、`skills`、`routines`、`sessions`（会话、成员、删除 / 清空）、`messages`（消息、附件、回应）、`turns`（轮次、Stop、中断）、`approvals`（批准与 Always allow）、`spend`、`judgements`、`mcp`、`routing`（每轮模型选择、结果与 Bot 各自的经验）、`search`。模块函数一律 `fn(ctx, ...)`，模块之间只从 `shared` 或彼此按领域导入；给 `Store` 加能力时先放进对应模块，再在 `index.ts` 绑一行。
- `prompts/`：`system.ts`（轮次 system 中英两套与人设 / 技能 / MCP 段拼装）、`judgement.ts`（判断 system）、`transcript-copy.ts`（补全失败与点名失败的转录文案）、`tool-schema.ts`（工具定义类型与中英本地化）、`tools/*.ts`（内置工具按文件、协作、人设与技能、日程、端点与 MCP 分组）、`builtin-tools.ts`（按模型可见顺序拼成 `TOOLS`；顺序由 `prompts-order.test.ts` 钉死）。`index.ts` 只做再导出，导入路径仍是 `./prompts`。
- 纯函数模块留在顶层：`route-decision.ts`（候选、评分、经验的正负与封顶）、`models.ts`、`mentions.ts`、`context.ts`、`schedule.ts` 等；`turn-engine.ts` 是轮次回路，`local-api.ts` 是本机接口。

## 信使源码布局

`apps/messenger/src/lib` 按界面上的「面」分目录，每个目录放那一面的组件和只有它用的纯函数模块（测试与被测模块同目录）：

- `chat/`：`ChatStage.svelte` 是主栏的转录 + 回到底部按钮 + 作曲栏，滚动状态归它，因为发送、搜索跳转和内容变高都要动它；`Composer.svelte` 管输入框、`@` 补全、附件、引用条和发送 / 停止按钮，草稿只写 `runtime.draft`，外面要落光标就调它导出的 `focus()`；`ChatHeader.svelte` 是会话顶栏。模块有转录分组与时间文案、批准卡判定、作曲栏形态与输入法状态机、`@` 芯片与候选、引用回复、快捷提示词、滚动计算。
- `sidebar/`：`Sidebar.svelte` 是整条侧栏（名册行、搜索、会话分组、归档视图、底部工具栏、主题菜单），两张新建弹窗和右键菜单也在这里。模块有会话分组 / 状态 / 标题、未读、搜索跳转、置顶、宽度。
- `panels/`：会话设置抽屉的两片 —— `ProfilePane.svelte`（人设与技能，自己管草稿与自动保存）和 `GroupPane.svelte`（群名、成员、拉人）。抽屉外壳还在 `Shell.svelte`。
- `settings/`：`SettingsModal.svelte` 同时渲染设置弹窗和叠在它上面的端点编辑浮层（两个根元素，都还是 `.shell` 的直接子节点）。模块有端点表单、MCP 表单与列表、向导保存、工作区选择。
- `overlays/`：产物预览、工作区浏览、模型选择记录、危险动作确认框，以及 Monaco / 产物树 / 路由日志窗口化这些模块。
- 跨面共用的留在 `lib/` 顶层：`copy.ts`（中英文案树）、`api.ts` / `runtime.svelte.ts` / `snapshot.ts`（本机接口与快照）、`theme.ts`、`avatar.ts`、`markdown.ts`、`discovery.ts`、着色相关，以及 `Shell.svelte`、`Onboarding.svelte`、`Select.svelte`、`SessionAvatar.svelte`、`AvatarEditor.svelte`。
- `styles/`：**只剩没有任何一个组件能认领的规则**，1052 条里的 134 条；其余都回到了渲染那个元素的组件里（见下面「信使样式分层」）。每个文件的头注释写明它为什么搬不动：
  - `tokens.css` 配色令牌与暗色覆盖，`base.css` reset —— 全局底座。
  - `shared.css` 不止一个面会往自己元素上挂的 class（`.field-error`、`.avatar-img`、`.btn-chip`、`.sheet-close`、`.row-avatar`、`.avatar-status-dot`）。只放这个东西本身和它的通用状态。**动它会波及每个面。**
  - `drawers.css` 会话设置抽屉的外壳、`panels.css` 两个抽屉面共用的家具、`modals.css` 所有对话框共用的框。里面装什么是各自组件的事。
  - `code-highlight.css` Shiki 写进三处不同表面的 `.tok`、`third-party.css` Monaco 挂到 `document.body` 上的浮层 —— 都没有可作用域化的宿主。
  - `responsive.css` 只有 680px 那一条跨面断点；**它排在 `index.css` 最后**，因为它的活就是覆盖上面的面。各个面自己的响应式写在各自组件里。
  - `styles-coverage.test.ts` 会在全局表里有样式没人用时失败。它认得 `class="tab is-{kind}"` 这种插值（记下 `is-` 前缀），第三方 DOM 有一张写明理由的白名单。**两个提取上的坑都踩过**：引号正则若允许跨行，英文文案里的撇号会让它吞进无关代码，那堆残骸里的每个词都算「有人用」；规则上方的注释若不剥掉，会变成选择器的一部分，于是**带段落注释的规则从来没被检查过**。`.detail` 整族死样式就是这么活下来的。

打开的是哪个会话记在 URL 的 `?s=<id>` 上，打开的产物预览记在 `?p=<relpath>` 上（`session-url.ts`），刷新、热更新和后退键都回到同一个会话和同一块预览。用查询参数而不是路径，是因为打包后的 Tauri 窗通过资源协议直接服务 `build/`，没有 SPA 回退：`/s/<id>` 一刷新就是 404，而 `index.html?s=<id>&p=<relpath>` 永远是磁盘上那个文件。`+page.svelte` 里会话与预览各有一对镜像 effect，各自只跟踪自己那一侧（都跟踪就会互相覆盖）；URL 里的会话 id 在会话列表到达前不动它，`connect()` 拿到列表后会把不存在的 id 清掉。预览路径挂在 `MessengerRuntime.previewRelpath` 上、不跟 `Shell` 走：断线那一屏卸掉 `Shell` 再连上时，预览还在。非法路径（空、绝对路径、`..` 逃出工作区）当没打开。设置、抽屉、路由日志、工作区浮层不进 URL：它们的开关已经在 `MessengerRuntime` 上互斥，搬进 URL 只会让 Escape 级联多一个真相来源。

`Shell.svelte` 只剩三栏骨架：把上面这些面摆好、按固定优先级处理 Escape（主题菜单 → 危险确认 → 新建 Bot → 新建群 → 端点浮层 → 设置 → 人设 → 会话设置 → 路由日志 → 工作区 → 产物预览）、持有哪一层浮层开着的标志，以及会话右键菜单。跨面的窗口级监听只有 Escape 这一条留在这里；点击外部关闭没有优先级，各自在自己的组件里用 `click-outside.ts` 的 `isOutside`。

## 信使样式分层

新写或改一条样式，按这个顺序挑落点，挑不到再往下走：

0. **`virtual:uno.css` 在 `src/hooks.client.ts` 里引，不要放进 `+layout.svelte`。** 它在 dev 下是异步生成的（插件要等首次扫描），而 SvelteKit 用再导出绑定从 `.svelte-kit/generated/client/nodes/N.js` 上取 `component`；路由组件引它就可能在还没求值完时被读到，抛 `Cannot access 'component' before initialization` —— 堆栈里**一帧应用代码都没有**，而且只是偶发（实测窗口冷启动三次中两次，浏览器标签页晚一点打开就碰不到）。`hooks.client.ts` 在路由图之外、应用启动前加载，没有可竞争的东西。

1. **Uno 工具类**（`apps/messenger/uno.config.ts`）。布局、间距、字号、配色这些普通样式写在 `class` 上。主题取自 `tokens.css`：颜色映射到 `var(--pane)` 这类令牌，不写死色值；圆角、阴影、字体同理。**数字就是 2px 一档，`p-7` 和 `w-7` 都是 14px** —— 间距和尺寸共用一把尺（presetWind3 默认给尺寸另一把 0.25rem 的尺，配置里覆盖掉了）。
2. **组件自己的 `<style>`**。只有这个组件才有的东西 —— 伪元素、动画、带结构的 `:hover` / `:focus-visible`、媒体查询、`-webkit-` 前缀那些。Svelte 会作用域化，改它波及不到别人，而且**选择器没人用时 `svelte-check` 直接报 `css_unused_selector`** —— 全局表要靠 `styles-coverage.test.ts` 才查得出来的事，搬进组件就变成编译期检查了。
3. **`lib/styles/*.css` 全局**。只留真正没有宿主的：令牌、reset、几个面共用的骨架、第三方 DOM、那条跨面断点。**跨组件的先想办法拆进它作用的那个组件**，拆不动才留在这儿。

搬完了：全局表从 1052 条降到 134 条。

### 一条规则归谁

**归渲染「被它改的那个元素」的组件** —— 也就是选择器最右边那一段。作用域类落在真正被改的元素上，`css_unused_selector` 才管得住它。两个例外：

- 最右那个元素**没有组件**（Monaco 的 DOM、Shiki 写的 `.tok`、`mention-chips.ts` 手搭的芯片），就往左退到第一个有组件的祖先。
- 最右那个是**多处复用的控件**（`Select`、`SessionAvatar`、`AvatarEditor`、`FileIcon`、`WorkspacePicker`、`ArtifactPreview`），而选择器里还有它之外的上下文 —— 那是调用方「在这儿想让它长这样」的意见，归调用方。否则通用控件会攒出一份用它的面的名单。

选择器里除锚点以外、这个组件自己不渲染的每一段，都要包 `:global()`。**判断一个复合选择器归谁要取交集**：`.step-bar-item.is-active` 是同一个元素同时挂两个类，九个组件都用 `is-active`，但只有 Onboarding 把两个挂在一起。

### 三个只有基线能抓到的坑

- **伸进子组件的规则，作用域化后会静默失效。** `.onboarding-step-content .btn-preset-workspace` 里的按钮是 `WorkspacePicker` 的，包成作用域后只匹配 Onboarding 自己那份，picker 那份从 32px 长到 38.25px。`svelte-check` 一声不吭 —— 选择器在它的新家确实有人用。
- **`@media` 包裹会在搬运中掉。** 掉了的规则在所有宽度生效，而固定宽度的截图永远看不出来。改完用「(媒体查询, 选择器) 配对」的前后集合对一遍；680px 断点现在有 `shell-narrow` 这张窄屏基线守着。
- **层叠位置本身可能在做事。** 原来排在最后一个 import 里的规则，搬进组件后落在中间就可能被压过。作用域化会加一层类（`.a` → `.a.svelte-x`），特异性变了，顺序也变了。

### Uno 配置上的三个坑

三个都是同一类：工具类**看着**在做那件事，其实做的是别的事，或者什么都没做。

- **`text-*` 默认会捎带一个 `line-height`。** presetWind3 的 `text-*` 总要一并设行高 —— 裸的字号配置给 `1`，配成对就给你写的那个值。两种都会覆盖掉元素本该继承来的行高，而这张表**两个方向都依赖继承**：大部分文字取 `base.css` 上无单位的 1.5，而自己写了 `line-height: 1` 的卡片指望子元素跟着。配成 `[大小, '1.5']` 治好了前者、弄坏了后者（回复卡里的「思考中」行从 11.5px 变成 17.25px）。现在 `text-<size>` 是配置里一条**只发 `font-size`** 的自定义规则，和它替代的那句声明一模一样。
- **尺寸类原本走另一把尺。** presetWind3 的 `w-4` 是 0.25rem 一档，和 `theme.spacing` 无关 —— 于是 `p-17` 是 34px 而 `w-17` 是 68px，一套名字两把尺。配置里把 `width` / `height` / `min*` / `max*` 都指到同一个 `SCALE` 上。
- **border 工具类静默失效。** 没有 preflight 就没有 `border-style: solid` 的底，`border-t` 只设宽度，画不出线。补 preflight 试过，六个面当场变样（表里大量规则只写 `border-color` 或只写 `border-width`，原本靠 UA 默认的 `border-style: none` 兜着）。现在是 `blocklist: [/^border($|-)/]`，边框继续写 CSS；`uno-utilities.test.ts` 让「写了 border 工具类会报错」这句话成真 —— 它把 markup 里每个长得像工具类的 token 交给 Uno 生成一遍，生成不出东西就失败。

### 把一条规则改写成工具类，要先证明它等价

不要凭眼睛。`tests/uno-equivalence.mjs` 读一组工具类、回答它们实际声明了什么：

```bash
echo '{"x":["w-17","py-7","px-8"]}' | bun tests/uno-equivalence.mjs
```

把它和原规则展开成长写形式逐项比，不一致就别改。这一轮 174 条改写里它拦下了五类错：`font-[650]` 被当成 font-family、`margin: 0 auto` 只写 `mx-auto` 丢了纵向的 0、`rounded-full` 在非正方形上是胶囊而 `50%` 是椭圆、裸 hex 颜色会被拆成一个共享的透明度变量、以及上面那把错的尺。

改完再用 `dump.spec.ts` 对所有 story 做一次前后比对（**逐元素的几何 + 计算样式，不是截图**）：这一轮的结果是 19 个 story、0 行差异。截图的 20 像素阈值吃得下的东西，它吃不下。

### 搬样式怎么验

**先有视觉基线再搬**（见下一节）。`RouteLog` 那 50 条规则从全局表搬进组件 `<style>` 后截图逐像素相同 —— 这是搬运正确的证据；上面两个坑也都是基线报出来的，光看计算样式看不出来（那次每个元素的 `font-size` / `gap` / `padding` 都对，错的是没去看的 `line-height`）。

差异定位不要盯着差异图猜，用 `tests/visual/dump.spec.ts`：

```bash
DUMP_STORY=route-log DUMP_OUT=/tmp/before.txt pnpm exec playwright test dump
# 改动之后再跑一次到 after.txt，然后 diff
```

它把整棵子树的 `getBoundingClientRect()` 和三十来项计算样式写成文本，错位的那一行会自己跳出来。没设 `DUMP_STORY` 时自动跳过。路由日志那条少配的 `line-height`、Onboarding 那个丢了 `:global` 的按钮，都是这么找到的 —— 两次手工挨个量属性都看着正常。

还有一条基线兜不住的：应用跑在 WKWebView，基线拍的是 Chromium。`-webkit-backdrop-filter`、`-webkit-line-clamp`、`::-webkit-scrollbar` 这些前缀属性在搬运中丢了，Chromium 的截图不会有任何反应，只能靠读 diff 保证它们跟着搬过去了。

## 信使组件测试

和纯函数用同一个 `bun test`：`apps/messenger/test-setup.ts` 里一个 Bun loader 在 import 时用 `svelte/compiler` 编译 `.svelte`（`.svelte.ts` 走 `compileModule`），happy-dom 提供 document。`bunfig.toml` 预加载它，`package.json` 的 `test` 脚本带 `--conditions browser` —— 少了它 Svelte 会解析到服务端构建，`mount()` 直接报 `lifecycle_function_unavailable`。

写测试用 `src/lib/test-render.ts`：`render()` 挂载并 `flushSync`，`click` / `fill` / `press` 每次交互后也 `flushSync`（Svelte 5 批量更新，不刷新就断言不到）。假数据在 `src/lib/test-fixtures.ts`（`aBot` / `aDirect` / `aGroup` / `aSkill` / `fakeRuntime`，`fakeRuntime().calls` 记下组件调了运行时的哪些方法）。要让绑定的 prop 真的引起重渲染，用 `test-reactive.svelte.ts` 的 `reactive()` 包一层，普通对象写得进去但不会触发更新。

覆盖的是拆分留下的接缝，不是重测已有的纯函数：确认框的四条关闭路径、新建群弹窗「重新挂载即重置」、群组面板那份**属于外壳**的草稿（关掉再打开仍在，这是有意为之）、人设面板的自动保存与**卸载时把待发的改动冲出去**、作曲栏的 Enter / Shift+Enter / 输入法选词与上屏后那一下的接线。

## 信使视觉基线

`pnpm --filter @real-bot/messenger test:visual`。改样式前后各跑一次；基线要改就 `test:visual:update`，并在 PR 里说明为什么该变。

拍的是**单个面**，不是整个应用：`tests/visual/stories.ts` 用 `test-fixtures.ts` 的假数据把一个组件挂到 `tests/visual/index.html` 上，Playwright 按 `?story=<名字>&theme=dark|light` 逐张截。不连守护进程、不读数据库，所以基线只会因为样式变而变。新增一个面：在 `story-list.ts` 里加尺寸，在 `stories.ts` 里加组件和 props；面自己藏着的状态（比如设置弹窗开在哪个页签）用 `afterMount` 像人一样点出来，不为了拍照给组件加 prop。`shell` 那张把整个三栏框架连同侧栏、主栏、顶栏一起拍下来 —— 跨组件的规则只有它看得见。

**截图之外还断言这一面挂载时没有报错**（`pageerror` 和 `console.error` 都算）。报错的面照样会画出点东西，那张残骸拍成基线一样会「通过」；代码块复制图标那条少写半径的 SVG 弧线就是这么找出来的。

三个坑，都踩过：

- **story 的 Vite root 必须是包根**。指到 `tests/visual` 的话，`src/lib/styles/*.css` 在 root 之外、又是经 CSS `@import` 拉进来的，Vite 不监视它们 —— 基线会对着服务器启动那一刻的 CSS 拍，改了样式也照样全绿。一个不会失败的检查比没有检查更糟。
- **阈值用 `maxDiffPixels`，不要用比例**。这台机器上同一个 story 连拍两次是逐像素相同的，所以预算只需要吃掉将来的抗锯齿抖动。比例预算试过：900×520 的图上 0.2% 是 936 像素，而把弹窗圆角从 18px 改成 2px 只差 212 像素，照样通过。

- **`vite.visual.config.ts` 要跟着 `vite.config.ts` 走。** 少了 Monaco 的两条 alias，产物预览那条 import 链就是 500，而它会连坐**整张模块图** —— 所有 story 一起白屏，不只是用到编辑器的那个。

假数据要对得上协议类型，否则拍的是另一个渲染分支：`test-fixtures.ts` 一度把用户写成 `"you"`，而 `USER_MEMBER` 是 `"user"`，于是每个面都把用户画成「已删除」的 Bot，基线把这个错误一起存了下来。story 的 props 是 `as never` 进去的，TypeScript 不替你挡这一层。

不接 CI：这是系统字体的渲染，Linux runner 会对每一张都有异议。和 CONTRIBUTING 里「本机 UI 验证不能由 CI 代替」是同一条理由。

## 本机工具链

- Node `>=22` 与 pnpm `12.3.4`（`packageManager`）
- Bun `>=1.2`（守护进程，不当 npm 依赖）
- Rust / Cargo（Tauri 2）

## 命令

```bash
pnpm install
pnpm dev        # 并行守护进程 + tauri dev（信使由窗拉起）
pnpm test       # daemon bun test + messenger bun test
pnpm typecheck  # protocol / daemon / desktop tsc，信使与落地页 svelte-check；不跑 cargo check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml  # 桌面监督与线程锁回归
pnpm --filter @real-bot/messenger build
pnpm --filter @real-bot/landing build   # 可选；GitHub Pages 构建落地页
```

开发态修改信使代码走 Vite 热更新。`beforeDevCommand` 拉信使时，若 `http://localhost:5173` 已是本包开发服务器（含上次留下的孤儿 Vite），会直接复用，不再因 `strictPort` 退出；被其他进程占用才报 `port is taken`。非 5173 的残留 Vite（例如 5174）不会被复用。窗拉起的守护进程在 debug 构建里带 Bun `--watch`，改 `apps/daemon` 会重启本机接口（已有我们则连，不新开第二个；旧无 watch 进程会一直占端口，需退出后再开 `pnpm dev`）。热重载会结束进行中的轮次并标成中断——这是进程退出，不是补全失败。**开发服务器开着时不要跑 `pnpm typecheck` 或 `pnpm build`**：两者都以 `svelte-kit sync` 开头，重新生成 `.svelte-kit/generated/*` 会让在跑的页面重载路由节点，窗口里就会冒出 `Unhandled Promise Rejection: ReferenceError: Cannot access 'component' before initialization`（来自 SvelteKit 的 `client.js`）。它读起来像代码 bug，其实是那一瞬间路由节点还没初始化；浏览器多半自己恢复，窗口不一定，刷新即可。要在开发中途做检查，用 `git worktree` 另开一份目录跑。启动先占端口再开库：抢不到端口的第二份进程不会改库。窗在 `local-api.json` 里的 pid 还活着时，即使健康检查暂时超时也不再拉第二份。修改 Rust 代码由 Tauri 重编译并重启窗口。桌面监督线程在释放应用状态锁后才更新托盘菜单，避免热更新后的本机接口查询与菜单更新互相等待。若旧版本窗口已经卡死，需要结束旧窗口进程，再重新运行 `pnpm dev`；热更新无法解除已经发生的原生线程死锁。

单独起信使（浏览器改 UI，不是黄金路径）：

```bash
pnpm --filter @real-bot/messenger dev
```

开发态窗在守护进程起来之前可以是「连不上运行时」。连上后是空名册的会话优先三栏。设置弹窗是向导空态：未完成时工作区文件夹、至少一个端点的 URL 和密钥齐了即完成（`wizard_complete` 看工作区 + 任一端点已配密钥）；工作区路径只展示、不能手填，点「选择文件夹」打开系统对话框（浏览器开发态打不开）；点「保存」成功后关闭弹窗；可以向导里配第一个端点，之后在设置「模型服务」里再加：默认是端点卡片列表，点卡片主体或「添加端点」另开浮层编辑，卡片上可删除（确认弹窗）。每个端点有自己的模型名单和默认模型；名单上的名字可填价格、支持的思考等级和擅长领域（价格只给应用挑模型，花费仍只记端点 `usage`）。端点编辑浮层里填好 URL 和密钥停手约 0.7 秒就自动打 `POST /v1/models/probe` 拉一次 `/models`，同一对 URL + 密钥不重复拉，也可手动「重新获取」；拉到的完整名单随端点存成 `available_models`（`POST/PATCH /v1/providers` 同名字段，`GET` 一并返回），再进编辑时直接展示，不用再拉；存过的端点若名单为空（旧数据）则打开时自动拉一次。探测响应还带 `catalog`：`/models` 对象若写了 `reasoning_efforts` / `thinking_levels` / `reasoning.supported_efforts` 等，就把那些档名自动写进该模型的思考等级（Grok 的 `xhigh`、Gemini 的 `max` 这类），设置里仍可手改或加自定义档；对象没写则仍是 none / low / medium / high。名单以勾选列表呈现（超过 6 条出现搜索框、「全部 / 已启用」切换和全选 / 清空），勾上即启用；名单上没有的名字用底部「手动添加模型名」补进去；什么都没勾且拉到的名单不超过 3 条时整单直接启用，更长的名单等你挑。已启用的行右侧有属性折叠：价格是数字框，思考等级和擅长领域都是点选芯片（擅长可加自定义标签），不再有多行文本框。默认模型从已启用的名字里选。用户发消息开一轮时，应用只在 Bot 钉的端点（没钉端点就是默认端点）的名单里选模型和思考等级，新加的端点不会自动进别的 Bot 的候选；Bot 钉了仍在名单上的名字则模型名受约束，钉的名字只在别的端点上时照钉的用。思考等级（`thinking_level`，即补全的 `reasoning_effort`，档名以该模型名单为准）和模型一起钉：不钉模型时模型和等级都由应用每条消息挑，传了 `thinking_level` 是 `422 thinking_level needs a pinned model`；钉了模型必须有等级，没给就落到该模型的默认档，换成不支持原档的模型也落到新模型的默认档，清掉模型一并清掉等级。Bot 面板里模型选「自动」时不显示思考等级，选了具体模型才出现，且只列该模型支持的档。空钉不是永远用端点默认模型，要用别的端点必须显式钉端点。选模型由 agent 做：开轮前一次短调用（`prompts/routing.ts` 的 `ROUTE_PICK_SYSTEM`，无工具、结构化返回 model / thinking_level / reason / continues_previous），看这条消息、Bot 人设、候选名单和该 Bot 最近的复盘结论；它固定打到默认端点的默认模型以免递归，`route-agent.ts` 校验模型必须在候选里、档位必须该模型支持，不合法或超时就落回 `route-decision.ts` 的规则兜底，不重试。Bot 钉死了模型和思考等级时跳过这一跳。用户后续的每一句都原样记到它答复的那一轮上（引用回复落在被引那一轮，`@` 了唯一一个 Bot 落在它最近那一轮，否则落在会话里最近可见的一轮），不按关键词筛；围绕同一件事的若干轮共用一个 `chain_id`，由选路调用的 `continues_previous` 判定，静默 3 分钟兜底；定时器只在内存里，守护进程启动时 `sweepStaleChains()` 会补扫已经安静、仍未复盘的链（`created_at` 在 24 小时内，一次最多 20 条）。链结束时发一次复盘调用（`ROUTE_REVIEW_SYSTEM`），看触发消息、选了什么、Bot 的回复、全部跟进和终态，答出 fault（model / task / prompt / none）、direction、rounds、confidence 和一句理由，写进 `route_reviews`；只有 fault 为 model 且 confidence 够高的结论会被下次选路读到。每轮的选择在结束时记下终态；`GET /v1/sessions/:id/routes` 按时间列出该会话每轮选了什么、怎么结束、收到哪些反馈，并在 `reviews` 里带上每条纠正链的复盘结论；会话顶栏的「模型选择记录」按钮从右侧滑出独立浮层（`RouteLog.svelte`，宽 560px，自己滚动，Escape 或点遮罩关闭，不进当前对话设置），倒序画这份记录（Bot、模型 + 思考等级、消息类别、用时、结束方式与失败原因、选路理由、复盘结论、可展开的模型反馈；配了多个端点时标出端点），点一行跳回触发消息并高亮；打开时拉一次、开着时该会话轮次状态每变一次再拉一次（没有推送事件）。列表是窗口化的：`route-log-window.ts` 按 scrollTop、可视高度和已测行高算出该画哪一段（上下各多留 6 行），窗口外用 `<ul>` 的上下 padding 顶住，行高由 `ResizeObserver` 测到后回填（未测过的按 80px 估），所以 383 轮只有 20 行左右在 DOM 里。补全和判断打到该模型所属端点，不再发字面 `default`。路径须已有绝对目录，URL 须 `http(s)`；`422` 画在字段下或滑出顶，不会变成「连不上运行时」。左侧会话列表与聊天内容之间可拖条改宽度（200–480px，记住上次宽度）。侧栏全局搜索覆盖会话、消息、文件和日程；消息命中带所属会话名，点击打开该会话并滚到命中消息（短暂高亮）。会话详情默认最近 50 条，更早的命中会继续向后翻页直到找到。打开你↔Bot 私聊可以发消息（可带文件，复制到工作区 `inbox/`；PNG / JPEG / GIF / WebP 会进这一轮补全，Bot 能看见图）。Bot 写出的工作区文件可用 `send_message` 的 `paths` 或正文里的 Markdown / 反引号路径挂在那条消息上（不复制）；点开可预览图 / 音视频 / PDF / 文本 / 单文件 HTML（正文里的工作区路径即使没挂成该条附件，也走 `GET /v1/workspace/file`；该接口不按 1MB 截断，预览视频与附件内容接口一样按文件字节返回），目录和未知类型用系统打开。同一条消息挂了多个路径时，气泡里收成一个入口，点开后预览栏左侧是引用路径嵌成的文件树（只含这条消息引用过的路径，不列未引用兄弟）；文本是 Monaco + Shiki 编辑器（行号、查找 / 替换、匹配括号·标签·标题折叠、换行、复制；Cmd+F 查找，Cmd+G / Shift+Cmd+G 下一个 / 上一个，Ctrl+G 跳行，Cmd+⌥F 替换，Escape 先关查找；Markdown / HTML 默认渲染，可切源码；点「源码」在源码未到之前不回落到渲染 iframe，切文件才退出源码；源码着色 `vitesse-light` / `vitesse-dark`，跟随应用 `data-theme`）。HTML 预览是 `blob:` iframe，`sandbox` 含 `allow-scripts` 不含 `allow-same-origin`：内联 CSS / JS 动效能播，脚本拿不到信使页面和本机 token；外链脚本仍受窗口 CSP 限制。窗口 CSP 允许 `style-src 'unsafe-inline'` 与 `script-src-attr 'unsafe-inline'`，内联 `<script>` 在打包态若 CSP 带了 nonce 会把同一 nonce 写进预览 HTML。区内 UTF-8 文本可 Cmd+S / 保存写回 `PUT /v1/workspace/file`。能落盘的文件也可以从预览用系统打开或在 Finder 显示。侧栏底部文件夹按钮（⌘O）从右侧打开独立工作区浮层（完整文件树 + 自己的预览/编辑器，不占用对话框旁那条产物预览），按需展开；本机接口 `GET /v1/workspace/tree`、`GET /v1/workspace/file`（区内文件字节，目录 422，缺失 404；读取不按 1MB 截断）、`PUT /v1/workspace/file`（覆盖已有区内 UTF-8，过大 `too_large`）。聊天围栏代码块仍用 Shiki 分词着色（每 token 一个 span，亮/暗两套 CSS 变量；覆盖常见语言，含 JSON），流式输出过程中也会跟上。预览不写回工作区。交接仍是 `@Bot` 加上这些路径，没有单独的产物表。主转录里名册上的 `@Name` / `@everyone` 渲染成带头像的 chip（与作曲栏点名芯片同一视觉），点 Bot chip 打开人设；围栏和行内代码里的 `@` 不转。消息悬停工具栏在复制旁有「回复」：点了在作曲栏挂上被引的那一条，发送带 `parent_id`，引用 Bot 时正文自动 `@对方`；回复留在主转录，气泡里显示引用条。Bot 用 `send_message` 的 `parent_id` 同一套。Bot 一开始思考就在触发消息下出现紧凑「回复中」行（头像 + 名字）；群里多人同时思考收成同一列。侧栏会话行展示当前会话的状态（思考中 / 回复中 / 待审批 / 待回复 / 空闲）；Bot 自己的全局工作状态展示在 Bot 自己的头像上（状态标记）；会话行有未读角标，打开即已读。工具循环的中间跳不画气泡，一直保持思考；`send_message` 一旦发出就结束本轮，不再开下一跳补全。只有本轮最终那条 `kind: bot` 才渲染。空补全或「本轮没有新工作」这类收尾不插 bot 消息，也不再叫醒别人。终态 `kind: bot` / 你的气泡 / `system` 按 markdown 渲染。流中途卡住时，已写出的正文或完整工具调用会收下并继续这一轮，不插失败 `system`；还没有可用输出时会自动再试。同一端点同时最多两条补全 / 判断流，群里多人并行时其余排队。真正失败（连不上、端点拒绝、没有可用模型等）才出现那条 `system`。守护进程死亡留下的中断行和其他 Bot 消息一样带头像与名字，「继续」贴在「中断」气泡后面（`POST /v1/turns/continue`）以该条为触发条新开一轮，不重试断掉的工具。提问卡在流里，回复带 `ask_id`；区外写 / 无约束壳停在主转录里的批准卡（允许一次 / Always allow / 拒绝），待批准角标在会话行；私聊 Stop 打眼前这轮；群聊没有 Stop，要停就发消息。协作工具、群判断（仅你的无点名群消息才判断；点名只开被点名的）、文件四件套和工作区壳已接通；区内读写直接干。Bot 可用 `update_profile` 改自己的名字、职责、边界、头像、钉的端点+模型和思考等级（`thinking_level`，null 清掉；生成风格或工作区 PNG / JPEG / GIF / WebP；区外读停待批准），改完不在转录里插人设条。Bot 也可用 `list_skills` / `read_skill` / `create_skill` / `update_skill` / `delete_skill` 维护自己的技能（具名工序：何时用 + 怎么干 + 可选的依赖 MCP 服务器名 `uses`）；启用目录进入每一跳 system，每条下标出「依赖 MCP」和本轮未连接的服务器；正文按需 `read_skill`，返回里 `stale_tool_names` 列出正文写了但本轮 tools 数组里没有的 `mcp_` 名字；改完不插转录条。你在人设抽屉里也能列表、编辑（含「依赖的 MCP」一栏）、停用和删除。Bot 也可用 `list_endpoints` / `add_endpoint` / `update_endpoint` / `delete_endpoint` 和 `list_mcp_servers` / `add_mcp_server` / `update_mcp_server` / `delete_mcp_server` 改名册级端点与 MCP：stdio 用 command / args，HTTP / Streamable HTTP 用 url（可附非鉴权 headers）。新建端点、改已有 URL、新增 MCP、改 command·args / url / headers 停在主转录批准卡（不能 Always allow）；新建 / 改 URL 的卡带密钥框，HTTP MCP 新增的卡带 Authorization 框且必须粘贴后才能允许一次，密钥只走 resolve、不进转录。默认端点不能改 URL / 密钥 / 删除。已有端点改名或整表替换模型名单、删非默认端点、MCP 改名 / 启用 / 停用 / 删除直接干。已配且启用的 MCP 服务器添加时会握手解析 `instructions` 和工具说明（设置里加和 Bot 批准后加同一条路）；每次补全都会把所有已启用且连接成功的服务器工具放进 `tools`（`mcp_<server>_<tool>`），服务器说明和你或 Bot 写的用法备注（`usage_note`，排在服务器说明前面，改它不等批准、改连接也不清）附在本轮 system 末尾，调用直接干；不按消息关键词、语言或 Bot 身份筛选。系统指令固定选用顺序：先看技能目录，命中就 `read_skill` 照做，正文点到的 MCP 工具按名调用；没有命中的技能才直接挑 MCP 工具。Bot 或设置中添加 / 修改 / 重新启用后，当前轮次下一跳、其他 Bot、后续私聊 / 群聊 / 日程均可调用，停用或删除后不可再调用。图片生成及视频提交 / 查询等能力来自 MCP 工具，不取决于补全模型能否直接输出媒体；「再来一张」这类后续请求也保留完整工具。设置里的名册级 MCP 服务（stdio 与 HTTP）使用紧凑列表，显示名称、传输、连接摘要和启用状态；列表独立滚动，搜索与添加入口保持可见，可按名称、传输或连接地址筛选，长名称与地址省略显示。点服务或添加入口打开独立编辑弹窗，取消不保存；新增 / 改连接必须确认才发 POST/PATCH，没有 Always allow，不走转录批准卡；删 / 停用直接干。弹窗里的「用法备注」多行框只改备注时不用确认。名册行「+」和「群」组头「+」打开居中弹窗，分别 `POST /v1/bots` 与 `POST /v1/sessions`；建完选中新会话。新建群的成员用可搜索的多选下拉挑：每行是头像 + 名字 + 职责，按名字或职责过滤，选中的成为字段里的带头像芯片，✕ 或空输入时 Backspace 移出，Escape 只关列表不关弹窗。头像由 `MultiSelect` 的 `media` snippet 画，组件本身不认识 Bot。Bot 支持 `avatar`，默认用 boringavatars 算法生成 SVG（beam、marble、pixel、sunset、bauhaus、ring 风格，可随机换一个）；也可上传 PNG / JPEG / WebP，信使压成正方形 JPEG data URI 再落库。若创建时未显式指定头像，守护进程默认按 Bot 名称生成 SVG 头像；侧栏名册、左侧会话列表、顶栏、欢迎卡片、消息转录与提问卡均渲染对应头像。会话列表中，你↔Bot 显示该 Bot 的头像，Bot↔Bot 显示双方叠放头像，群显示群图标；无头像或图片加载失败时列表回退到名字首字，已删除 Bot 显示占位符，归档仍保留头像。顶栏只留一个当前对话设置：群是「群组设置」，私聊是「Bot 设置」。左侧会话列表（群组、你↔Bot、Bot↔Bot）以及顶部的已置顶项目均支持右键菜单：支持置顶/取消置顶、查看信息（打开对应的群组或 Bot 设置抽屉）、清除历史（二次确认后清空会话历史）、归档/取消归档（Bot 会话可用）以及删除（群聊确认后删除群，Bot 会话确认后删除 Bot）。你↔ 打开右侧抽屉，「Bot 基础信息」一张卡改名字 / 职责 / 边界 / 头像 / 模型 / 思考等级：所有改动自动保存（文本停手约 0.6 秒后 PATCH，模型 / 思考等级 / 头像点了就存；切换 Bot、返回群设置或关面板前先把未保存的发出去），卡片头显示「保存中… / 已自动保存」，没有保存和关闭按钮，只有右上角 ✕；思考等级是一排快捷档位（自动 + 所选模型支持的档），换成不支持的模型时自动退回「自动」。「会话操作」归档 / 恢复，「危险区域」清空历史（确认弹窗，点确认才清）和删除（确认弹窗，点确认才删），排版与群组设置同一套行；已归档从名册行消失、你↔行标「已归档」；删除后标题为「已删除」、作曲栏禁用。群组设置可改名、拉人、移出（只剩两个 Bot 时移出不可用），删除群聊走确认弹窗；点成员名进人设并可返回群组设置。Bot↔Bot 设置里点成员名同样打开人设。日历日程到点会在你↔该 Bot 私聊分叉叫醒（补跑只跑最近一次）。关窗隐藏到托盘且留 Dock；托盘左键叫回；退出后守护进程不在。黄金路径业务还没接。

信使不再展示 token / 花费统计：会话顶栏、侧栏底部及未选会话时的全局统计、会话设置中的统计卡均已移除。后台仍保留端点 `usage` 记录与 `/v1/spend` 接口。

## 聊天输入区

消息流与输入框共用同一条居中栏（`--chat-max-width: 800px`），宽屏两侧留白，行宽不再随主栏拉满。顶栏、侧栏、「回到底部」按钮和滚动条仍铺满主栏。输入框与上方自动提示选项区域采用半透明雾面玻璃底栏（`--glass-composer` + `backdrop-filter: blur(16px)`），对话内容向下滚动穿过底部时自然模糊消解，避免文字与选项交叠混淆，内部输入框采用实体底色保持高对比度与清晰轮廓。输入区采用上方文字、下方工具栏的布局：附件在左，右侧固定一个圆形操作按钮，快捷键提示位于输入框外。输入框上方是按当前转录建议的下一步草稿芯片（`GET /v1/sessions/:id/composer-suggestions`，短、无工具调用，失败则不显示）；点芯片把完整草稿填进输入框，需要叫醒谁时草稿里可以带 `@名字` 或 `@everyone`。输入框里打 `@` 仍弹出在场成员补全。你↔Bot 私聊空闲时显示发送箭头，有进行中的轮次（含待批准、待回复）时替换为停止方块；停止仍只针对眼前这一轮。群聊不论是否有进行中的轮都保持发送，不出现停止按钮；要停就发消息让 Bot 们停下来。私聊生成期间可以编辑下一条草稿、添加附件，但发送按钮和 Enter / ⌘+Enter / Ctrl+Enter 都不会提交；结束或停止后恢复发送，草稿保留。群聊有活轮或判断进行中时仍可发送。输入法选词窗口开着时 Enter 只确认候选，不发送；选词刚结束的那一下 Enter 也不发送。Shift+Enter 始终换行，多行内容不再误显示占位提示。消息提交中暂不允许重复发送；只读会话保持禁用。停止待批准的私聊轮次后，批准卡立即显示已作废，侧栏待批准状态同步清除。移动端隐藏快捷键提示，操作按钮使用 44px 点击区域。

## Bot 遇到障碍时

所有 Bot 的中英文轮次指令都要求先主动排查和尝试解决：检查实际错误、工具说明与已有文件，用低风险、可逆的方法推进；失败后根据证据调整参数或换用工具，完成后验证原始目标。技术问题不能仅以「遇到问题」收尾，不能让用户代做可自行完成的下载、查找、转换，也不能擅自用替代产物冒充完成。用户指出上轮问题或要求继续，仍是待处理的新工作。群里同一 Bot 同时最多一轮进行中：再被点名或判断下场时听进那一轮，不另开分身。群轮补全能看见谁有活轮、谁叫醒、用户最近一句；达成一致由 Bot 自己停嘴，没有跳数或花费熔断。

超过上下文限额的工具结果会先保存完整 JSON 到工作区 `tool-results/<唯一标识>.json`，再提供 `full_result_path`（工作区相对路径）和受限预览。文件以仅当前用户可读写的权限独占创建，保留原始内容，可能包含工具返回的敏感信息；用完可自行清理 `tool-results/`，清理后对应完整结果不可再读。Bot 可用现有 `shell` 解析文件、筛选日志或提取链接、把内嵌 base64 图片解码为文件，不必反复生成或要求用户手工保存。模型看到的单条工具结果仍限制为 8,000 个 Unicode 码点；保存失败会明确标记，不会假称已经保存，真实失败状态也不会因裁剪而变成成功。

主动排障不等于无限重试或绕过边界：有副作用且结果不明时先检查是否已成功，拒绝与 Stop 必须尊重。只有确实需要用户独有的权限、凭据、信息或决策时才求助，并说明实际尝试、剩余阻碍和最小必要操作；危险动作仍走批准卡，密钥不进聊天。`send_message` 成功会结束本轮，因此不能用它提前发送排障预告。

## 工具选择评估

Bot 选对技能 / MCP 工具几乎全靠目录里那几行说明，所以改了系统指令、技能目录或「本轮 MCP」段的措辞之后，用真实模型量一下：

```bash
REAL_BOT_EVAL_API_KEY=sk-… pnpm --filter @real-bot/daemon eval:tool-selection \
  --base-url https://api.example.com/v1 --model model-a --model model-b --repeat 3
```

用例在 `apps/daemon/eval/tool-selection-cases.json`：`servers` / `skills` 是可复用的库，每条 case 引用库里的键（`{ "use": "github", "usage_note": "…" }` 可覆盖单个字段），给一句触发消息和期望：`expect.first` 是允许的第一个工具调用（`reply` = 不调工具或先 `send_message` / `ask_user`；`read_skill:<技能名>`；或 `mcp_<server>_<tool>` 这类工具名），`expect.forbid` 是整轮都不许出现的调用（`*` 结尾按前缀匹配）。每条 case 发一次补全，system 与真实私聊轮次完全一致（人设 + 技能目录 + 系统指令 + 本轮 MCP），tools 数组是内建工具加按 `mcp_<server>_<tool>` 映射的假 MCP 工具；只看第一个调用是否命中，另记禁止调用和不在数组里的编造名。`--only id,id`、`--category`、`--locale` 筛用例，`--thinking` 选思考等级，`--min-pass 0.8` 让命中率不够时退出码为 1。结果按模型 × 类别 × 语言汇总打印，JSON 写到 `.scratch/tool-selection-eval/<时间戳>.json`（已忽略）。用例文件本身有单测把关：期望里写的技能名或工具名必须在那条 case 里真实存在。密钥只从环境变量读，不进仓库、不进结果文件。

## 本机接口

守护进程绑 `127.0.0.1:17890`，并在同一端口再听 `[::1]`（给 Vite 开发页的 IPv6 回环用）。前缀 `/v1`。`GET /v1/health` 不鉴权；其余 HTTP 用 `Authorization: Bearer`。WebSocket `ws://127.0.0.1:17890/v1/events`（或 `ws://[::1]:17890/v1/events`）连上后第一条消息 `{ "type": "auth", "token" }`。HTTP 还校验 Origin：缺省（curl / 测试）放行；`http://localhost`、`http://127.0.0.1`、`http://[::1]` 和 `tauri://localhost` 放行并回显 CORS（含 `Access-Control-Allow-Private-Network`）；其它 Origin 是 `403 forbidden_origin`。信使 Vite 常只听 `[::1]:5173`；浏览器开发态发现接口时按页面地址族拼 origin（`[::1]` 页连 `[::1]:17890`），避免 Chrome 把跨地址族回环请求当成本地网络访问拦掉。`POST /v1/turns/continue` 用中断系统消息的 `message_id` 给该 Bot 新开一轮。`GET /v1/sessions/:id/composer-suggestions` 按该会话最近转录返回用户下一步草稿（`{ items: [{ id, label, prompt }] }`）；打默认端点上名字带 flash / mini / lite / fast 的模型（没有就用默认模型），无工具，8 秒超时；失败或没配端点返回空列表。

每次守护进程启动新铸本机 token，写到 `~/Library/Application Support/real-bot/local-api.json`（目录 `0700`，文件 `0600`）。库文件同目录 `state.sqlite`。每个端点的 API key 在钥匙串 `com.real-bot.daemon` / `endpoint-api-key:<provider-id>`（旧的单端点项 `endpoint-api-key` 会迁到默认端点）。测试或隔离跑可设 `REAL_BOT_DATA_DIR` 换这个目录。

单独起信使时，Vite 开发服务器提供同源 `GET /__local-api` → `{ name, port, token }`（守护进程未起时是带 `name` 的 `not_found`），不把 token 写进仓库或 bundle。页面只用 `port` 和 `token`，origin 按当前页是 `127.0.0.1` 还是 `[::1]` 拼。

## CI、落地页与快照发布

仓库在 GitHub Actions 里跑与本地相同的验证，不代替本机 UI 或原生桌面检查。

| 工作流 | 触发 | 做什么 |
|---|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | `main` 推送、PR | `pnpm test`、`pnpm typecheck`、信使与落地页 build；macOS 上 `cargo test` |
| [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) | `main` 推送 | 构建 `apps/landing` 并部署 GitHub Pages |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | 推送 `v*` 标签，或手动 | 再跑验证后打 **未签名** 的 macOS `.dmg` / `.app`，发布为 GitHub **prerelease** |

落地页本地预览：`pnpm --filter @real-bot/landing dev`（5174）。Pages 构建会设 `BASE_PATH=/<仓库名>`，适配 `https://<owner>.github.io/<repo>/`。仓库链接集中在 `apps/landing/src/lib/site.ts`。

落地页首页是随滚动推进的完整流程演示：`apps/landing/src/lib/demo/scenes.ts` 用纯函数按（场景，节拍）算出信使窗口的状态，`SCENE_BEATS` 定义每个场景各节拍的毫秒偏移；`AppMock.svelte` 只负责把状态画成窗口，`Walkthrough.svelte` 用 IntersectionObserver 决定当前场景并把窗口按容器宽度缩放。中英文案（含各步标题、标注和演示台词）都在 `apps/landing/src/lib/i18n.ts`；改台词或加步骤时同时改两种语言。窗口内标注用 `data-hit` 属性定位界面元素，`Walkthrough.svelte` 里的 `CALLOUT_TARGETS` 指定每步指向哪个元素及偏好的一侧。窄屏（<1024px）下 `Walkthrough.svelte` 用同一批标注元素做「聚焦缩放」：`AppMock` 通过 `onFocus` 回传目标矩形，镜头推到以它为中心、至少 460 设计像素宽的区域；目标还没出现时用 `FOCUS_FALLBACK` 里每步的静态区域。向上滚动进入的步骤直接显示终态（`skipToEnd`）。文档站由 `apps/landing/src/lib/docs.ts` 把 CONTEXT.md 拆成主题页（`/manifesto` 总览 + `/manifesto/{topic}`），与路线图共用 `DocsShell.svelte`：左侧分组导航、右侧本页目录、页底上一页 / 下一页。术语分组写在 `TERM_GROUPS`；`docs.test.ts` 要求 CONTEXT.md 每个术语都有且仅有一组。HTML 由 `content.server.ts` 的 marked 渲染器生成：术语标题用 `term-` 前缀 id；`_Avoid_:` 行标成 `avoid`。旧的 `/manifesto#term-…` 在总览页会跳到对应主题页。

品牌与 SEO 资产在 `apps/landing/static/`：`favicon.svg` 是标识源文件（消息气泡 + 两个叠放头像），`icon.svg` 是无留白的应用图标源文件，`icon-512.png` / `icon-192.png` / `apple-touch-icon.png` / `favicon-48.png` 由它导出，`site.webmanifest` 引用这些 PNG。`og-zh.png` / `og-en.png` 是 1200×630 的 Open Graph 图。重新生成：起开发服务器后在浏览器里以 1200×630 视口打开 `/og/zh` 与 `/og/en` 截图（该路由 `prerender = false`，只在开发态渲染，不进静态构建）。同一路由还带两个变体：`/og/en?variant=social` 以 1280×640 截出仓库社交预览图 `docs/assets/social-preview.png`；`/og/en?variant=hero&theme=light|dark` 以 1600×900 截出 README 顶部的界面组合图 `docs/assets/readme-hero-light.png` / `readme-hero-dark.png`（三扇窗口：群聊、待批准卡、产物编辑器；README 用 `<picture>` 按 GitHub 外观切换）；图标则以 512×512 视口打开 `/icon.svg` 截图，再用 `sips -z` 缩到 192 / 180 / 48。每页的 `<title>`、描述、canonical、`hreflang`、Open Graph / Twitter 卡片和首页 JSON-LD 由 `src/lib/Seo.svelte` 输出；绝对 URL 的站点根在 `src/lib/site.ts` 的 `SITE_URL`，换域名时改这一处，`sitemap.xml` 与 `robots.txt`（`src/routes/*/+server.ts` 预渲染）会跟着变。`<html lang>` 由 `src/hooks.server.ts` 按路由语言写入。

下载入口统一指向 `src/lib/site.ts` 的 `LATEST_RELEASE_URL`（`…/releases/latest`）：有正式版后直达最新正式版；目前只有预发布时 GitHub 会跳到 Releases 列表，最新 Alpha 排在最上面。

GitHub 仓库侧的展示信息：描述、主页（落地页地址）和 topics 用 `gh repo edit Blackman99/real-bot --description … --homepage … --add-topic …` 维护；社交预览图没有 API，改动 `docs/assets/social-preview.png` 后要在仓库 Settings → General → Social preview 手动上传同一张图（GitHub 建议 1280×640）。

主题：页面令牌在 `src/app.css` 的 `:root` 上定义亮色，暗色分别写在 `@media (prefers-color-scheme: dark)` 的 `:root:not([data-theme="light"])` 与 `:root[data-theme="dark"]` 两处，同一块里也定义演示窗口用的 `--app-*` 令牌（取自信使 `styles.css` 的亮 / 暗调色板）。默认跟随系统；导航栏的 `ThemeToggle.svelte` 通过 `src/lib/theme.svelte.ts` 写 `data-theme` 与 `localStorage` 的 `real-bot-theme`（选「跟随系统」即删除两者），`app.html` 里的内联脚本在首屏绘制前读同一个键。演示窗口 `AppMock.svelte` 只引用 `--app-*`，不写死颜色。

桌面 App 图标的源文件是 `apps/desktop/src-tauri/icons/app-icon.svg`（1024 画布、macOS 式圆角方块留透明边距）。改动后在 `apps/desktop` 下执行 `pnpm exec tauri icon src-tauri/icons/app-icon.svg --output src-tauri/icons` 重新生成 `tauri.conf.json` 引用的 `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.icns` / `icon.ico` 以及 Windows 商店尺寸；托盘图标取自窗口默认图标，无需单独维护。SVG 注释里不能出现 `--`，否则 CLI 的 SVG 解析会失败。信使窗口的 favicon 在 `apps/messenger/src/lib/assets/favicon.svg`，与落地页 `static/favicon.svg` 是同一份标识。

当前没有稳定版或受支持的签名安装包。快照使用 ad-hoc 签名（`signingIdentity: "-"`）。Gatekeeper 可能拦截；优先 `pnpm install` 后 `pnpm dev`。打标签前把 `apps/desktop/src-tauri/tauri.conf.json` 与 `Cargo.toml` 的版本改成与标签一致（去掉 `v` 前缀），否则 `tauri-action` 会按配置里的版本建 release。例如标签 `v0.1.0-alpha.1` 对应配置版本 `0.1.0-alpha.1`。Windows / Linux 不在发布范围。Apple Developer 证书与公证需要以后另配仓库 secrets，不写进工作流。

自动检查更新走「检查 + 浏览器下载」，不做应用内安装（见 [ADR 0015](adr/0015-update-check-via-github-releases.md)）。窗口进程启动 15 秒后发起首次检查，之后每 6 小时重复一次；设置里的「检查更新」按钮随时可强制刷新。网络请求只在 `apps/desktop/src-tauri/src/updates.rs`（Rust 侧）发出——webview 的 CSP 把 `connect-src` 钉在回环地址，前端本身拿不到 GitHub 的公网访问。结果在 Rust 进程内缓存 30 分钟，非强制检查命中缓存不重复请求。请求的是 `GET /repos/Blackman99/real-bot/releases?per_page=10` 而不是 `/releases/latest`：仓库目前每个 release 都是 prerelease，`/releases/latest` 会 404。拿到列表后跳过 draft 与无法解析的 tag，按 semver 取最高版本；比较基准是 `tauri.conf.json` 的 `version`（经 `app.package_info()` 读出），当前版本带预发布标识时所有 release 都参与比较，否则只看正式 release。下载按钮按机器架构在 release 资产里找 `Real.Bot_<ver>_aarch64.dmg` / `Real.Bot_<ver>_x64.dmg`，这依赖 `tauri-action` 产出的命名规则；资产改名不会报错，只会让按钮退化成打开发布页。打开外链统一经新命令 `open_external_url`，只放行 `https://github.com/Blackman99/real-bot/` 前缀，防止把系统浏览器带去任意地址。本地验证可设 `REAL_BOT_UPDATE_FEED=<url>` 让窗口进程改从该地址取 releases JSON：起一个 `python3 -m http.server` 在本地端口提供伪造的 `releases.json`，但里面的 `html_url` / `browser_download_url` 仍必须是真实的 `https://github.com/Blackman99/real-bot/...` 链接，否则会被打开外链的白名单拒绝。「忽略此版本」只记在信使 webview 的 `localStorage`（键 `real-bot-ignored-update`），不进守护进程的 `Settings` 契约——这是纯界面偏好，浏览器开发态也压根没有可更新的桌面壳。之所以不用 `tauri-plugin-updater`：当前构建是 ad-hoc 签名（`signingIdentity: "-"`），没有 minisign 密钥，`release.yml` 也没开 `uploadUpdaterJson`，未签名期间做不出可信的应用内安装；等有了签名构建和密钥，可以只替换下载这一步接入该插件，「关于」卡片不用改。
