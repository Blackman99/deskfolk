# 自己验证界面改动

给在这个仓库里改界面的 agent（Claude Code、Codex、Antigravity、Grok）和贡献者。改完要先自己验证，再说做完了。验证时不能借用户的屏幕、窗口、运行时和数据。宿主的检查参数和 `request` 文件能写哪些命令，见 [`apps/desktop-nsh/README.md`](../../apps/desktop-nsh/README.md) 里「开发版宿主的检查用参数」那一段；起开发版的方法见 [`docs/development.md`](../development.md)。这份文档只讲两件事：这些工具怎么组合着用，哪些坑踩过。

## 先分清在哪跑

- 用户日常用的，可能就是这个 checkout 跑起来的版本（`dev.ts --stable-instance`，17890 端口，真数据）。`apps/desktop-nsh/app` 下的文件一保存，就会热加载进他的窗口。所以半成品、调试输出和临时 story 都放到 git worktree 里做，验证完再合进来。
- 不往屏幕上注入键鼠事件（cliclick 之类），也不在用户的窗口里点：窗口可能被别的窗口盖着，一下 Esc 会落到别的程序上。宿主的 `drag`、`keys`、`chord` 只发给它自己的窗口，可以用。
- 不用用户的运行时和数据库做验证。要真实的数据规模，就用 `sqlite3 "file:<库>?mode=ro" ".backup <副本>"` 拷一份，在副本上起运行时，用完连日志一起删掉（里面有对话内容）。
- 你自己可能就是 17890 上的一个项目会话。重启它会把你自己也停掉。改了 daemon、需要重启时，先确认没有活轮，再交给用户或者等空闲时的脚本。
- 要花模型额度的真机核对（真起一个 Agent、真去调模型），先问用户。

## 准备 worktree

- 用 `git worktree add` 开 worktree。从这个 checkout `cp -cR` 两样过去：`apps/desktop-nsh/app/.nsh` 和 `apps/desktop-nsh/app/target`。APFS 上是克隆，不占空间，也不用重编。根目录的 `node_modules` 用软链，各个包的 `node_modules` 用 `rsync -a` 拷过去。
- 不要在 worktree 里跑 `pnpm`：`node_modules` 指回主 checkout，曾经把那边的依赖清掉过。类型检查、测试、脚本都直接跑：各包的 `tsc`、`bun test`、`bun <脚本>`。
- `nsh` 命令行用 `bun apps/desktop-nsh/scripts/nsh-cli.ts --check` 给出的那个，它和 `Cargo.toml` 钉的 NSH 提交是同一个。宿主二进制可以直接用主 checkout 编好的 `apps/desktop-nsh/target/debug/deskfolk-nsh`，前提是两边 NSH 提交相同。

## 四种验证，按需挑

1. **逻辑**：`*.spec.ts` 用 `bun test` 跑（命令见 `apps/desktop-nsh/README.md`）。
2. **无头界面**：跑 `bun apps/desktop-nsh/scripts/ui-tests.ts <名字过滤>`，它会起一个隔离的运行时。注意几点：
   - 同一个 checkout 同时只能跑一个，因为大家共用 `app/.ui/.fixture.json`，重叠的那次结果作废。
   - 全量跑超过 30 分钟，要按名字分批。
   - 测试体里没有网络。
   - 动画进行中，`viewStyle` 返回的是终值。
   - 不能截图。
3. **真窗口的像素，不占屏幕**：
   - **临时 story**：写 `stories/zz-*.tsx`，在 `stories/index.ts` 登记。各个变体（半径、明暗、有无、各个分支）并排放在同一屏，一次看完。明暗用 `setColorScheme("light" | "dark")` 定：story 不走外壳的主题设置，改运行时的设置没有用。
   - **编译**：在 `apps/desktop-nsh/app` 里跑 `nsh build Story.tsx --out <目录>`。
   - **运行时**：宿主没有运行时就不肯起。写一个临时脚本，照 `scripts/ui-tests.ts` 开头那样调 `startRuntime({ dataDir: <临时目录>, bind: "127.0.0.1:0", endpointKey: memoryKeyStore(), schedule: false, supervisor: "none" })`，它会在数据目录里写好 `local-api.json`。环境里去掉 `CLAUDECODE`、`CLAUDE_CONFIG_DIR`、`REAL_BOT_DEV_REMOTE`。
   - **启动宿主**：跑 `deskfolk-nsh --bundle <目录>/bundle.js --data-dir <临时目录> --background --snapshots <截图目录> --story <名字>`。等约 5 秒，往 `<截图目录>/request` 写 `resize <宽> <高> 1 0`，再写一个空行，就会得到 2 倍分辨率的 `window-1.png`。
   - **`--snapshots` 拍不到的东西**：它是在进程里渲染的，backdrop 模糊、窗口毛玻璃这些由窗口服务器合成的效果都拍不出来。要看这些，改用窗口服务器截图：用宿主的 pid 在 `CGWindowListCopyWindowInfo`（JXA 或 Swift）里找 `kCGWindowIsOnscreen` 为真、宽度够的那个窗口号，然后 `screencapture -x -o -l <窗口号>`。涉及透出桌面的材质，再加一张 `screencapture -x -R x,y,w,h`。不在屏幕上的窗口截出来是空的，所以一次只开一个宿主。
   - **对照**：同一个 story 编两次，只改动一行（编完把文件还原），分别截图比较。
   - **动画**：循环截帧，大约每 150 ms 一张，然后用像素统计判断每一帧处在什么状态，比如区域均值看明暗，拉普拉斯方差看清晰度。这比肉眼看几张图可靠。
4. **手机网页**：
   - **打包**：跑 `nsh package Story.tsx --target web --out <目录>`（整个应用就用 `App.tsx`）。
   - **自起服务**：自己起静态服务时，`.css` 要按 `text/css` 返回，否则页面的样式表不生效，`#app` 高度为 0，截图全白。
   - **打开某一屏**：在 `index.html` 的 `#nsh-app` 脚本后面插一行 `<script type="application/json" id="nsh-params">{"story":"<名字>"}</script>`。
   - **Playwright**：用 `apps/desktop-nsh/node_modules` 里的 `@playwright/test`，设备用 `devices["Pixel 7"]`（用户的手机是安卓 Chrome，先在 Chromium 上量）。读 `getComputedStyle`，比看截图更确定。
   - **帧率的局限**：无头 Chromium 的帧率看不到 GPU 开销（比如 `backdrop-filter`），所以说明不了真机流畅不流畅。
   - **发布前**：要在部署的那个提交上跑通 `bun apps/desktop-nsh/scripts/phone-web-e2e.ts --browser chromium`。

## 看图

- 截图先用 `sips -Z 1300` 缩小。几张要对比的图拼成一张，一次看完。看完马上用文字记下看到了什么，后面引用这段文字，不要反复读图。
- 能用结构化读数回答的问题，就不用截图：计算样式、DOM 查询、数据库、日志、接口返回都算。截图上看到的状态，要和数据库或接口对一下。

## 结论以文件和进程为准

- 后台任务和监视器的通知可能出错。见过两种：通知里报失败的那一行，日志里根本没有；进程还在跑，通知已经报结束。下结论之前，先 `kill -0 <pid>` 看进程还在不在，再直接 grep 日志文件。
- 日志每次用新名字，或者用 `>>` 追加。两个进程都用 `>` 写同一个文件，会互相截断。
- 拿不准的地方照实说：哪些没测（WebKit、真机、Windows），哪些只在一种主题、一个半径下测过。

## 收尾

- 自己起的宿主、运行时、静态服务都停掉。按 pid 停，不按名字。
- 删掉 `stories/zz-*` 和 `scripts/zz-*`，还原 `stories/index.ts`。临时目录也删掉：副本库和日志里有对话内容。
- 合并之后，删掉 worktree 和分支。

## 踩过的坑

- zsh 里 `$HOST` 是主机名，不要拿它当变量名。
- `FORCE_COLOR=`（留空）照样会输出颜色，有的 daemon 测试会因此失败。要用 `env -u FORCE_COLOR`。
- `app/.nsh/rust/hack` 过期时，`nsh check`、`nsh build`、`nsh package` 都会失败。每个 checkout 各删一次。
- 别的会话可能同时在改这个仓库。不要 `git stash`；只暂存自己改的文件；`--amend` 之前先确认 HEAD 是自己的提交；fast-forward 之前确认对方未提交的文件和你的不重叠。
- Antigravity 作为 Deskfolk 的项目会话运行时，碰到别的 Agent 的登录或设置文件、钥匙串里 Agent 和应用的条目，命令会被应用停下。上面这些验证都用不到它们。
