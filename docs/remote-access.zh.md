# 远程访问（实验性）

[English](remote-access.md)

> **默认关闭，也还不是做完的功能。** 远程访问是实验原型。安装的应用就能设置远控、配对设备：它把 Mac 的远控身份存在数据目录里的一个私有文件里，不进钥匙串，每台设备由触控 ID（或登录密码）批准（这样换来了什么、放弃了什么，见 [ADR 0033](adr/0033-remote-credentials-in-a-file.md)）。日常功能和 Web Push 已在 Android Chrome 真机上走通（在源码态验证；安装的应用跑的是同一套协议、同一个文件）；独立安全复核（S-rev）、真机主屏幕 WebAuthn（G-uv）、iOS 真机 L1 与 iOS 主屏幕 Web Push（G-push）都**没有通过**。不配对的时候就把公网配对关着，也别把经不起外泄的东西放到这条路上。

远程访问让手机，或者另一台电脑上的浏览器，连到你 Mac 上的 Deskfolk：看会话、回消息、处理等你的事、翻工作区、在你的终端里敲命令。没有 Deskfolk 的云。中继由你自己部署，Mac 只往外连它，中继只转发它自己解不开的密文。

## 它是怎么接起来的

- **你的 Mac** 仍然是唯一干活的地方。守护进程向中继保持一条出站的控制连接，每连上一台设备再多开一条。Mac 上不监听任何入站连接。
- **中继**是一个跑在 Caddy 后面的小 Bun 服务，放在你自己的服务器和域名上。它用 HTTPS 提供手机端页面——托管信使，一个能装到主屏幕的网页——并在 Mac 和每台设备之间转发不透明的 Noise 帧。它只存登记用的公钥，日志只记固定的事件码，解不开任何一条消息。
- **每台设备**由你在 Mac 旁配对一次。之后它和 Mac 之间走端到端的 Noise IK，中继只负责把字节送到。

单人、单台 Mac、最多 16 台已配对设备。链路断着的时候什么都不排队：Mac 睡了或者连不上，设备上会直接说连不上，不发任何东西；Mac 回来后它自己重连。

## 配对过的设备能做什么

- **会话**——会话列表、看和发消息、`@` 点名、Stop，回答批准卡和提问。等你的事标在会话上，和 Mac 上一样。
- **工作区**——在 Mac 上逐级浏览目录，打开或下载任意大小的文件。打开的每个文件都能下载：手机上在预览顶栏右端，宽屏在文件上方那排按钮里，流程图上在文件卡片头部。预览不了的文件（比如字幕、压缩包）会写明不支持预览，下载按钮放在正中。图片先到缩小的副本，原图点一下就有。放大的图片（会话里、工作区里都一样）右上角能下载原图：手机上打开系统分享面板，选「存储图像」存进相册。从手机发出去的图片、视频、音频和 PDF，在页面刷新前直接用手机上的那份打开，不再经中继读回来。音视频边加载边播放。
- **你的终端**——看守护进程持有的 shell 并往里敲，底部两排键补上 Esc、Tab、Ctrl、方向键和粘贴。手指上下滑动可以翻看输出历史，Claude Code、vim、less 这类全屏程序里也行。
- **专门的「文件」会话**——发到那里的文件复制进工作区 `inbox/`，文字留作给自己的备注，都不叫醒任何 Bot。文件按约 0.9 MB/s 上传，留在中继的共用限流以内，一段 20 MB 的视频大约 23 秒。上传时发送按钮转一圈进度，每个附件写着传了多少；没发出去的附件会留在作曲栏里。
- **可选的 Web Push**——由 Mac 发出的泛化提醒「Deskfolk 有待处理事项」。点开只是重连并回到会话列表，绝不批准任何东西。
- **维护**——状态、脱敏诊断、排空后重启运行时。这些操作和吊销其它设备都需要在本设备上做 WebAuthn 用户验证（面容 ID、触控 ID 或密码），没有点一下确认的替代；普通聊天不需要它。

改工作区目录、让 Mac 连哪个中继、批准新设备，仍然要人在 Mac 旁。

## 开始之前

- 一台你能控制的 Linux 服务器：装好 Docker Compose，80 和 443 端口空着，有一个指向它的域名（下文用 `relay.example.com`）。
- Mac 上的 Deskfolk：安装的应用，或者源码检出（满足[从源码启动](../README.zh.md)的要求，`bun` 在 PATH 上）。
- 一部浏览器够新的手机。要用 Web Push 的话，iOS 需要 16.4 以上，并把页面添加到主屏幕。

## 1. 部署中继

在服务器上，进到本仓库的检出目录：

**生成一次性 bootstrap 令牌。**有了它，你的 Mac、也只有你的 Mac 能在这个中继上登记。直接写进检出目录之外的私有文件；别打印出来，别贴进聊天，也别放在命令行参数里。

```sh
umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > /srv/deskfolk-relay/bootstrap
```

**写一份私有 env 文件**，同样放在检出目录之外。两个数据目录要事先建好，属主 UID 1000、权限 0700，最好放在限额 1 GiB 的文件系统上。

```sh
RELAY_ID=my-relay
RELAY_DOMAIN=relay.example.com
ACME_EMAIL=you@example.com
RELAY_STATE_DIR=/srv/deskfolk-relay/state
CADDY_DATA_DIR=/srv/deskfolk-relay/caddy
RELAY_BOOTSTRAP_FILE=/srv/deskfolk-relay/bootstrap
RELAY_ENABLED=1
RELAY_PAIRING_ENABLED=1
REMOTE_BIND_IP=0.0.0.0
```

`RELAY_ENABLED` 和 `RELAY_PAIRING_ENABLED` 默认都关：没有前者中继什么都不放进来，bootstrap 和配对还要后者。不设 `REMOTE_BIND_IP` 时 Caddy 只在 `127.0.0.1` 上发布 80/443；把它开到公网，正是那几道还没通过的安全门要管的一步，想清楚再开。

**构建、启动、自检：**

```sh
docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml config --quiet
docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml up -d --build
sh deploy/remote/check-health.sh /srv/deskfolk-relay/remote.env
```

Caddy 会为你的域名申请证书。现在打开 `https://relay.example.com`，应该能看到配对页。

不用 Docker 也行：同一个中继可以用 `bun apps/relay/dist/main.js` 跑（先 `pnpm --filter @real-bot/relay build`，Bun 1.4.2），环境变量不变；前面放任何一个逐条复刻 [`deploy/remote/Caddyfile`](../deploy/remote/Caddyfile) 的 TLS 代理，由它提供 `pnpm --filter @real-bot/messenger build:hosted` 的产物。页面的 Content-Security-Policy 里带着这次构建的脚本哈希：每次重新构建都用 `node deploy/remote/csp.mjs <产物>/index.html <头文件>` 重新生成这个头，和产物一起发布，否则页面白屏。

全部变量、限额和恢复规则见[自托管部署](deploy-remote.md)。

## 2. 让 Mac 连上中继

在应用里打开 **设置 → 通用 → 远控（实验性）**。这台 Mac 还没登记时，卡片会要三样东西：

- **中继地址**——`https://relay.example.com`，第 1 步里的域名。
- **中继 ID**——env 文件里的 `RELAY_ID`。
- **一次性 bootstrap 令牌**——bootstrap 文件的内容。把文件拷到 Mac 上（权限 0600）再从里面粘，别经过聊天或备忘录。

点 **接入中继**。中继随即消耗掉这个令牌，不能再用第二次。被拒或输错的令牌不会在 Mac 上留下任何东西，改好再试就行（令牌已经用掉的话要换一个新的，见 [bootstrap 恢复](deploy-remote.md#environment-and-bootstrap-recovery)）。之后把两台机器上的 bootstrap 文件清空。卡片这时显示 **远控在线**。

Mac 的远控身份存在守护进程数据目录（`~/Library/Application Support/real-bot`）的 `dev-remote/credentials.json` 里，权限 0600，第一次接入时生成。以你的用户身份运行的程序都能读它，和这个目录里别的东西一样。名字是只有源码态用它时起的；安装的应用和源码态共用这个目录，所以从源码登记过的 Mac 到了应用里，身份和已配对的设备都还在。

**从源码运行**时带开发开关启动：`REAL_BOT_DEV_REMOTE=1 pnpm dev`。它用同一个文件，并顶替触控 ID 的确认框：设置卡片不弹框就批准，命令行也一样，命令行还能登记这台 Mac：

```sh
bun apps/daemon/scripts/dev-remote.ts init --origin https://relay.example.com --relay-id my-relay --bootstrap-file ~/deskfolk-bootstrap
bun apps/daemon/scripts/dev-remote.ts status
```

`init` 从文件读令牌——从不走命令行参数——并打印这台 Mac 的主机 id。

## 3. 配对手机

1. 在 Mac 上 **设置 → 通用 → 远控（实验性）** 里点 **配对新设备**。卡片上出现一段以 `rb1` 开头的一次性配对内容和这台 Mac 的签名指纹，十分钟后失效。（`bun apps/daemon/scripts/dev-remote.ts pair` 会打印同一段内容并放进剪贴板。）
2. 把它送到手机上——通用剪贴板、隔空投送，或者一条用完就删的备忘录。它带着一次性密钥，别写进聊天和日志。
3. 在手机上打开 `https://relay.example.com`，把它粘进 **配对内容**。页面会显示中继地址和 Mac 的指纹：和 Mac 上的对一下，一致再点 **提交并等待 Mac 确认**。配对内容只在提供这个页面的那个中继上有效，粘进来的东西没法把手机指到别处。
4. Mac 上显示这台设备的名字和它的指纹。和手机上的对一下，再点 **批准这台设备**，然后过触控 ID（或输入登录密码）；确认框上写着设备名和完整指纹。关掉确认框不会配对任何东西，批准按钮也还在。（源码态由顶替者直接批准，不弹框。）
5. 手机进入会话列表。把页面添加到主屏幕，以后像应用一样打开。
6. 需要维护操作的话，在手机上 **设置 → 远控（实验性）** 里点 **登记本设备用户验证**。
7. 把配对关回去：`RELAY_PAIRING_ENABLED=0`，再执行一次上面的 `up -d`。已配对的设备照常能用；要配下一台时再打开。

要去掉一台设备，在 Mac 的「已连接设备」列表里点 **移除设备**，同样过一次确认框。中继立刻忘掉它的公钥，它的链路随即断开。

## Web Push（可选）

提醒由 Mac 自己发出，直接发到手机浏览器的推送服务（Apple、Google 或 Mozilla）；中继从不代发。消息里只说有事待处理，点开只回到会话列表。

- **联系方式：**推送服务要求一个运营方联系方式，Mac 上没配之前推送一直暂停（`push_contact_required`）。通过 Mac 的本机接口配置：先 `GET /v1/notifications/push-config` 拿到当前 revision，再对同一路径 `PATCH` `{"contact_uri": "mailto:you@example.com", "if_revision": <revision>}`。
- **代理：**Mac 要经代理上网的话，启动时带上 `HTTPS_PROXY`，例如 `HTTPS_PROXY=http://127.0.0.1:7890 REAL_BOT_DEV_REMOTE=1 pnpm dev`。只在系统设置里配代理，守护进程是拿不到的。详见 [Web Push 代理](deploy-remote.md#web-push-proxy)。
- **手机上：**在 **设置 → 远控（实验性）** 里打开 **待办推送**，再发一条测试。结果会分清已入队、推送服务已接受、首次超时已安排重试；手机上最终弹不弹，取决于浏览器和系统。

## 不对劲的时候

- **远控已断开 / 执行主机不可达**——Mac 睡了、Deskfolk 没在跑，或者中继挂了。手机会自己退避重连，一回到前台也会马上再试。Mac 刚断网或换了网络时，等一两分钟：Mac 每 15 秒向中继问一次，连不上会自己重连；但换到另一个网络后，中继可能要先占着旧连接一分钟左右。
- **远控信任不匹配**——Mac 上存的远控身份和它的信任记录对不上了，比如恢复过数据目录，或删掉了 `dev-remote/credentials.json`。别为了绕过它去清中继的数据库：那是[自托管部署](deploy-remote.md#environment-and-bootstrap-recovery)里丢失主机密钥的恢复流程，所有设备都要重新配对。
- **「配对窗口已过期」**——在 Mac 上重新开一个；每段配对内容只管十分钟、只能用一次。
- **「这个窗口打开时运行时已经在跑」**——窗口只能管它自己启动的运行时的远控设置，比如窗口崩溃重开后就管不到。退出 Deskfolk 再打开。
- **重新构建后页面白屏**——CSP 头和它哈希的那次构建没有一起发布。

协议、密码学细节和还没通过的门：[远控协议](remote-protocol.md)。
