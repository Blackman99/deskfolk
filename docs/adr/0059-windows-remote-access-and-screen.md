# Windows 的远控走守护进程的 stdin/stdout、用 Windows Hello 确认，远程屏幕接用户装的 VNC 服务

[ADR 0033](0033-remote-credentials-in-a-file.md) 让 macOS 的发布包能远控：凭据存在文件里，窗把一对 socketpair 当 FD 3 交给它起的守护进程，确认由窗弹触控 ID。Windows 预览版起步时把远控整块留在了外面：窗交不出 FD 3，也没有确认框，所以 Windows 上的守护进程一直用封口 provider，远控状态带 `platform_unsupported`，设置卡片直接写「Windows 版还不支持」。[ADR 0056](0056-remote-screen.md) 的远程屏幕又骑在远控链路上，画面和输入交给 macOS 自带的屏幕共享，而 Windows 没有自带的 RFB 服务：远程桌面（RDP）是另一套协议，家庭版没有，从本机连自己会被拒绝或把控制台会话挤下线。

## 决定

- **凭据照 ADR 0033 存文件。** Windows 的编译态守护进程同样用 `FileRemoteNative`，文件在 `%LOCALAPPDATA%\real-bot\dev-remote\credentials.json`。这个目录继承用户配置文件的 NTFS 权限，本来就只有这个用户能读；`chmod` 在 Windows 上只管只读属性，不当它是保护。替换文件改用 `renameReplacing`：杀毒软件或索引器短暂占着旧文件不算失败。
- **设置通道是守护进程自己的 stdin 和 stdout。** 窗起守护进程时把这两个设成管道（原来是丢弃），另一端只在窗手里，帧格式和 macOS 的 FD 3 一样（4 字节长度加 JSON，最长 8192）。stdout 上多出任何一个字节都会被窗当成帧头，所以守护进程带 `--desktop-remote-channel` 起来时第一件事是 `reserveStdout()`：`console.log` 一类和 `process.stdout.write` 都改写到 stderr。窗在单独的线程里读回复，130 秒等不到就丢掉这条通道：Windows 的匿名管道没有读超时，晚到的回复又会被当成下一个请求的答案。
- **带上这个参数，Windows 的守护进程也算「窗监督」。** 以前 Windows 不传 `--desktop-remote-channel`，守护进程按无人监督算，远程重启不可用；现在和 macOS 一样，重启后由窗每 800 ms 一次的检查拉起来。
- **确认用 Windows Hello。** 窗的确认步骤和 macOS 相同（先问 `challenge_display`，人过了才问 `challenge_proof`），弹的是 `UserConsentVerifier`：人脸、指纹或 PIN。窗口句柄经 `IUserConsentVerifierInterop` 交过去，对话框出在窗前面；拿不到句柄或系统没有这个接口时退回不带句柄的调用。这个账户没设 Hello 时答 `hello_not_configured`：Windows 不给应用一个让人输账户密码的系统框，自己画密码框再拿 `LogonUser` 去验，等于让 Deskfolk 经手账户密码。
- **远程屏幕的画面和输入来自用户装的 VNC 服务，推荐 TightVNC。** 守护进程和 `real-bot-rtc` 照旧只连 `127.0.0.1:5900`，没有新增配置。要求两点：注册成系统服务（以 SYSTEM 运行，锁屏、登录界面、UAC 弹窗才能看能点，对应屏幕共享能操作 Mac 的锁屏），只接受本机回环连接（5900 不对局域网开放，比 macOS 的屏幕共享收得还紧）。TightVNC 默认拒绝回环连接，它会在问候之前断开，守护进程的探测因此读成「没有服务」，设置卡片在这时列出安装和配置步骤，按钮换成 TightVNC 的下载页。
- **`real-bot-rtc` 在 Windows 上一样编译、打包（`real-bot-rtc.exe`）**，直连和 macOS 相同；多一个 `stay-awake` 子命令，用 `SetThreadExecutionState` 让显示器和系统在有人连着时不睡，对应 macOS 的 `caffeinate`，stdin 一关或进程一死 Windows 就收回。
- **没有「流畅」模式。** noVNC 向 VNC 服务要 Tight 编码加 JPEG，帧本来就小，用不着降分辨率；而 macOS 那边降分辨率之所以敢做，是因为按进程设的模式在 helper 怎么死都会自己恢复，Windows 没有现成的同等保证。
- **手机从 `/remote/features` 的 `host` 知道对面是哪种电脑。** `"windows"` 时页面叫「电脑屏幕」，登录框只要 VNC 密码（noVNC 按服务给的认证方式决定要不要账户名），按键行是 Ctrl、Alt、Win、⇧，顶栏原来「流畅」的位置换成 Ctrl+Alt+Del（noVNC 的 `sendCtrlAltDel`，服务模式的 TightVNC 把它变成安全注意序列；按键行在 412 px 宽的手机上已经没有空位）。不报 `host` 的旧守护进程按 Mac 处理。

## 为什么不是别的

- **自己截屏、注入输入**（Windows Graphics Capture / DXGI 加 `SendInput`，或者干脆让画面走 WebRTC 视频轨）。不用装东西、画面最顺，但普通用户进程碰不到安全桌面：锁屏、登录界面和 UAC 弹窗时只有黑屏，也输不进密码。Chrome 远程桌面这类产品靠装一个以 SYSTEM 运行的服务做到，而我们的安装包按用户装、不要管理员。视频轨还走不了中继，打不通直连就没有画面。
- **用 FD 3 或命名管道当设置通道。** Rust 的 `Command` 没法把第四个句柄放进子进程的 C 运行时描述符表（要自己填 `STARTUPINFO` 的 `lpReserved2`），Bun 认不认那张表也没处验证；命名管道要公开一个名字，再核对连进来的是不是自己起的进程。stdin/stdout 是 Bun 在 Windows 上一定支持的两个描述符，而守护进程原本也不用它们。
- **没有 Hello 时退回账户密码。** 见上：那要 Deskfolk 自己收账户密码。

## 代价

- 要装第三方软件并照着配置（服务模式、主密码、只允许回环）。VNC 密码只认前 8 位，认证是老式的 DES 挑战响应；它只在本机回环和端到端加密的链路上走，出不了这台电脑。
- VNC 服务以 SYSTEM 运行，它的漏洞就是这台电脑的漏洞。只允许回环时，能连它的只有本机进程，而本机同用户进程本来就能拿本机 API 的 token。
- 没设 Windows Hello 的电脑配不了设备，要先在「设置 → 账户 → 登录选项」里设 PIN。
- 第一次直连时 Windows 防火墙可能问要不要允许 `real-bot-rtc.exe` 通信；拒绝了照样能退回中继。
- 这些都还没在真的 Windows 上跑过：Bun 用描述符 0/1 读写管道、Hello 对话框、TightVNC 的回环设置和编码、`SetThreadExecutionState` 在锁屏时管不管用。已做的：stdio 通道的测试在 macOS 上用子进程跑真的 stdin/stdout（Windows CI 跑同一个），Windows 目标的 Rust 代码（窗和 helper）交叉编译检查通过。
