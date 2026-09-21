# 应用内下载更新并就地替换，浏览器下载降级保留

[ADR 0015](0015-update-check-via-github-releases.md) 把「装」留给了用户：检查到新版就把 `.dmg` 丢给系统浏览器，下载、打开、拖进 `/Applications`、再过一次 Gatekeeper。那一步在未签名期间是对的，但它每次都要用户走完五个动作，而真正缺的东西——minisign 密钥和 `uploadUpdaterJson`——到现在也还没有。这条决策不是去等密钥，而是把「下载 + 替换」自己做掉：应用内下载带进度条，下载完校验包里的 app，替换当前这份 `.app`，然后自动重启。浏览器下载仍在，只是降级成按钮之一。

仍然不用 `tauri-plugin-updater`：它要的是 `latest.json` 加 minisign 签名，没有密钥就只能关掉验签用它，那是拿一个「看起来有验签」的通道换一个实际没有的保证。自己这一条路把信任锚点写明白：下载 URL 必须是 `https://github.com/Blackman99/real-bot/releases/download/` 前缀下的 `.dmg`（不含空白、控制字符和 `..`），走 TLS 到 github.com；挂载后读包里的 `Info.plist`（`plutil -convert json`，二进制或 XML 都能读），`CFBundleIdentifier` 必须是本应用的 identifier，`CFBundleShortVersionString` 必须正好是这次检查给出的那个版本号——资产被改名、指到别的版本、或者 release 里塞了别的 app，都停在这一步，不会走到替换。这套保证和用户自己点那个链接下载完全等价，少的只是 Finder 那几下。附带一个后果要写明：`ureq` 下载不会打 `com.apple.quarantine`，所以替换进去的那份不再被 Gatekeeper 拦——这正是白名单必须严格的原因，它是唯一决定「谁的字节能进 `/Applications`」的东西。

替换不能在自己还跑着的时候原地做。落地的形状是一段分离出去的 `sh` 脚本：路径全部以参数传入（`$1`…`$4`，不做字符串插值，`/Applications/Real Bot.app` 里的空格因此不需要转义），先轮询 `kill -0` 等窗口进程退出（最多 60 秒），把旧的 `.app` `mv` 到 staging 里当备份，再 `ditto` 新的过去；`ditto` 失败就把备份 `mv` 回来——所以一次失败的更新留下的是原来那份能跑的应用，而不是一个删了一半的目录。成功后 `xattr -dr com.apple.quarantine`、`open` 回来、删 staging、脚本自删。脚本放在 staging 之外，因为它要删 staging。窗口这边不是直接 `exit`，而是走平时那条退出路径（`begin_quit`）：守护进程收到 `/v1/runtime/quit`、窗口大小照常落盘，然后脚本等到的才是一个干净退出的进程。

下载和替换整段在窗口进程（Rust）里，信使只负责开始、轮询、取消。理由和 ADR 0015 一样：webview 的 CSP 把 `connect-src` 钉在回环地址，不给它公网权限。进度用 300ms 轮询 `update_install_state` 而不是 Tauri 事件——信使没有装 `@tauri-apps/api`，只用 `__TAURI_INTERNALS__.invoke`，为一个进度条引入事件订阅那一套不值得；而且状态活在窗口进程里，信使刷新（开发态热更新、或者用户切走再回来）之后再问一次就能接上正在跑的那次下载。任务状态里带 `phase`（`downloading` / `verifying` / `installing` / `restarting` / `failed`）、已下载字节、总字节、目标版本、失败码和技术细节；失败码是稳定的几个（`not-installed` / `read-only` / `bad-url` / `busy` / `download-failed` / `verify-failed` / `install-failed`），信使把它映射成一句话，细节小字附在下面。

按钮出现之前先问 `can_install_update`：开发态构建（`tauri::is_dev()`）、不是从 `.app` 里跑的、或者 `.app` 及其父目录不可写（别人装的 `/Applications` 那份）一律答 false，卡片就只给「下载更新」那条浏览器路径，而不是给一个按下去必然失败的按钮。可写与否是真的去写一个探针文件试，不是读权限位——`/Applications` 的权限位在不同装法下并不能说明当前用户能不能改那一份。下载本身可以取消（每次任务一个独立的取消标志，取消过的那次不会被下一次重试的标志复活），有 1.5GB 上限和「声明长度必须和收到的字节对上」的检查，中途失败或取消都把半个 `.dmg` 删掉。

`ureq` 不读代理环境变量，而 GitHub 在不少机器上只有走代理才通——所以检查和下载都过一层 `HTTPS_PROXY` / `ALL_PROXY`（`NO_PROXY` 可以把 github 排除掉）。这只对「从带这些变量的 shell 里启动」的那份有用（开发态就是这样），从 Finder 启动的那份拿不到 shell 的环境；把系统代理设置也读进来是另一件事，现在不做。
