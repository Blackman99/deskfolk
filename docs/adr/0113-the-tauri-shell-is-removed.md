# 移除 Tauri 外壳 / The Tauri shell is removed

Status: implemented 2026-11-18. Follows [ADR 0107](0107-spike-native-desktop-on-nsh.md) (the native app on NSH, shipped since 0.5.0) and [ADR 0112](0112-native-app-catches-up-with-tauri.md) (everything only the Tauri app had, brought over first).

2026-11-17 你说「要彻底的移除 Tauri 的相关的所有东西了」。0.5.0 起发布的已经是原生应用，日常用的也是它；Tauri 外壳（`apps/desktop`）只剩下 CI 每次还在编、原生应用还在借它的几样东西。ADR 0112 先把只有它有的功能补到原生应用里，这份记录删它时的决定。

On 2026-11-17 you asked for everything Tauri to go. The released app has been the native one since 0.5.0; the Tauri shell (`apps/desktop`) was only still built by CI and still lent the native app a few files. ADR 0112 first brought over everything only it had; this records how it was removed.

## 决定 / Decisions

1. **原生应用借的东西搬进它自己那里，原样搬。** 版本号的唯一来源是 `apps/desktop-nsh/package.json`；`build-native`、`native-package`、`release-notes`、`runtime-qualification` 和图标脚本搬到 `apps/desktop-nsh/scripts`；图标、托盘标记、各 agent 的标志、两份 entitlements 逐字节搬到 `apps/desktop-nsh/assets`。`build-native` 改由 `--target` 收目标三元组，产物写到 `apps/desktop-nsh/build/native`，原生助手按应用自己的 macOS 14 编。
   **What the native app borrowed moves into it, unchanged.** One version source in its `package.json`; the build, packaging-check and release-notes scripts in its `scripts`; the icons, marks and entitlements byte for byte in its `assets`; the native helpers built for macOS 14 into its own `build/native`.

2. **删掉 `apps/desktop` 和它的一切。** Tauri CLI 依赖、`build-sidecar`、`linux.yml`、Windows 的 Tauri 安装包任务、CI 里测 Tauri crate 的步骤、dependabot 的那条。CI 改测原生应用：`ci.yml` 的 macOS 任务跑原生外壳的 Rust 测试、`nsh check` 和 `nsh test`，所以 PR 阶段仍有 macOS 上的外壳测试；Linux 和 Windows 上的原生应用由 `nsh-desktop.yml` 编译和冒烟。
   **`apps/desktop` and everything for it go**, and CI checks the native app instead: its Rust tests, type check and headless tests on macOS in `ci.yml`, Linux and Windows in `nsh-desktop.yml`.

3. **从源码跑：`pnpm dev` 起原生开发版。** 它在自己的实例上（17990、自己的数据目录），和装好的版本并存；`--stable-instance` 让它顶替装好的版本。`pnpm dev:steady` 去掉：开发运行时本来就不跟着改动重启。信使不再是桌面窗口，只是手机的页面（`build:hosted`）和浏览器里的开发服务。
   **From source, `pnpm dev` starts the native development build** on its own instance; `dev:steady` goes; the messenger is the phone's page and a browser dev server only.

4. **为 0.4.0 用户留着的兼容不删。** Windows 安装器认 Tauri 写的卸载项、`MainBinaryName` 和装在别处的目录；Mac 的 dmg 名字、bundle id、`Contents/Resources/native` 的布局，让 0.4.0 的应用内更新能装新版；Linux 的 deb 包名、`/usr/bin/real-bot-desktop` 和自启项文件名；发布流程下载 v0.4.0 安装包做升级冒烟。这些地方的注释照实提 Tauri。
   **What 0.4.0 users need to upgrade stays**: the Windows installer's handling of the Tauri app's uninstall entry and folder, the dmg names, bundle id and `Resources/native` layout its updater checks, the deb's package name, paths and autostart entry, and the upgrade smoke from the v0.4.0 installers.

5. **原来的代码查得到。** 原生外壳里「从 Tauri 外壳移植」的注释指向 tag：`git show v0.5.1:apps/desktop/src-tauri/src/<文件>`。ADR 和更新日志里的历史不改，在描述 Tauri 现行做法的 ADR 开头注明被这份取代。
   **The old code stays findable** through tag v0.5.1, which the native shell's provenance comments name; ADRs and changelogs keep their history, with a note at the head of the ADRs that described the Tauri app as current.

6. **信使和原生应用之间那套 Tauri 名字的约定，单独一步改名。** 原生应用一直用 `__TAURI_INTERNALS__.invoke` 和 `tauri.<命令>` 这套名字跟外壳说话，好让信使的逻辑原样复用；改名要宿主、应用、信使、镜像和测试同一步一起换。
   **The bridge that still speaks Tauri's names** (`__TAURI_INTERNALS__.invoke`, `tauri.<command>`) is renamed in a step of its own, host, app, messenger, mirror and tests together.

## 代价 / Costs

- 主 checkout 里删掉的 `apps/desktop` 下还有没被跟踪的编译产物和依赖，合入后要另外清掉。The main checkout keeps the deleted tree's untracked build output and dependencies until they are cleaned up by hand.
- 0.4.0 以前的发布记录、影片脚本和 brief 里写的 Tauri 路径成了历史，不再能直接打开。Paths in the release briefs and film scripts of earlier releases are history now.
