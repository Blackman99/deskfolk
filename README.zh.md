<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png">
    <img alt="Real Bot：群聊与它的流程图、一张待批准卡和 Markdown 预览" src="docs/assets/readme-hero-light.png">
  </picture>
</p>

<h1 align="center">Real Bot</h1>

<p align="center">在自己的电脑上，用对话组一支持久的 AI 队友。</p>

<p align="center">
  <a href="https://blackman99.github.io/real-bot/zh"><b>官网</b></a> ·
  <a href="https://github.com/Blackman99/real-bot/releases/latest"><b>下载 Alpha</b></a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Blackman99/real-bot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Blackman99/real-bot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-146a7c.svg"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-0f172a.svg">
  <a href="https://github.com/Blackman99/real-bot/releases/latest"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f0ab3d.svg"></a>
</p>

## 它做什么

- **是队友，不是用完即弃的对话。** Bot 有名字、职责和边界，可以私聊、进群、被 `@` 点名、彼此交接。一个 Bot 去问另一个 Bot 时单开一条对话，入口挂在引出它的那条消息下面，你只能看不能插话。
- **一切都在你的 Mac 上。** 窗口、守护进程、会话和一个共享工作区目录都在本机，没有项目方的云端。
- **模型和工具自己接。** 任意 OpenAI 兼容端点；stdio 或 Streamable HTTP 的 MCP 服务器，所有 Bot 共用。
- **一件事是一张流程图。** 共用一个工作目录的群、私聊和 Bot↔Bot 私聊打开同一张板，按谁叫醒了谁画出来——一句话点了三个 Bot，就分成三支；一轮一张卡片，点开这一轮交出的文件，就接在这一轮后面展开，只读。每张 Bot 卡片底下写着这一轮用的模型、思考等级和消息类别，点这一行，理由、反馈和复盘在卡片下面展开；工具条可以点亮有反馈或归咎模型的那几轮。从一条消息打开时，直接落到这条消息自己的卡片上。
- **模型每轮现挑，并且说得出理由。** 每开一轮先由 agent 给这个 Bot 挑模型和思考等级，并留下一句理由。一条纠正告一段落时复盘一次，判出到底是模型不行、事情本身难，还是需求没说清；只有判成模型不行才留成这个 Bot 的经验。一轮也记下走了几跳、工具失败了几次，链结束时可以给这个 Bot 留一条记忆，或改它已有的一条技能，供下次同类任务用。每轮选了什么、怎么结束、收到哪些反馈，都记在流程图里这一轮的卡片上，本机接口也能按会话逐轮查看。
- **终端在手边，命令看得见。** 你可以在应用里开一条自己的 shell 会话，跑 `pnpm dev` 这类一直开着的进程：守护进程持有它，关窗不停；退出后再开，终端回到原来的位置；用起来像 Mac 上的终端——⌘← / ⌘⌫ 这些编辑键、⌘K 清屏、⌘F 查找、⌘-点击打开链接、右键复制粘贴，颜色跟着浅色深色走；屏幕由守护进程持有，接回时 vim 这类全屏程序也原样回来；在 zsh 里 `cd` 之后标签跟着变；配对过的手机上能看能敲，软键盘缺的 Ctrl-C、Tab、方向键有一排键补上。Bot 执行命令时，输出就在它那条气泡下面边跑边滚，跑完折叠成一行「命令 · 退出码 · 耗时」。Bot 用的仍是原来那个一次性的壳——逐次判定路径、该批准还是要批准，只是不再让你对着十分钟的静默干等。
- **桌面窗能分成多块窗格。** 主栏可以左右、上下任意分割，放得下就能再分。一块窗格是一组标签页：一条会话（带着它唯一的一块产物预览和一块流程图）、一个终端、日程图或工作区。分隔条能拖，两条分隔条交汇的地方横纵同时拖；标签可以拖到别的窗格、拖到边缘就地分割、按住 ⌥ 拖出来浮在窗里。在窗格里任意位置右键可以向上下左右分割，也可以用「视图」菜单（⌘\ 向右、⌘⇧\ 向下）；⌘W 关标签页，关掉终端标签不杀 shell，从「＋」里接回。当前窗格——键盘所在、Stop 作用的那块——四周描强调色，并排的几条会话各有各的草稿、回复对象和待发附件。排法只记在这台 Mac 上，退出再开，分屏和里面的终端都回来。窄窗和手机上仍是一次一屏。
- **等你的事标在会话列表上。** 没有通知页：待批准、待回答、中断和失败的轮次标在那条会话的行上。macOS 横幅点开就是它说的那条会话，Dock 角标只数你没看过的和还在等你的，设置 → 通知里选哪些事发横幅，也能设免打扰时段。
- **危险动作等你放行。** 新建端点或 MCP、工作区外读写、出站网络都停在批准卡上；密钥进钥匙串，不进聊天。
- **Bot 管理应用本身。** 建 Bot、组群、配端点和 MCP，跟它说一句就行。

## 获取

**系统要求：macOS 13.0（Ventura）或更新版本**，支持 Apple 芯片与 Intel。

**下载**最新 Alpha：[GitHub Releases](https://github.com/Blackman99/real-bot/releases/latest) 提供 Apple 芯片与 Intel 两种未签名 `.dmg`。应用自带运行时与原生 helper，不需要另外装 Bun、Node 或源码。首次打开若被 Gatekeeper 拦截，右键选「打开」，或执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Real Bot.app"
```

更多说明：[Gatekeeper FAQ](docs/gatekeeper.zh.md) · 公证路径：[docs/notarization.md](docs/notarization.md)（[#10](https://github.com/Blackman99/real-bot/issues/10)）。

**更新：**应用会在后台检查 GitHub Releases，有新构建时设置齿轮上会出现小红点。设置 → 通用 → 关于 显示当前版本，并在浏览器中打开对应芯片的 `.dmg`；构建未签名期间没有应用内安装器。

**从源码启动**（macOS 13.0+、Node 22+、pnpm 12.3.4、Bun 1.2+、Rust、Xcode Command Line Tools）：

```bash
pnpm install
pnpm dev
```

首次使用：选一个工作区目录（不存在会自动创建），在设置里填 OpenAI 兼容端点和密钥，从侧栏建第一个 Bot，再让它把其他队友建出来。

信使在手机宽度下提供 **会话 / 工作区 / 设置** 底部导航。已归档会话入口在搜索框下方，外观在 **设置 → 基础偏好** 中调整。进入会话或设置详情后收起底栏；编辑工作区文件后切换入口，会先提示保存或丢弃修改。

桌面窗里，对话左缘有一条紧凑的消息索引：悬停刻度看发送者和正文，点一下跳过去，方向键逐条浏览，顶部可以载入更早的记录。会话窗格窄于手机时按手机布局排。应用画出来的图片——消息里的、放大后的、预览里的、流程图上的、输入框里待发的——右键就能复制；文件预览里的图片点一下放大，和消息里的一样。

实验性远程连接中的音视频预览支持边加载边播放，消息附件、工作区和流程图产物均可拖动进度读取对应片段。需要浏览器支持 Service Worker、主机支持字节范围读取；其他环境保留整文件预览。沿用远程单文件 50 MiB 限制，可播放格式取决于浏览器编解码支持。

## 每日与每周日程

侧栏底部的日历按钮（手机上在搜索旁边）打开**日程图**：有日程的 Bot，其每天和每周日程铺在同一张周视图里，只读。没有日程的 Bot 不出现。名册筛选是一枚可搜索的下拉，按名字或职责找，点一行隐藏或显示这个 Bot 的格子。议程里每一行也标出这个 Bot 的头像和名字。格子是规则展开，不是每次运行的记录；钟点按执行 Mac 的本地时间标出。改时间仍在 Bot 资料里做，手机上不能拖。

打开 Bot 资料（Bot 头像/名字 → 资料），在 **日程 → 新建日程** 中填写标题、任务指令，选择**每天**或**每周**（至少一天），再选时间。日程归当前 Bot。宽屏上，编辑、暂停/恢复和确认删除都在同一张卡片里。手机上，日程条数和「新建日程」在日程页的顶栏里；点一条日程会打开整页，进入时不自动聚焦输入框：时间用系统时间选择，星期是一排可点的日子，启用是开关；暂停和删除不跟列表挤在一行里，删除在这一页底部，返回先回到日程列表。侧栏搜索日程会打开所属 Bot 的资料和对应编辑页。后来的搜索或关闭操作会取消较早的待完成跳转；所属 Bot 已删除的历史日程仍保留，但在搜索中标为不可用。确认框限制键盘焦点，取消后归还触发控件，保存中不能关闭。

时间按**执行 Mac 的本地时区**解释，不按浏览器时区换算；没有单条日程时区或 cron 表达式。Mac 需醒着且运行时可用；恢复后只补最近一次，不逐次补跑；归档 Bot 不执行日程。删除或暂停不会停止已经开始的任务。列表通过事件跨客户端实时更新，重连后刷新；另一客户端修改了正在编辑的日程时，先载入最新版本再保存，旧版本保存和删除会被拒绝，不会静默覆盖。连接中断不会自动重试写入，请重连后核对列表。请求结果未知时，可在日程卡片点击**重试原请求**，仅重发原内容和请求编号，不发送后来修改的草稿；待确认载荷提示不是版本冲突。原请求结束待确认后，修改的草稿仍保留显示，但需先核对列表并重新打开日程，才能继续提交。

## 状态

Alpha，仅 macOS。已接入、正在建设与明确不做：[官网](https://blackman99.github.io/real-bot/zh#boundaries) · [路线图](ROADMAP.md) · [CONTEXT.md](CONTEXT.md)（领域语言）。

共享远控密码包是**实验性、默认关闭的原型**，不代表远控已可用。默认关闭的 Bun 中继、原生门控 daemon 适配器和托管信使 PWA 客户端现可供隔离集成测试。托管生产包不含本机发现与回环 bearer；公网配对仍关闭。链路断了——中继关掉、Mac 走了、手机换了网——由页面自己发现并退避重连，包括浏览器根本不报的那种死链；断着的时候不排队命令，从锁屏或后台回来也会自己再试，不用等你点一下，并且只向 Mac 要这段时间里的变化。图片先到缩小的副本，原图点一下就有。远程连接有自己的「文件」会话：发在那里的文件复制进工作区 `inbox/`，文字留作给自己的备注，都不叫醒任何 Bot；桌面的会话列表里也有这条会话。Web Push 遵循守护进程的代理环境（`https_proxy` / `HTTPS_PROXY`，以 `ALL_PROXY` 兜底，`NO_PROXY` 排除）；见[代理配置](docs/deploy-remote.md#web-push-proxy)。可选 Web Push 仅泛化待办提醒，由 Mac 出站；点击通知只重连并回到会话列表，绝不批准。应用内状态标在会话列表上，没有单独的通知页。生产 daemon 会广告 `push_settings_v2`，`push_transport` 为 `policy_v2`。出站 Web Push 发送、订阅与测试受远控激活 / 原生 / 信任门约束，解绑仍可用于清理，不再停在临时升级暂停。冷启动点击与签名安装包仍未验收（`NATIVE_DELIVERY_QUALIFIED` 为 false）。进程带应用标识且系统已允许时就可以发横幅，这个标志不再关掉测试；入队结果是 queued，不是系统已展示。`tauri dev` 会在一个调试用 `.app` 里重新启动，标识仍是 `com.real-bot.desktop`，通知中心才认这个进程，系统设置里已经允许的也才是它。 托管远程测试走远控门、联系人与订阅。这不是可用远控产品：独立安全复核（S-rev）、真机 iOS/Android 主屏幕 WebAuthn（G-uv）、真机 L1 与真机主屏幕 Web Push（G-push）**未通过**。见[自托管部署、bootstrap 恢复与路由契约](docs/deploy-remote.md)，含独立 `test:edge` 命令验证本机真实 Caddy HTTP/HTTPS/WSS（需要 Caddy 2.10.2 与 OpenSSL）。测试含官方 Noise 向量和独立 Rust snow 对端（`pnpm test` 需 Cargo）。见[协议/API 契约](docs/remote-protocol.md)，其中包含条件头与同名附件排序的唯一共享回执摘要，本机 daemon 回执现也通过仅含规范编码的 workspace 导出使用它。daemon 仍保留更严格的路由及强 SHA-256 If-Match 校验。

## 参与

[开发说明](docs/development.md) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)。MIT 协议开源，与 xAI / Grok 无官方附属关系。
