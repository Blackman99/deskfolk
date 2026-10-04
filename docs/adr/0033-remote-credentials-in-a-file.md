# 发布包的远控凭据存在文件里，确认由窗自己弹触控 ID

[ADR 0022](0022-native-gated-remote-daemon.md) 把远控的长期密钥放进钥匙串的专用访问组，只放行签名 helper 和「封好口」的编译态守护进程，并且在打包门（G-pack）通过前让发布包一律回 `g_pack_not_verified`。这条路今天走不通，而且不只是差一个开关：

- 访问组要正式签名和描述文件授权，而发布包是 ad-hoc 签名，没有 Team ID。
- 编译态守护进程开着 hardened runtime，库校验直接拒绝加载 ad-hoc 签名的 `libRemoteCredentials.dylib`：0.1.0-rc.10 的 `real-bot-daemon --remote-native-capability` 答 `native_library_unavailable`，还没轮到钥匙串。
- 同一套签名校验还管着窗交给守护进程的 FD 3 配对通道和 helper 的 socket，所以发布包连配对界面都走不到。
- 那条 FD 3 通道其实从没通过：Bun 的 `new net.Socket({ fd: 3 })` 一接上就把 socketpair 结束了，窗那边第一次请求前就读到 EOF。封口 provider 在接上之前就拒绝，所以一直没人发现。
- 就算签名全过，`remoteNative.capability()` 也写死 `enabled: false`；要真正打开，还得先有一个去掉任意代码入口的 Bun 运行时，这仓库造不出来。

结果是远控只能在源码态、带 `REAL_BOT_DEV_REMOTE=1` 时用，发布包完全不能用。

## 现在

- **编译态守护进程用文件存凭据。** `remote/file-native.ts` 的 `FileRemoteNative`（原来的开发替身）是发布包的凭据存储：主机 DH/签名、enrollment、VAPID 私钥和高水位在数据目录的 `dev-remote/credentials.json`，目录 0700、文件 0600、先写临时文件再改名。第一次用到密钥才生成，从不配对的 Mac 不写任何密钥。坏掉的文件报 `corrupt`，不覆盖：它是已配对设备钉住的那份身份的唯一副本。目录名沿用源码态的，因为两者共用数据目录，从源码登记过的 Mac 到发布包里身份和设备都还在。
- **FD 3 按来历信任。** 窗 spawn 守护进程时建的 socketpair 只交给这个子进程；文件模式下守护进程不再找 dylib 验对端签名，直接接上。别的同用户进程能自己起一个带 FD 3 的守护进程，但那个进程读的也是同一个 0600 文件，拦它没有意义。FD 3 改成按普通描述符读写（`inheritedChannel`），`compiled-daemon.test.ts` 用编译产物和真 FD 3 验这条通道。
- **确认在窗里做。** 守护进程照旧先把整个动作算成摘要、发一个 120 秒的挑战。窗的 `remote_native_confirmation` 走 FD 3 问 `challenge_display` 拿到动作的原话，用 `LAContext` 的 `deviceOwnerAuthentication`（触控 ID，没有就是登录密码）把它显示出来；人过了，才问 `challenge_proof` 要证明，交给网页去调 `confirm_pair` 之类。网页发不了这两步：Tauri 的 `remote_local_setup` 只转发设置操作。确认框上的字全来自守护进程，网页插不进话。关掉确认框什么都不消耗，批准按钮还在。
- **登记中继在设置里做。** 发布包没有 bun 和命令行，所以远控卡片在这台 Mac 还没登记时给一张表：中继地址、`RELAY_ID`、一次性 bootstrap 令牌。首次登记先让中继收下令牌，再写 `remote_host`，所以输错地址或令牌被拒不会留下任何东西，改好能再发；中继拒收（`relay_bootstrap`）和连不上（`relay_unreachable`）分开告诉人，其余拒绝仍是一句不透露细节的 `remote_setup_denied`。
- **源码态不变。** 不带开关的源码态仍用封口 provider，远控状态带 `sealed_runtime_required`，卡片不给登记表；带 `REAL_BOT_DEV_REMOTE=1` 仍是 unix socket、本机 HTTP 路由和顶替者确认。
- 封口 provider、Swift helper 和 dylib 的代码都留着，照旧打进包里但发布包的远控不走它们。等真有封好口的运行时，把文件导进钥匙串再删掉文件即可换回去。

## 取舍

放弃的，是 ADR 0022 专门防同用户进程的那几层：

- **密钥能被读走。** 任何以你的用户身份运行的程序都能读 `credentials.json`，拿到主机私钥就能在中继上冒充这台 Mac，给已配对的手机下套。钥匙串访问组本来只放行 helper 和合格的守护进程。
- **回滚保护变弱。** 高水位和数据库在同一个目录里，整目录备份再恢复，被撤销的设备会跟着复活。以前高水位在钥匙串里，能拦住「只恢复数据库」这一种。
- **触控 ID 只挡远处和网页。** 它保证网页（包括被 XSS 的网页）和远端设备配不了新设备，也保证有人在 Mac 前。它挡不住本机的同用户恶意程序，后者本来就能读本机 API 的 token 和这个文件。

换来的，是发布包能远控。我们接受这个交换，因为发布包本来就没把同用户进程挡在外面：本机 API 的 token 同样在数据目录里，任何同用户进程都能拿它驱动 Bot、敲终端。远控额外暴露的，是一个持久的远程入口和一把能冒充 Mac 的私钥；端到端加密、中继读不到内容、每台设备都要在 Mac 前当面批准、维护操作要手机上的 WebAuthn 用户验证，这些都不变。

独立安全复核（S-rev）、真机 WebAuthn（G-uv）、iOS 推送（G-push）照旧没过；远控仍是默认关闭的实验功能，不配对时公网配对照旧关着。

## 不做

- 不回落到 `Bun.secrets` 的普通钥匙串项。ADR 0022 拒绝过它：没有访问组的项对同用户进程挡不了多少，却让人以为密钥在钥匙串里就安全了。文件就写成文件，代价写在这里。
- 不给发布包留一个跳过确认的开关。`dev_authenticate` 这类顶替者确认只在源码态存在，编译态守护进程从来不提供。

Windows 上同样用这个文件存凭据；那边的设置通道和确认框不同（守护进程的 stdin/stdout、Windows Hello），见 [ADR 0059](0059-windows-remote-access-and-screen.md)。
