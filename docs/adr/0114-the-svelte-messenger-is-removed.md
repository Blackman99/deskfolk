# 移除 Svelte 信使 / The Svelte messenger is removed

Status: implemented 2026-11-18. Follows [ADR 0107](0107-spike-native-desktop-on-nsh.md) (the native app on NSH; addendum 43, the relay serves the NSH page to phones) and [ADR 0113](0113-the-tauri-shell-is-removed.md) (the Tauri shell removed).

2026-11-18 手机页面换成 NSH 版之后，你问「所有旧的 svelte 残留是否可以清掉了」，然后说「按照你说的步骤做一下」。桌面应用从 0.5.0 起是原生的，手机页面也是原生应用的 web 包，Svelte 信使（`apps/messenger`）已经没有东西再构建或发布；它剩下的作用只是原生应用借它 `src/lib` 里的逻辑（`app/src/m` 里一行一个的转发，加上手改的 store 移植）。这份记录删它时的决定。

On 2026-11-18, after the phone's page became the NSH build, you asked whether everything left of Svelte could go, then to do it in the steps proposed. The desktop app has been native since 0.5.0 and the phone's page is the native app's web package, so nothing built or shipped the Svelte messenger (`apps/messenger`) any more; the native app only still borrowed the logic in its `src/lib`. This records how it was removed.

## 决定 / Decisions

1. **界面和它的工具链整个删掉。** 284 个 Svelte 组件、路由和页面外壳、除设计令牌以外的样式、SvelteKit / Vite / UnoCSS / Playwright 的配置和视觉基线、组件测试，以及镜像本来就没带过去的浏览器专用模块（Monaco、pdf.js、noVNC、xterm 那几样）。CI 和发布演练不再构建托管页，`phone-web-e2e` 去掉 `--from-svelte`。
   **The screens and their toolchain go whole**: the components, routes and page shell, every stylesheet but the design tokens, the SvelteKit, Vite, UnoCSS and Playwright set-up with the visual baselines, the component tests, and the browser-only modules the mirror never carried. CI and the release dry run stop building the hosted page; `phone-web-e2e` drops `--from-svelte`.

2. **逻辑只留原生应用用得到的。** 从原生应用的入口、它的脚本和守护进程的测试沿 import 走一遍，走不到的模块连同测试删掉（菜单的点外关闭、方向键、FLIP、页面滑入、作曲栏的 contenteditable、xterm 主题、托管构建的本机接口桩……）。一个模块里只有一部分是 Svelte 页面的，留下原生应用读的那部分：命令输出只留 `outputLang`，表格只留网格的形状和列名（表格由原生的 calamine 读），代码配色只留主题名，Markdown 的选项类型从 DOMPurify 渲染器里分出来，日程块用自己的类型而不是 Svelte 日历组件的。
   **Only the logic the native app reaches stays.** Walking the imports from the app's entries, its scripts and the daemon's tests, modules nothing reaches go with their tests. Where only part of a module was the Svelte page's, the part the app reads stays.

3. **逻辑就放在 `app/src/m`，不再是镜像。** 转发的模块搬到它那一行转发所在的路径上，store 的移植就是要留的代码，原件删掉；`scripts/port-messenger.ts` 和 `app/mirror.test.ts` 跟着删。逻辑改了，开发版窗口跟着重编，不用再手动 `nsh build`。`*.svelte.ts` 这个名字先不改：改名要动一百多个别的会话也在改的文件，其中三个还和同名的普通模块撞名。
   **The logic lives in `app/src/m`, no longer a mirror.** Each re-exported module takes its shim's path; the ports are the code that stays and the originals go; the mirror script and its load test go. The `*.svelte.ts` names stay for now: renaming touches over a hundred files other sessions edit, and three would clash with a module of the same name.

4. **测试分两条道。** 驱动 store 的测试（66 个文件）挪到移植旁边，用 `nsh test` 在应用自己的引擎里跑：先装应用的全局对象，`bun:test` 换成 `nsh/test`，`nsh/test` 没有的断言手写，深层响应式的值经 `snapshot()` 比较，按日历日算的用本地时钟造时间。驱动 Svelte 页面 DOM 的用例（界面方案的样式表和底线检查、指针拖动、DOM 节点的尺寸监听）删掉。其余 149 个文件改名 `*.spec.ts` 留在被测模块旁边，照旧用 `bun test` 加 happy-dom 跑（`scripts/spec-setup.ts`）：它们测的多半是手机浏览器里跑的东西。两条道都不做类型检查，和在信使里时一样。
   **Tests run in two lanes.** The store tests move next to the ports and run under `nsh test` in the app's own engine; cases that drove the Svelte page's DOM are dropped. The rest become `*.spec.ts` beside their modules and run under `bun test` with happy-dom, as before; most cover what runs in the phone's browser. Neither lane is type-checked, as in the messenger.

5. **借的文件搬进原生应用。** 设计令牌到 `assets/tokens.css`，手机页面的 service worker、manifest 和图标到 `assets/phone/`，任务地图的人物脚本到 `scripts/map-figures/`。`@real-bot/remote` 和协议包一样经别名解析；应用的类型检查自己写上 DOM 库（以前是 xterm 的类型声明顺带引进来的）。
   **What the native app borrowed moves into it**: tokens, the phone page's worker, manifest and icons, the map figure scripts. `@real-bot/remote` resolves through an alias like the protocol, and the app's type check names the DOM lib itself, which xterm's typings used to bring in.

6. **原来的代码查得到。** 删掉前的整份信使在 tag `v0.5.1`；搬过来的文件的早先历史用 `git log -- apps/messenger/src/lib/<路径>` 看（转发文件的路径被原文件占了，git 认成修改，不认成改名）。
   **The old code stays findable** at tag `v0.5.1`, and a moved file's earlier history under its old path.

## 代价 / Costs

- 回滚到 Svelte 页面不能再从主分支构建。中继机上 11-12 的那份构建还在，`rollback-svelte.sh` 照旧能切回去；要改它得从 `v0.5.1` 起。
  Rolling the relay back to the Svelte page can no longer be built from main; the 11-12 build on the relay box and `v0.5.1` remain.
- 落地页的影片脚本（`apps/landing/scripts/film/*`、各版本的录制脚本）开的是 Svelte 信使，现在跑不起来；新影片要从原生应用录。
  The landing site's film scripts drove the Svelte messenger and no longer run.
- 搬过来的测试和测试工具不做类型检查，其中一些手写的假数据已经落后于协议后来加的字段。
  The moved tests are not type-checked, and some of their hand-built fixtures predate fields the protocol added since.
- `MessengerRuntime`、`messenger-api.ts`、`*.svelte.ts` 这些名字和代码注释里「照 `X.svelte` 做」的出处还留着。
  Names such as `MessengerRuntime`, `messenger-api.ts` and `*.svelte.ts`, and provenance comments naming Svelte files, remain.
- 主 checkout 里删掉的 `apps/messenger` 下还有没被跟踪的依赖和 `.svelte-kit`，合入后另外清掉。
  The main checkout keeps the deleted tree's untracked dependencies until they are cleaned up by hand.
