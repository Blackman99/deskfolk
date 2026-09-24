# Deskfolk 开发说明

> **WIP：**本文记录当前开发实现与限制，不是稳定版功能承诺。项目定位见 [README](../README.md)，建设方向见[路线图](../ROADMAP.md)。

本机 macOS 上的单人 agent 协作应用。词汇见 [`CONTEXT.md`](../CONTEXT.md)。以下命令均在项目根目录执行。

## 包

| 包 | 路径 | 运行时 |
|---|---|---|
| `@real-bot/daemon` | `apps/daemon` | Bun `>=1.2` |
| `@real-bot/relay` | `apps/relay` | Bun 1.4.2（部署钉定）；默认关闭的自托管密文中继 |
| `@real-bot/messenger` | `apps/messenger` | Node `>=22` · SvelteKit SPA |
| `@real-bot/desktop` | `apps/desktop` | Tauri 2 壳 |
| `@real-bot/landing` | `apps/landing` | SvelteKit 静态落地页（GitHub Pages） |
| `@real-bot/protocol` | `packages/protocol` | 本机接口类型（含通知 DTO 与游标编解码），加上点名解析和工作区路径判定（无 I/O） |
| `@real-bot/remote` | `packages/remote` | 浏览器/Bun 纯密码与编码接口；实验性、默认关闭，见[协议契约](remote-protocol.md) |
| `RuntimeHelper` | `apps/runtime-helper` | Swift 6 · macOS 13+，原生远控凭据/认证（默认禁用），以及终端会话的 pty（`real-bot-pty`） |

根 `pnpm test` 也构建并运行 `packages/remote/test/snow` 的独立 Rust snow 对打测试，需 Cargo；根 `pnpm typecheck` 包含此包。`pnpm --filter @real-bot/remote build` 产出 ESM/声明，`build:browser` 构建完整浏览器 API 与隔离 smoke fixture，`smoke:serve` 仅监听 `127.0.0.1:5184`。只使用生成的测试密钥，不连接个人数据库/钥匙串，不代表真机或安全审计门已过。

守护进程不是 sidecar（`externalBin` 为空；`build:sidecar` 那条路已被随包原生目录取代，同一个 `bun build --compile` 产物改由 `build:native` 产出并按 daemon entitlements 签名）。窗在监督时若本机接口不是我们，开发态用本机 `bun` 拉起 `apps/daemon/src/main.ts`，发布态用应用资源中的 `native/real-bot-daemon`；已有我们则连，不新开第二个。发布态只有显式 `REAL_BOT_SOURCE_DAEMON=1` 才走源码 Bun（并允许 `REAL_BOT_BUN` / `REAL_BOT_DAEMON_MAIN`）；默认不依赖 PATH Bun。源码路径是编译期烘进去的绝对路径，只在编译那台机器上成立——rc.3 的发布包烘的是 CI runner 的路径，装到别人机器上永远起不来运行时，所以发布态绝不走它。登录项只登记窗口进程（参数 `--hidden`，登录不弹窗）。`pnpm dev` 不写登录项，也不安装独立运行时 agent。退出（Cmd+Q / 托盘退出）在窗口监督时先停监督再 `POST /v1/runtime/quit`；独立模式仅在已开启时只退 UI（生产仍 gated，默认窗口监督）；显式 stop 写 `runtime.stop`。独立运行时交接见 [ADR 0023](adr/0023-independent-runtime.md)；G-pack / G-launchd 未通过。

## 实验性中继

根 `pnpm test` / `pnpm typecheck` 包含 `apps/relay`。`pnpm --filter @real-bot/relay build` 打包 Bun 入口；测试随机 loopback 端口、临时 SQLite、生成身份，真实双设备 Noise/WS、一次性 enrollment、吊销、未登记配对邮箱、慢 TCP 读端背压与 canary 日志脱敏，不用17890或个人数据。托管信使生产包用 `pnpm --filter @real-bot/messenger build:hosted`（`REAL_BOT_HOSTED=1`），不含 `__local-api` 与本机 bearer；桌面/Vite-dev 仍走本机发现。`pnpm --filter @real-bot/relay smoke:serve` 在 `[::1]:5186` 服务该静态壳。隔离浏览器用 `agent-browser --session rc08`；占用端口直接失败，不停他人服务。公网配对默认关闭；S-rev / G-uv / 真机 L1 未过。

另跑 `CADDY_BIN=/absolute/path/to/caddy pnpm --filter @real-bot/relay test:edge`（Caddy2.10.2、OpenSSL；可用 Go>=1.25 安装钉定版本，CI同样执行）。该套使用一次性 localhost 证书、随机 loopback 端口和真实Caddy→Bun，验证HTTP/HTTPS实际响应头、查询串拒绝、资源缓存/错误、WSS实际Noise往返/吊销；证书仅传给测试客户端，不关闭TLS验证、不改系统信任。浏览器静态fixture复用生产CSP生成器。Compose 的 Linux/公网TLS/磁盘 quota、外部安全复核与真机门需独立验收；没有 Docker daemon 时可检查 Compose schema、Dockerfile parser、本机Caddy配置和localhost TLS，但不能宣称容器部署或公网ACME通过。具体环境变量、非 root 构建、离线/恢复语义及 daemon07 消费的 HTTP/WS 契约见[自托管部署](deploy-remote.md)。不改变本机 bearer、loopback/Origin、窗监督或默认远控准入。

## 原生门控 daemon 远控接线

`apps/daemon/src/remote/` 复用已有 Store/LocalApi/engine：controller 出站控制/每设备 Noise，trust 使用同一 SQLite 做设备/重放/高水位，uv 使用共享真实 WebAuthn verifier，dispatch 是白名单而不是 HTTP 代理。`quiesce.ts` 由本机和维护调用方共享，不退出、不装 launchd。维护票 `remote/maint.ts` 在排空返回后才无闩/写闩退出；`GET /remote/status`、`GET /remote/diagnostics`、UV 诊断下载与 `POST /remote/runtime/{restart,stop}` 仅 E2EE。本机回环仍无维护写路由。无 metadata 时不读 native credentials；配置后原生失败只报告 `native_unavailable`，本机照常启动。stock Bun 未有可构建 sealed runtime，**生产仍 gated**，没有 env fake/keyfile/假 UV 回退。独立运行时交接（ticket 10）消费该排空与 latch，生产仍 fail-closed。

Tauri `remote_local_setup` 与 `remote_native_confirmation` 都只许 bundled main，前者走 daemon 继承 FD3，native 在读取前验证桌面 audit-token/签名；不是 bearer HTTP。先 `ready`，再列出设备或 open/read/prepare pair；移除设备与批准配对都经 Tauri confirm 后由 daemon consume。接口/QR/RPC/水印、首次 UV/替换、吊销 generation 修订、文件基础能力和08/09限制见 [remote protocol](remote-protocol.md#daemon-adapter-and-downstream-client-contract-ticket-07) 与 [ADR0022](adr/0022-native-gated-remote-daemon.md)。票 08 已落托管 PWA 配对客户端；票 09 补远程目录浏览与限流文件双工。远程信使另有一条固定 id `filedrop` 的你↔Mac 会话，收文件也收文字：附件仍进工作区 `inbox/`，文字只留在这条会话里；这条会话没有 Bot，消息不叫醒任何人，作曲栏输入 `@` 也不列 Bot；桌面会话列表也列出这一条，用来查看远程发来的文件。它的顶栏和别的会话一样：返回、图标、标题和下面那一行排成一行，手机上那一行放不下就末尾省略。公网配对仍默认关闭，不宣称 S-rev / G-uv / 真机 L1 / 真实 TCC 已过。票 12 增加可选 Web Push：Mac 出站、允许名单 HTTPS、`redirect:error`、载荷 `{t:"pending"}`、点击只回到会话列表；PR 6 发布 `push_settings_v2`，补单调 push_generation CAS、失效端点恢复、anti-SSRF/DNS 绑定（含 IPv4 映射十六进制 / NAT64）及本机联系配置，未配置暂停推送；生产 runtime 广告该能力，`GET /remote/push` 指纹字段为 `vapid_key_fingerprint`，`push_transport` 为 `policy_v2`。出站发送、订阅与测试仍要求远控门打开（`off` / `activation_gated` / `native_unavailable` / `trust_mismatch` 拒绝）；解绑仍可用于清理。门关闭时隔离套件不发 fetch。macOS 系统通知适配器已接线，`NATIVE_DELIVERY_QUALIFIED` 仍为 false。桌面与本机浏览器测试通知仅在 `native_delivery_v1`、许可已授予且设备开启时可用，入队结果是 queued 而不是系统已展示。托管远程测试走远控门、联系人与订阅。G-push 真机主屏幕未过，隔离测试禁止向个人设备发送。

复核新增 `remote/routes.ts` 精确属性合同、host-wide paced relay budget、durable native transition/lifecycle intents与firstUV renewal；engine/quiesce补已开始工作跟踪、强制后工具围栏与routine配置排空。`quiesce-engine.test.ts` 使用实际engine测15项确定性回归；远控套件实际传50MiB与并行1MiB、>1MiB快照、>70条历史吊销，运行约一分钟。新增集成测试 `bun test apps/daemon/src/remote/remote.test.ts` 启实际 relay、真实 Noise、临时 Store 与构造注入 native fixture；生成 WebAuthn Ed25519 密钥实签，测试回执/文件、吊销重连/备份拒绝、CAS与旧凭据、排空中回答与新消息不落库。根 `pnpm test`/`pnpm typecheck` 包含这些；完整验证再跑 messenger/relay/remote build、daemon compile、Cargo 与 Swift fixture。不得启动实际 native app/helper 或读个人 Keychain 来验证本票。浏览器仅用隔离 agent-browser rc07 与独占17907/5197 fixture，假模型、scheduler off；先查端口占用，结束只停自己的服务。独立运行时 UI 用隔离 session `rc10` 与独占随机端口，同样不装真实 LaunchAgent。

推送恢复、自动投递和测试通知共用过期清理：达到 120 秒绝对期限的 `pending` / `retry_wait` / `unknown` 转为 `expired`，释放每设备唯一发送位置；进程内仍在发送的 `claimed` 留给发送结果处理。测试遇到仍有效的投递返回 `409 push_pending`，拒绝不消耗新的测试限流额度。信使保留测试响应的 `error_code`，按当前语言解释等待、限流、订阅或联系人配置缺失；未知失败显示稳定错误码。回归覆盖 `remote/push.test.ts`、真实加密请求的 `remote/remote.test.ts` 以及信使通知设置和远程 API 测试。

手机推送的 `showNotification` 显式指定 `icon: /icon-192.png`（与 PWA manifest 共用）和 `badge: /notification-badge.png`。后者为 96×96 的透明底白色双圆标志，源文件是信使 `static/notification-badge.svg`；修改时用浏览器将 SVG 以 96×96 绘制到透明 canvas，再导出 PNG。Android 通知栏使用 badge 的透明轮廓，系统自行着色。图标随托管信使静态包发布，重新打开 PWA 更新 service worker 后供新通知使用；各手机系统的实际通知外观仍需真机确认。`remote/push-worker.test.ts` 执行真实 worker 的推送和点击处理器，验证图标路径、PNG 尺寸、载荷限制及回到会话列表的行为。

## 开发态远控闭环（仅源码态）

生产那条路径永远打不开：`remote-native.ts` 只在编译后的 `/$bunfs/` 里加载 dylib，且 `capability()` 固定答 `g_pack_not_verified`，controller 见到真 native 未启用就落 `activation_gated`；Tauri 的 `remote_local_setup` / `remote_native_confirmation` 只认 bundled main，dev 源也被拒。因此开发期要真跑协议，只能走这条显式开关的替身通道。

源码态 daemon 带 `REAL_BOT_DEV_REMOTE=1` 启动时，`remote/dev-setup.ts` 交出 `remote/dev-native.ts`：身份、enrollment、VAPID 与高水位存在数据目录 `dev-remote/credentials.json`（0600，原子写），`prepare`/`consume` 保持同样的一次性挑战、120 秒窗口与动作摘要比对，`describe`/`authenticate` 顶替 Touch ID 弹窗。同一开关把窗口那条 setup dispatcher 开在 `dev-remote/setup.sock`（0600；数据目录过长时退回 `$TMPDIR/real-bot-dev-remote-<hash>.sock`），协议帧与继承 FD3 完全一致，只多两个 `dev_describe` / `dev_authenticate` 操作。

设置面板里的远控卡也走这条开关：源码态时 daemon 在 `POST /v1/remote/setup` 上开放设备列表、移除和配对操作（`status` / `list_devices` / `prepare_remove_device` / `confirm_remove_device` / `open_pair` / `prepare_pair` / `confirm_pair` 与两个确认替身），改中继、重置身份仍然只在 unix socket 上；打包态同一张卡改走窗口的 `remote_local_setup` 与 Touch ID 确认，信使侧由 `remote/pairing-host.ts` 分流，卡片本身不关心是哪条。

配对内容用紧凑编码：`rb1` + base64url 打包的版本、两个 ULID、三个时间戳字段、配对密钥与两把主机公钥、中继 id，约 205 字符，原来那份 JSON 是 399 字节。中继地址不进编码——读它的设备本来就由那个 origin 提供服务，于是粘贴来的内容没法把设备指向别的中继。`parsePairingQr` 两种都收，早先复制走的 JSON 仍然能配上。

`bun apps/daemon/scripts/dev-remote.ts status | init | pair` 是它的驱动：`init --origin https://… --relay-id … --bootstrap-file <路径>`（bootstrap 只从文件读，不进 argv），`pair` 打印配对 JSON、轮询设备提交、显示设备名与完整指纹、按 y 才取 proof 并确认。

编译后的 daemon 拿不到这条路径（`devRemoteAllowed` 见到 `/$bunfs/` 直接 false），生产激活门与 Rust 侧一行未改。凭据在磁盘不在钥匙串、终端确认不是用户在场，所以 G-pack、L1、G-uv、G-push、S-rev 都不因为这条闭环而通过；它只用来在真机门之前把传输、配对、事件与文件路径跑通。
## 守护进程源码布局

`apps/daemon/src` 按职责分文件，两处按目录组织：

- `store/`：SQLite 与钥匙串的唯一入口。`index.ts` 是 `Store` 门面（开库、跑 `migrate.ts` 的补列补表、把各模块函数绑上库上下文暴露成方法）；`shared.ts` 放行类型、设置读写和跨域共用的查询原语；其余每个文件一个领域：`settings`（设置与旧单端点镜像）、`providers`（端点、名单、钉模型校验）、`bots`、`skills`、`routines`、`sessions`（会话、成员、删除 / 清空）、`messages`（消息、附件、回应）、`turns`（轮次、Stop、中断）、`approvals`（批准与 Always allow）、`spend`、`judgements`、`mcp`、`routing`（每轮模型选择、结果与 Bot 各自的经验）、`tasks`（工作目录：归属规则与目录命名）、`search`、`notifications`（收件箱、策略、投递）。模块函数一律 `fn(ctx, ...)`，模块之间只从 `shared` 或彼此按领域导入；给 `Store` 加能力时先放进对应模块，再在 `index.ts` 绑一行。**改库的规矩**：`Store` 先 `exec(SCHEMA_SQL)` 再跑 `migrateSchema`，而老库上每条 `CREATE TABLE IF NOT EXISTS` 都是空操作、其余语句照跑——所以 `SCHEMA_SQL` 里任何非建表语句都必须对**还在流通的最老库形状**成立，不是对紧挨着它上面那条 `CREATE TABLE` 成立。给已发布的表加列，列写进 `SCHEMA_SQL` 的建表语句 + `migrate.ts` 的 `ALTER TABLE`，**索引只进 `migrate.ts`**（`turn_route_decisions_chain`、`messages_task` 都是这么放的）；把索引写进 `SCHEMA_SQL` 会让守护进程在所有老库上启动即抛 `no such column`，而窗口只会说「连不上运行时」。同一时刻把改动前的 `SCHEMA_SQL` 存进 `src/store/fixtures/`，`store/migrate.test.ts` 会逐个打开它们；`bun test` 只开 `:memory:` 和这些 fixture，动了 `schema.ts` / `migrate.ts` 还要对真库跑一次 `pnpm --filter @real-bot/daemon check:db`。
- `prompts/`：`system.ts`（轮次 system 中英两套与人设 / 技能 / MCP 段拼装）、`judgement.ts`（判断 system）、`transcript-copy.ts`（补全失败与点名失败的转录文案）、`tool-schema.ts`（工具定义类型与中英本地化）、`tools/*.ts`（内置工具按文件、协作、人设与技能、日程、端点与 MCP 分组）、`builtin-tools.ts`（按模型可见顺序拼成 `TOOLS`；顺序由 `prompts-order.test.ts` 钉死）。`index.ts` 只做再导出，导入路径仍是 `./prompts`。
- 纯函数模块留在顶层：`route-decision.ts`（候选、评分、经验的正负与封顶）、`models.ts`、`mentions.ts`（引用回复补 `@`；解析本身在 `@real-bot/protocol`）、`context.ts`、`schedule.ts` 等；`turn-engine.ts` 是轮次回路，`local-api.ts` 是本机接口。`artifact-paths.ts` 做正文 linkify，路径像不像工作区文件由协议包判定。单独成行的 `附件：<路径>` 和转录里展示附件的那一行是同一种写法，算作交出文件：新消息会挂成附件；已经落库的旧消息由信使收成气泡下的附件卡片，那一行不再留在正文里。卡片或正文里点开的是图片（含 SVG）时，放大层铺满整个应用（`MessageImageLightbox`，`position: fixed`，盖住侧栏和底栏），从点中那张图的视口矩形过渡到居中的大图，收起时缩回原处；Esc、关闭或点空白收起，不打开产物预览、也不写进 URL。字节还在路上时，放大框先从那张小图的矩形长到居中的舞台（和最终大图同一块区域），框里画转圈；附件已知大小或传输回报了总量时进度条从 0 填到百分比并写出已传字节，否则进度条来回扫。文案和进度条等框长过缩略图才画出来，转圈从点击起就在，框底是实色，免得转圈和字节数压在转录上读不清。图片字节到达后再按原图比例收成最终尺寸。缩略图自己也在原位置转圈（附件芯片 36px、正文图片链接 72×54），不先换成文件图标。取字节走已有的 `onProgress`。系统开了「减少动态效果」时放大直接到位，转圈和扫动停住。混有非图片的一批、单个非图片、右键「打开相关文件树」和工作区里点开的文件仍走预览。附件卡片（含多文件文件夹）在用户与 Bot 气泡中共用 `--pane` 底色和 `--ink` 文字；行内附件缩略图使用 `--line-subtle`，图片放大层的遮罩使用混入透明度的 `--bg`，图片和加载框使用实色 `--pane`；按钮、文件名、失败提示和进度使用同一套主题令牌，亮暗主题切换时即时更新。`chat/image-theme.test.ts` 覆盖已打开的图片、加载、失败和缩略图底色，并在文件会话、私聊和群聊的真实消息气泡内检查单图与文件夹卡片的主题配色。这些图（缩略图、正文里的图、放大层、文件预览、流程图里的图，以及输入框里待发送的图）右键是「复制图片」：`Shell` 上的 `ImageCopy` 在捕获阶段接住带 `data-copy-image` 的 `img`，菜单调 `copyRenderedImage`，在同一次点击里把 `ClipboardItem` 交给剪贴板，像素以 PNG 写入。头像和图标没有这个标记。按住 ⌥ 右键不拦截，留给网页视图自己的菜单。消息菜单和窗格分割菜单都让开这张图。

## 手机宽度导航

680px 及以下由 `Shell.svelte` 组合 `MobileNavigation.svelte`，共享会话、工作区和设置三个主入口。设置根页显示底栏，分类详情和编辑页隐藏底栏；会话详情沿用顶部返回。`Sidebar.svelte` 的归档入口在搜索旁的工具菜单里（与日程图、花费、终端并列；手机仍叫终端，打开终端页），数量只在菜单内灰色显示，入口按钮上不再带点。顶栏由左侧功能入口按钮与通栏胶囊搜索条组成，搜索本身是整页进入（见下文「手机返回」），进入已归档视图后顶部提供专属导航页头与返回按钮；新建则是列表右下角的浮动 `+`（`.fab`，点开选「新建 Bot / 新建群」，分组标题里那两个 `+` 在手机上隐藏）。宽于 680px 的侧栏底部是带文字的「工作区 / 工具 / 设置」，不再是七个图标；工具菜单依次是日程、花费、新建终端，分隔线后是已归档会话。标题里的 `+` 仍在。手机底部导航保留。手机上这一列的左右边界统一：搜索框、分组标题、头像都从 16px 起；列表在手机宽度下隐藏滚动条。工作区通过 `requestCloseFromParent(afterClose)` 完成未保存确认后执行导航，取消时释放目标回调并保留草稿。配置仍使用已有设置和工作区 URL 状态。

### 手机模型配置

设置的模型服务在 ≤720px 使用端点卡片：默认模型由原生 `select` 选择，名单入口整行可点，连接和删除操作位于卡片底部。`ProviderForm.svelte` 的名单采用单层页面滚动，搜索始终可用；全选/取消只作用于当前筛选结果。价格、思考等级和擅长领域在手机上进入独立属性页，返回保留名单的搜索、选择与滚动位置；桌面继续行内展开。`SettingsModal.backFromProviderEditor` 统一处理顶部返回、Escape 和手机历史返回，优先退出属性页。底部显示自动保存状态，保存失败提供重试。

已有端点允许空启用名单和空默认模型。`planPatchProvider` 在草稿默认为空且确有修改时显式发送 `default_model: ""`，避免服务端把省略的字段补成第一个模型；无修改仍返回空 patch。启用首项后可回到端点卡片选择默认模型。组件回归覆盖搜索、筛选批量操作、手动添加、属性编辑、逐层返回、返回前保存和失败重试。

## 信使源码布局

`apps/messenger/src/lib` 按界面上的「面」分目录，每个目录放那一面的组件和只有它用的纯函数模块（测试与被测模块同目录）：

- `chat/`：`ChatStage.svelte` 是主栏的转录 + 回到底部按钮 + 作曲栏，滚动状态归它，因为发送、搜索跳转和内容变高都要动它；`Composer.svelte` 管输入框、`@` 补全、附件、引用条和发送 / 停止按钮，草稿只写 `runtime.draft`，外面要落光标就调它导出的 `focus()`；`ChatHeader.svelte` 是会话顶栏。模块有转录分组与时间文案、批准卡判定、作曲栏形态与输入法状态机、`@` 芯片与候选、引用回复、快捷提示词、滚动计算。
- `notifications/`：系统通知与远程推送的策略、有界已读、提问状态和标签页连接协调。应用内不另开通知页：待批准、待回答、未完成和中断标在会话列表上；点击系统通知或推送回到对应会话，泛化待办推送回到会话列表。
- `sidebar/`：`Sidebar.svelte` 是整条侧栏（名册行、搜索入口与手机上的搜索整页、会话分组、归档视图、手机上的浮动新建按钮、桌面底部「工作区 / 工具 / 设置」和手机搜索旁的工具菜单）。外观不在底栏，在设置「偏好」里。两张新建弹窗和右键菜单也在这里。模块有会话分组 / 状态 / 标题、未读、搜索跳转、置顶、宽度。
- `panels/`：会话设置抽屉的两片 —— `ProfilePane.svelte`（人设与技能，自己管草稿与自动保存）和 `GroupPane.svelte`（成员、拉人）。群名不在卡片里：`GroupIdentity.svelte` 画在抽屉头部，和头像同一行，离开输入框或按 Enter 即保存。抽屉外壳还在 `Shell.svelte`；桌面工作台里同一个外壳（`.sheet.session-settings.is-beside`）是在会话窗格里滑出的侧栏，由 `Shell.svelte` 的 `paneSettings` snippet 画，头部和抽屉共用 `settingsHead`。
- `settings/`：`SettingsModal.svelte` 同时渲染设置弹窗和叠在它上面的端点编辑浮层（两个根元素，都还是 `.shell` 的直接子节点）。工作区、端点和 MCP 名称 / 备注改完即写入；模块有端点表单、MCP 表单与列表、向导保存、工作区选择。
- `overlays/`：产物预览、工作区浏览、流程图、终端、危险动作确认框，以及 Monaco / 产物树这些模块。模型选择记录没有自己的面：它挂在流程图的卡片上（`TraceView.svelte` 里的一行和展开块），`route-log.ts` 把卡片带的记录、复盘和经验换成文字，`task-trace.ts` 的 `routeHighlightCounts` / `highlightOf` 管工具条上「有反馈」「归咎模型」的点亮，见 [ADR 0026](adr/0026-model-choice-on-the-flow-board.md)。**这里的面多数是一对**：`XView.svelte` 只有内容、填满放它的地方（桌面端由窗格装），`XOverlay` / 原名那个组件是窄屏那套壳（遮罩、固定定位、滑入、✕）。View 里不许有 `position: fixed`、遮罩、`pageSlide`、680px 断点或 `phone` / `mode` 这类「我在哪个宿主」的 prop —— 由 `workbench/pane-content-drift.test.ts` 读源码强制执行。
- `annotations/`：产物批注。`client.ts` 是本机与远控两个客户端共用的接口调用；`model.ts` 是纯逻辑（按文件 / 按消息 / 按去向归批、筛选、状态与陈旧文案、「挂到谁」、能不能加批注）；每种锚点一个适配器（`text-range.ts` 配 Monaco，`markdown-anchor.ts` 划渲染态，`region-box.ts` 是图片和 PDF 共用的框选几何与裁图编码，`image-region.ts`、`pdf-region.ts`、`html-picker.ts`、`media-time.ts`），界面是 `AnnotationList`（预览里的本文件批注）、`AnnotationSendBar`（发送条）、`AnnotationComposer`（写一句意见）和 `AnnotationCards`（转录里的卡片）；每种预览自带画锚点的组件 `MarkdownAnnotator`、`ImageAnnotator`、`HtmlAnnotator`、`MediaAnnotator`，PDF 是 `overlays/PdfViewer.svelte`，它们对 `ArtifactPreview` 是同一套接口（`annotations` / `focusId` + `focusSeq` / `active` / `enabled` / `onDraft` / `onPick` / `pending` / `onPendingChange` / `onCancel`）。`focusSeq` 每次「去这条」都加一，同一条再点一次也要重新定位；Escape 由它们在 document 上先接住：有待写的位置先取消，其次退出批注模式，都没有才放给面板去关。草稿存的是选位置那一刻的路径、哈希和挂靠的消息，保存时文件变了或有未保存修改就拒绝。pdf.js 只在打开 PDF 时才动态加载（`overlays/pdfjs.ts`，legacy 构建，worker 由 Vite 打成本地文件）；CMap 和标准字体由 `vite.config.ts` 的 `pdfjsData()` 做成按需 import 的模块交给 worker，所以两份 CSP 都不用放开 `connect-src 'self'` 或 WebAssembly，`vite.visual.config.ts` 要带上同一个插件。HTML 选取器在批注模式下注入页面，带页面脚本同一个 CSP nonce；远控托管版只按哈希放行脚本，选取器在那里跑不起来，界面会提示改用源码视图。批注在快照的 `annotations` 里：选中会话时按会话拉、打开文件时按文件拉，之后跟 `annotation.upsert` / `annotation.removed` 走；会话清空或删除时一起丢。
- `workbench/`：桌面端的窗格布局。`layout-types` / `layout-tree`（分割、关闭、规范化、不变量）、`layout-geometry`（尺寸分配、分隔条与交汇点、方向导航）、`layout-resize`（单轴与两轴拖拽）、`float-frame`（浮动窗格的帧，全仓库唯一一份）、`drop-zones` / `tab-drag`（落点与拖放）、`workbench-layout`（localStorage 持久化与自愈）、`workbench-commands`（键盘与菜单；`SPLIT_TOWARDS` 是四个分割方向对应的轴和先后）、`PaneContextMenu`（窗格右键菜单：窗格里任意位置的右键都接，除非里层已经 `preventDefault` 了——消息菜单、Monaco 都这么做，所以它们自己的菜单照开；输入框和 contenteditable 留给原生菜单，xterm 的隐藏 textarea 不算；⌥ 右键放行给网页视图）、`pane-content` / `pane-open`（标签与应用概念的换算、打开的规矩）、`surface`（宽窄的门）。**布局引擎不 import 任何内容组件**，标签内容经 Snippet 传进来 —— 所以 Monaco 和 xterm 不进这个模块图。`PaneContentHost.svelte` 是唯一同时认识「标签种类」和「哪个组件画它」的地方。拖动分隔条或交汇点时，这条分支上每一块窗格的轨道都跟着指针改，内容铺满新的一份，不把内容冻在按下时的像素尺寸上——那个最小宽度会让旁边的窗格让不出空间，看起来就像只在挪当前这一块。浮动窗格的移动用 `transform`，拉角缩放用组件内的临时帧，都是松手才 `onLayout`，也才写入 `localStorage`。终端 `fit`、Monaco `layout`、转录贴底和索引测量、预览宽度、流程图卡片测量走 `deferWhileDragging`：`dragGate` 抬着时先记下，落下时跑一次。不要在窗格上加常驻 `contain`，`position: fixed` 的菜单会改坐标系。
- 跨面共用的留在 `lib/` 顶层：`copy.ts`（中英文案树）、`api.ts` / `runtime.svelte.ts` / `snapshot.ts`（本机接口与快照）、`theme.ts`、`avatar.ts`（含 `avatarSrc` 与 `botAvatarColor`）、`markdown.ts`、`MarkdownBody.svelte`（聊天气泡与产物预览共用的 markdown 渲染，样式写在组件里）、`discovery.ts`、着色相关，以及 `Shell.svelte`、`Onboarding.svelte`、`Select.svelte`、`SessionAvatar.svelte`、`AvatarEditor.svelte`。会话在场 Bot 名单是 `sidebar/session-groups.ts` 的 `presentBotIds`；点名解析走 `@real-bot/protocol` 的 `parseMentions`，芯片 DOM 仍在 `chat/mention-chips.ts`。
- `styles/`：**只剩没有任何一个组件能认领的规则**，1052 条里的 134 条；其余都回到了渲染那个元素的组件里（见下面「信使样式分层」）。每个文件的头注释写明它为什么搬不动：
  - `tokens.css` 配色令牌与暗色覆盖，`base.css` reset —— 全局底座。
  - `shared.css` 不止一个面会往自己元素上挂的 class（`.field-error`、`.avatar-img`、`.btn-chip`、`.sheet-close`、`.row-avatar`、`.avatar-status-dot`）。只放这个东西本身和它的通用状态。**动它会波及每个面。**
  - `drawers.css` 会话设置抽屉的外壳、`panels.css` 两个抽屉面共用的家具、`modals.css` 所有对话框共用的框。里面装什么是各自组件的事。
  - `code-highlight.css` Shiki 写进三处不同表面的 `.tok`、`third-party.css` Monaco 挂到 `document.body` 上的浮层 —— 都没有可作用域化的宿主。
  - `responsive.css` 只有 680px 那一条跨面断点；**它排在 `index.css` 最后**，因为它的活就是覆盖上面的面。各个面自己的响应式写在各自组件里。
  - 会话的手机布局看会话自己的宽度，不看窗口：`Shell.svelte` 的 `.main` 和 `PaneContentHost.svelte` 的 `.pane-conversation` 是名为 `conversation` 的 inline-size 容器，`ChatHeader` / `ChatStage` / `Composer` / `MessageIndex` 的版面规则写成 `@container conversation (max-width: 680px)`，宽窗口里窄于 680px 的窗格也用手机布局。只跟触屏有关的（长按不选字、藏起悬停按钮条）和手机的返回导航仍是 `@media`。容器只是尺寸查询，不像 `contain` 那样把 `fixed` 浮层的坐标系改到窗格上（窗格为什么不能有 `contain` 见 `WorkbenchLeaf.svelte`）。`MarkdownBody` 也在没有会话的地方渲染，所以两种都写。happy-dom 算不出容器查询，这些规则由 `tests/visual/narrow-conversation.spec.ts` 在 Chromium 和 WebKit 里测。窗格里的 `ChatHeader` 带 `foldsIntoTab`，到了这个断点整条收起，交给标签：`chat/ChatTabLabel.svelte` 画名字和头像，头像带 `wb-tab-icon`，只在 `WorkbenchLeaf` 的 `@container wb-strip (max-width: 680px)` 里显示。其他种类的标签由 `workbench/PaneTabLabel.svelte` 画：按 `PaneKind` 在名字前放一个 14px 图标（和打开它的入口同一个图标），同样标 `wb-tab-icon`，跟会话头像在同一个断点出现。标签栏 `.wb-strip` 自己是 inline-size 容器，而且没有内边距（两侧 4px 落在首尾子元素的 margin 上）：容器查询量的是内容盒，有内边距它就比 `.pane-conversation` 窄几像素，会出现顶栏还在、标签已经带上头像的一段。标签能做什么由宿主给：`Workbench` 的 `tabActions(leafId, tab)` 返回 `TabAction[]`，窄窗格里标签上的 ⋯ 和任何宽度下标签的右键都用 `PaneContextMenu` 列出来，⋯ 那份不带分割。
  - `styles-coverage.test.ts` 会在全局表里有样式没人用时失败。它认得 `class="tab is-{kind}"` 这种插值（记下 `is-` 前缀），第三方 DOM 有一张写明理由的白名单。**两个提取上的坑都踩过**：引号正则若允许跨行，英文文案里的撇号会让它吞进无关代码，那堆残骸里的每个词都算「有人用」；规则上方的注释若不剥掉，会变成选择器的一部分，于是**带段落注释的规则从来没被检查过**。`.detail` 整族死样式就是这么活下来的。

打开的是哪个会话记在 URL 的 `?s=<id>` 上，打开的产物预览记在 `?p=<relpath>` 上，设置 / 会话抽屉 / 工作区 / 轨迹 / 日程图浮层共用 `?o=`（`session-url.ts`，日程图是 `?o=routines`），刷新、热更新和后退键都回到同一处。用查询参数而不是路径，是因为打包后的 Tauri 窗通过资源协议直接服务 `build/`，没有 SPA 回退：`/s/<id>` 一刷新就是 404，而 `index.html?s=<id>&p=<relpath>&o=settings` 永远是磁盘上那个文件。`+page.svelte` 里会话、预览和浮层各有 URL→运行时的 effect，一条写回 URL；各自只跟踪自己那一侧（都跟踪就会互相覆盖）。URL 里的会话 id 在会话列表到达前不动它，`connect()` 拿到列表后会把不存在的 id 清掉。预览路径和工作区开关挂在 `MessengerRuntime` 上、不跟 `Shell` 走：断线那一屏卸掉 `Shell` 再连上时还在。非法预览路径（空、绝对路径、`..` 逃出工作区）当没打开。抽屉要等快照里真有那个会话 / Bot 才打开，避免闪一下错误的面板。模型选择记录、新建弹窗和确认框不进 URL。

`Shell.svelte` 只剩三栏骨架：把上面这些面摆好、按固定优先级处理 Escape（工具菜单 → 危险确认 → 新建 Bot → 新建群 → 端点浮层 → 设置 → 人设 → 会话设置 → 路由日志 → 工作区 → 产物预览）、持有哪一层浮层开着的标志，以及会话右键菜单。跨面的窗口级监听只有 Escape 这一条留在这里；点击外部关闭没有优先级，各自在自己的组件里用 `click-outside.ts` 的 `isOutside`。

桌面工作台里一条会话的流程图标签固定叫「<会话名>流程」，产物预览标签固定叫「<会话名>的产物」（`Shell.svelte` 的 `paneTitle`，文案在 `copy.ts` 的 `pane.flowOf` / `pane.artifactsOf`）。名字跟会话标题走，换文件、换这件事都不改标签；会话不在了就用「已删除」。产物标签通过 `workbench/pane-content.ts` 保存来源会话、消息、任务、强制显示树标志和附件列表；`preview-context.ts` 从来源消息补齐交付路径，历史尚未载入时使用保存的列表。`PaneContentHost.svelte` 将这些上下文传给产物预览，文件树内的选择更新当前标签参数，保留原消息和任务范围。会话的设置不占标签：它是会话标签参数里的 `side`（`settings`，可带 `botId`），`PaneContentHost.svelte` 把它画成从对话右侧滑出、垫着遮罩的侧栏（遮罩只盖这块窗格，点它收起，走 `backdropClick`）；群里点开的 Bot 直接是它的设置，私聊的 Bot 在 `Shell.svelte` 的 `ownSettings` 里记成这条会话自己的设置；`pane-open.ts` 的 `toggleChatSide` / `closeChatSide` 开关它，`openChat` 保证设置全窗只在一条会话上。流程图窗格经 `runtime.watchTrace` 登记它正看着的那件事，这件事有新的轮次或消息就重读，和窄屏浮层同一个 `traceReload`。会话窗格读自己那条会话的 `runtime.sessionView(id)`（草稿、回复、附件、芯片、发送中、高亮、历史游标都在 `session-view.svelte.ts` 的 `SessionView` 上），不读 runtime 上转到「选中那条」的同名字段；`send` / `stopTurn` / `continueInterrupt` / `resolveApproval` / `sendAsk` / `loadOlderMessages` / `setHighlightedMessage` 都带会话 id。测试里的 `fakeRuntime` 同样按会话建 `SessionView`，旧字段转到选中那条。终端标签就是一条会话：`TerminalView` 的 `tabIds` 是 `[id]`（桌面标签，没有会话条）或 `'all'`（`TerminalPane` 那一页，全部会话当标签）；`Shell.svelte` 的 `openNewTerminal` 先经 `runtime.startTerminal` 起好 shell、放进 `runtime.terminals`，再开绑好的标签，「＋」打开固定宽度的菜单（挂到 `document.body`，避免被窗格裁切、也被浮动窗格的 transform 改掉坐标系）：新终端、工作区、日程在上面，没被任何标签摆出来的会话在「还在跑的终端」里按名字和路径往下排，超出就在菜单里滚动，输入框按名字或路径筛；空窗格仍横着排同一批入口；`terminals.ts` 的 `terminalNames` 给同名会话按先后编号。标签同时记下它打开时的目录。会话不在快照里，窗连上就 `refreshTerminals()`；`runtime.terminalsLoaded` 之前自愈不按终端判死活。预览和流程图按会话各只有一块（`pane-open.ts` 的 `ONE_PER_SESSION`）：同一会话再打开别的文件或别的那件事，`openContent` 把已有的那块标签改指过去而不是另开；流程图自己切换任务时经 `onTask` 写回标签参数，外面改了 `taskId` 它也会跟着读。改指一块有未保存编辑的预览前，`Shell.svelte` 的 `openGuarded` 先调用它的 `requestLeaveFromParent`。旧布局里的重复由 `dropDuplicateBoundTabs` 在自愈时收掉。产物面板使用父容器的完整高度，文件树网格行采用 `minmax(0, 1fr)`，长列表在树内滚动。回归测试从消息附件入口实际点击打开并切换文件，另覆盖标签恢复、旧路径标签和关联文件入口。

共用 `DangerDialog.svelte` 用原生 `dialog.showModal()` 隔离背景（含已有资料/技能/端点浮层），在组件内处理 Tab/Shift+Tab 和 Escape，不加全局键盘或 inert DOM 补丁。取消/卸载后归还仍存在的触发控件；busy 时焦点停在对话框，拒绝取消与重复确认。Shell 每个确认对象拥有自己的 running 状态，重复提交只拦截同一对象；事件先移除旧确认时，新确认可独立执行。所有异步完成后的清理/错误反馈校验确切确认身份；技能/记忆回调使用 `isCurrent`，不能按种类清除替代确认。触摸按钮至少 44×44px。

空窗格右上角的 × 与窗格右键菜单的「关闭窗格」共用 `Workbench.onClosePane`，由 `Shell.onPaneClose` 检查当前窗格的工作区和产物预览是否有未保存编辑，确认后调用 `closeLeaf` 并持久化布局。原生菜单的关闭窗格命令也经过同一入口。关闭会移走整块窗格及其标签，终端仍由守护进程持有；最后一块平铺窗格关闭后保留一个空窗格。`trackTemplate` 的最小轨道使用 CSS `min` / `calc`，窗口小于内容最小尺寸之和时按最小尺寸比例收缩，与 `allocate` 一致，保持边缘关闭按钮可见。回归见 `workbench/pane-close.test.ts` 与 `layout-geometry.test.ts`。

## 日程编辑与版本

日程搜索同时检查快照日程与当前 Bot 名册。软删除 Bot 保留历史日程，结果标为不可用而不是静默关闭。资料导航序号覆盖后来日程/资料、会话设置、关闭和 URL 浮层变化，较早详情返回不能重开旧编辑器或丢弃新草稿。

Bot 资料中的 `RoutineCard.svelte` 读取 `snapshot.routines`，只提供现有每天/每周与 `HH:MM` 字段，归属固定为当前 Bot。时间按执行 Mac 的本地日历解释，不提供浏览器时区转换或新 cron 语法；使用步骤见 [日程说明](routines.zh.md)。680px 及以下，编辑是盖在资料上的整页（`.routine-page`，`pageSlide`），列表只留钟点和标题；返回由 `RoutineCard.backFromEditor` 经 `ProfilePane.backFromEditor` 交给 Shell 的 Back / Escape，先于关闭资料。保存中这一页不关闭。宽屏仍把表单展开在卡片里。

名册日程图（`?o=routines`，`calendar/RoutineCalendar.svelte`）把同一份快照投影到 `svelte5plus-calendar@0.5.5` 的周视图上，只读。在桌面窗格里它用 `height: 100%` 铺满窗格（窗格主体不是 flex 容器，只写 `flex: 1` 会让 24 小时格子按内容撑高、被窗格裁掉），时间轴在窗格内滚动，窗口和分隔条改变尺寸时格子跟着变。议程不走库自带的那一列（它不渲染 `eventContent`），由 `RoutineCalendar` 自己列出头像和名字。格子由 `project-routines.ts` 按库回调的闭区间展开，不设 `recurrence`，也不 `bind:events`。名册筛选是可搜索下拉（名字或职责），只列出至少有一条日程的 Bot；没有日程的不进这张图，当前范围内没有格子的 Bot 仍留在下拉里。窄屏用 `has-routines` 显示主栏；打开时清掉 `?p=`。组件测试经 `calendar-entry.ts` 用相对路径引进库，因为包的导出只有 `svelte` 条件，bun 解析不到。

`LocalApi.createRoutine` / `patchRoutine` / `deleteRoutine` 经 runtime 捕获当前 API 实例调用；HTTP 返回行不写入快照，只有 `routine.upsert` / `routine.removed` 和重连快照更新列表。编辑草稿或删除确认保留当时的 `updated_at`；PATCH 和 DELETE JSON 体传 `if_revision`，不匹配返回 `409 revision_conflict`，格式错误返回 422，已删除返回 404。旧本机调用可省略该字段；注入 `requireRevision: true` 时日程 PATCH/DELETE 均不可省略。请求体先参与回执摘要，日程版本字段保留至 Store，在业务+回执的同一外层事务中仅比较一次，不先被通用 PATCH 检查剥离。Store 使日程 `updated_at` 至少递增一毫秒（含 scheduler claim）；不另包一套 Store 事务。未修改的表单跟随实时更新，有修改的表单保留草稿并要求显式载入最新版，连接变化不会自动重试写入。网络结果未知时沿用 `LocalApi` 待确认请求与原始 id，只允许显式重试同一载荷；不得为了显示日程错误丢弃该 API 实例。成功或终态回执只清理对应请求，不合成快照行。日程错误按 code 区分 `request_unknown` / `request_pending` 与 `revision_conflict`；卡片中的“重试原请求”调用既有 `runtime.retryPendingMutation` → `LocalApi.retryPending`，不重建载荷或 id。该 runtime 方法返回 `ApiError | null`，使卡片保留重试收到的真实终态错误。重试明确说明不会发送后来修改的草稿，待确认退休后保留草稿并禁用提交，用户核对列表/重新打开后继续；不把原请求成功说成后来草稿已保存。

批注的界面验证有一套现成的隔离夹具：`bun apps/daemon/scripts/fake-openai.ts`（`127.0.0.1:17917`，脚本化的 OpenAI 兼容端点：判断类非流式请求一律答 `{}`，带批注的触发消息答成逐条 `resolve_annotation`，工具结果之后答一句收尾；`POST /__next` 可以塞一条指定回复，`GET /__log` 看它收到了什么），和 `REAL_BOT_DATA_DIR=<一次性目录> bun apps/daemon/scripts/ui-fixture.ts`（`127.0.0.1:17907`、内存钥匙串、`schedule: false`，工作区里放好代码、Markdown、HTML、PDF 和用 ffmpeg 生成的图片 / 视频 / 音频，Writer 在你的私聊里一次交出，Editor 在一条 Bot↔Bot 私聊里交出 `notes.md`）。信使用同一个 `REAL_BOT_DATA_DIR` 起在别的端口：`cd apps/messenger && REAL_BOT_DATA_DIR=<同一目录> pnpm exec vite dev --port 5197 --strictPort`。开跑前先 `lsof` 看端口，结束只停自己起的进程。

隔离 UI fixture 除 `schedule: false` 停定时 ticker 外，还须禁用注入 engine 的 `fireRoutine`：创建/修改 HTTP 路由会立即询问日程是否到期。fake keystore、fake completions 与独立端口/数据目录仍全部必需。

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
DUMP_STORY=group-pane DUMP_OUT=/tmp/before.txt pnpm exec playwright test dump
# 改动之后再跑一次到 after.txt，然后 diff
```

它把整棵子树的 `getBoundingClientRect()` 和三十来项计算样式写成文本，错位的那一行会自己跳出来。没设 `DUMP_STORY` 时自动跳过。路由日志那条少配的 `line-height`、Onboarding 那个丢了 `:global` 的按钮，都是这么找到的 —— 两次手工挨个量属性都看着正常。

还有一条基线兜不住的：应用跑在 WKWebView，基线拍的是 Chromium。`-webkit-backdrop-filter`、`-webkit-line-clamp`、`::-webkit-scrollbar` 这些前缀属性在搬运中丢了，Chromium 的截图不会有任何反应，只能靠读 diff 保证它们跟着搬过去了。

## 信使组件测试

和纯函数用同一个 `bun test`：`apps/messenger/test-setup.ts` 里一个 Bun loader 在 import 时用 `svelte/compiler` 编译 `.svelte`（`.svelte.ts` 走 `compileModule`），happy-dom 提供 document。`bunfig.toml` 预加载它，`package.json` 的 `test` 脚本带 `--conditions browser` —— 少了它 Svelte 会解析到服务端构建，`mount()` 直接报 `lifecycle_function_unavailable`。

独立 worktree 跑组件测试时，Bun 的内容缓存可能复用另一工作区里相同日历组件的编译结果，带入旧目录的相对依赖。`test-setup.ts` 将日历组件编译后的相对导入固定到当前依赖目录，保证它与测试共用同一份 Svelte 运行时；无需改动其他工作区的依赖或清全局缓存。

写测试用 `src/lib/test-render.ts`：`render()` 挂载并 `flushSync`，`click` / `fill` / `press` 每次交互后也 `flushSync`（Svelte 5 批量更新，不刷新就断言不到）。假数据在 `src/lib/test-fixtures.ts`（`aBot` / `aDirect` / `aGroup` / `aSkill` / `fakeRuntime`，`fakeRuntime().calls` 记下组件调了运行时的哪些方法）。要让绑定的 prop 真的引起重渲染，用 `test-reactive.svelte.ts` 的 `reactive()` 包一层，普通对象写得进去但不会触发更新。

覆盖的是拆分留下的接缝，不是重测已有的纯函数：确认框的四条关闭路径、新建群弹窗「重新挂载即重置」、群组面板那份**属于外壳**的草稿（关掉再打开仍在，这是有意为之）、人设面板的自动保存与**卸载时把待发的改动冲出去**、设置弹窗和工作区 / 端点 / MCP 名称备注的自动保存、作曲栏的 Enter / Shift+Enter / 输入法选词与上屏后那一下的接线。

## 信使视觉基线

`pnpm --filter @real-bot/messenger test:visual`。改样式前后各跑一次；基线要改就 `test:visual:update`，并在 PR 里说明为什么该变。

同一命令还跑 `tests/visual/markdown.spec.ts`：在 Chromium 和 WebKit 里渲染 Markdown，检查格式保留、脚本类内容被清掉。`bun test` 用的 happy-dom 里 DOMPurify 的标签遍历不工作（标签名读出来是空串），单元测试看不出净化器在真浏览器里做了什么——改 `markdown.ts` 的净化规则后必须跑它。

拍的是**单个面**，不是整个应用：`tests/visual/stories.ts` 用 `test-fixtures.ts` 的假数据把一个组件挂到 `tests/visual/index.html` 上，Playwright 按 `?story=<名字>&theme=dark|light` 逐张截。不连守护进程、不读数据库，所以基线只会因为样式变而变。新增一个面：在 `story-list.ts` 里加尺寸，在 `stories.ts` 里加组件和 props；面自己藏着的状态（比如设置弹窗开在哪个页签）用 `afterMount` 像人一样点出来，不为了拍照给组件加 prop。`shell` 那张把整个三栏框架连同侧栏、主栏、顶栏一起拍下来 —— 跨组件的规则只有它看得见。

**截图之外还断言这一面挂载时没有报错**（`pageerror` 和 `console.error` 都算）。报错的面照样会画出点东西，那张残骸拍成基线一样会「通过」；代码块复制图标那条少写半径的 SVG 弧线就是这么找出来的。

三个坑，都踩过：

- **story 的 Vite root 必须是包根**。指到 `tests/visual` 的话，`src/lib/styles/*.css` 在 root 之外、又是经 CSS `@import` 拉进来的，Vite 不监视它们 —— 基线会对着服务器启动那一刻的 CSS 拍，改了样式也照样全绿。一个不会失败的检查比没有检查更糟。
- **阈值用 `maxDiffPixels`，不要用比例**。这台机器上同一个 story 连拍两次是逐像素相同的，所以预算只需要吃掉将来的抗锯齿抖动。比例预算试过：900×520 的图上 0.2% 是 936 像素，而把弹窗圆角从 18px 改成 2px 只差 212 像素，照样通过。

- **`vite.visual.config.ts` 要跟着 `vite.config.ts` 走。** 少了 Monaco 的两条 alias，产物预览那条 import 链就是 500，而它会连坐**整张模块图** —— 所有 story 一起白屏，不只是用到编辑器的那个。

假数据要对得上协议类型，否则拍的是另一个渲染分支：`test-fixtures.ts` 一度把用户写成 `"you"`，而 `USER_MEMBER` 是 `"user"`，于是每个面都把用户画成「已删除」的 Bot，基线把这个错误一起存了下来。story 的 props 是 `as never` 进去的，TypeScript 不替你挡这一层。

不接 CI：这是系统字体的渲染，Linux runner 会对每一张都有异议。和 CONTRIBUTING 里「本机 UI 验证不能由 CI 代替」是同一条理由。

## 原生远控凭据接口（默认禁用）

应用发布包（含默认必需 daemon）最低要求 macOS 13.0，Tauri 元数据与打包检查一致。`apps/runtime-helper` 是 Swift 6/macOS 13+ helper、`libRemoteCredentials.dylib` 与 `real-bot-pty`。`pnpm --filter @real-bot/desktop build:native` 编译并打包三者和独立 daemon；Tauri 发布构建会自动执行。源码/ad-hoc 构建不能访问远控 Keychain 或跳过本机认证；`--remote-native-capability` 在开库/监听前返回脱敏禁用原因。协议、daemon 导出、Tauri `remote_native_confirmation` 桥、共享组与吊销高水位的恢复顺序见 [native credentials](native-credentials.md)。不新增 HTTP 维护路由，也不改变默认窗监督/登录项。

终端的 pty 单独一个 product：`swift build --package-path apps/runtime-helper --product real-bot-pty`。开发态不必先跑 `build:native`，`apps/daemon/src/pty.ts` 会去 `.build/{release,debug}/` 找它；`REAL_BOT_PTY_HELPER` 可指定别处。它不带钥匙串访问组——开 shell 这件事你在 Terminal.app 里本来就能做，没有可提升的权限，所以它是独立 product 而不是凭据 helper 的一个子命令。控制终端只能在 fork 和 exec 之间用 `ioctl(TIOCSCTTY)` 拿到，`posix_spawn` 没有那个接缝，所以这一小块必须是原生的；两条路线的实测对照留在 `.scratch/terminal/prototypes/`。

终端 shell 的环境不整份继承守护进程：`apps/daemon/src/terminal-env.ts` 只放行 `PATH`、`HOME`、`USER`、`LOGNAME`、`TMPDIR`、`SSH_AUTH_SOCK`、`__CF_USER_TEXT_ENCODING`、`LANG`、`LC_ALL`、`LC_CTYPE`，再设 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Deskfolk`；两者都没有 `LANG`/`LC_ALL` 时按 `defaults read -g AppleLocale` 推（`/usr/share/locale` 里没有那一份就用 `en_US.UTF-8`）。zsh 会话的 `ZDOTDIR` 指向数据目录下的 `shell-integration/zsh/`，那里只有守护进程写的一个 `.zshenv`：先把用户自己的 `ZDOTDIR` 放回去（原来就有的经 `REAL_BOT_ZSH_ZDOTDIR` 传进来），source 用户的 `.zshenv`，再挂一个 precmd 钩子发 OSC 7，其余启动文件都是用户自己的。守护进程在 `terminal-cwd.ts` 里从输出流读 OSC 7，更新会话的 `cwd` / `title`，目录没变不发事件。前端 xterm 装了 WebGL、Unicode 11、链接和查找四个插件；Mac 键位与 ⌘ 快捷键在 `overlays/terminal-keys.ts`，配色在 `terminal-theme.ts`，字号在 `terminal-font.svelte.ts`；右键菜单里的复制 / 粘贴走 `workbench/pane-edit.ts`，粘贴在窗口里经 Tauri 命令 `read_clipboard_text` 读系统剪贴板（WebKit 的 `readText` 要多点一次确认）。pty 的行列跟最近接回或敲键的那个窗格走。每条会话的屏幕在守护进程里（`apps/daemon/src/terminal-screen.ts`）：一个 `@xterm/headless`（Unicode 11 字宽，和窗格一致）吃流里的每个字节，窗格接回时 `GET /v1/terminals/:id/screen` 拿它 `@xterm/addon-serialize` 出来的快照和对应的流偏移，再从那个偏移接实时字节；序列化漏掉的隐藏光标、鼠标编码、滚动区域和程序改过的光标形状由守护进程补在后面；它还在进入备用屏之前补一个 SGR 复位，因为序列化器在普通屏末尾写的是全局的当前画笔（全屏程序的），再按"画笔是默认的"去写备用屏，不补的话 vim 的正文会染成它最后画 `~` 的颜色。程序的查询（DA、DSR、DECRQM、DECRQSS、颜色）只由它回答，窗格一律不答（`overlays/terminal-requests.ts`）；颜色查询用最近接上的窗格经 `POST …/colors` 报上来的配色。⌘K 同时 `POST …/clear`。快照超过 640 KiB（远程单条消息的上限内）就少带历史；输出快到解析落后 4 MiB 时先停，平静下来再用流里剩下的原始字节重建。持久化存的是序列化后的屏幕。对还没有 `/screen` 的守护进程，窗格退回旧法：重放原始字节，重放期间不回答其中的查询。守护进程恢复一条会话时，在旧屏幕后面补 `restoredScreenEnd`（`terminals.ts`）：DECSTR 软复位、关鼠标报告、复位光标形状与样式、换行；只有旧屏幕停在备用屏里才发 `?1049l`，因为它会恢复提示符自己存过的光标。

Swift 验证用 `swift build --package-path apps/runtime-helper` 与 `swift run --package-path apps/runtime-helper RemoteCoreTests`。后者是兼容仅安装 Command Line Tools（没有 XCTest）的原生 fixture 测试，不调用个人钥匙串或 LA，也不启动登录任务。格式检查用 `xcrun swift-format lint --strict --recursive apps/runtime-helper/Sources apps/runtime-helper/Tests`。真实签名/共享 entitlement/退出窗后无提示自读属于尚未运行的 G-pack；stock Bun 的 `BUN_BE_BUN` 解释器与 `BUN_OPTIONS --preload/--config` 入口是授予凭据前必须解决的实现前置条件，不只是缺证书，不能加 entitlement 冒充解决。自动配置加载关闭不封闭这些入口；macOS desktop 测试用独立 print-only fixture 验证 stock Bun 仍不合格。

本机确认桥在开发/debug模式全禁用（含只读 capability），发布态还验证实际 bundled main 文档与 Tauri 按发送 frame 解析的 ACL；`local:true` 本身不排除 devUrl。确认返回认证/存储后剩余整秒 `expiresIn:1..60`，小于1秒拒绝。CI与release验证显式运行 Swift fixture 和 Cargo IPC/origin测试；PR CI 的 macOS 任务另跑 desktop script tests，确保 Linux 跳过的 stock Bun 不合格回归实际执行。根类型检查包含 desktop 的全部 `scripts/**/*.ts`（使用锁定的 Bun 类型），不是空项目。不启动真实helper/窗口、LA或个人Keychain。包构建后可用 `bun apps/desktop/scripts/native-package.ts '<Deskfolk.app路径>'` 检查外层minimum与全部必需Mach-O产物。

## 本机工具链

- Node `>=22` 与 pnpm `12.3.4`（`packageManager`）
- Bun `>=1.2`（守护进程，不当 npm 依赖）
- Rust / Cargo（Tauri 2）

## 命令

```bash
pnpm install
pnpm dev        # 并行守护进程 + tauri dev（信使由窗拉起）
pnpm test       # remote（含 Rust snow）/ relay / protocol / daemon / messenger / desktop / landing
pnpm typecheck  # remote / relay / protocol / daemon / desktop scripts tsc；信使与落地页 svelte-check；不跑 cargo check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml  # 桌面监督与线程锁回归
pnpm --filter @real-bot/daemon check:db   # 用当前代码打开本机真库的副本（改过 schema/migrate 必跑）
pnpm --filter @real-bot/messenger build
pnpm --filter @real-bot/landing build   # 可选；GitHub Pages 构建落地页
```

开发态修改信使代码走 Vite 热更新。`beforeDevCommand` 拉信使时，若 `http://localhost:5173` 已是本包开发服务器（含上次留下的孤儿 Vite），会直接复用，不再因 `strictPort` 退出；被其他进程占用才报 `port is taken`。非 5173 的残留 Vite（例如 5174）不会被复用。窗拉起的守护进程在 debug 构建里带 Bun `--watch`，改 `apps/daemon` 会重启本机接口（已有我们则连，不新开第二个；旧无 watch 进程会一直占端口，需退出后再开 `pnpm dev`）。热重载会结束进行中的轮次并标成中断——这是进程退出，不是补全失败。**开发服务器开着时不要跑 `pnpm typecheck` 或 `pnpm build`**：两者都以 `svelte-kit sync` 开头，重新生成 `.svelte-kit/generated/*` 会让在跑的页面重载路由节点，窗口里就会冒出 `Unhandled Promise Rejection: ReferenceError: Cannot access 'component' before initialization`（来自 SvelteKit 的 `client.js`）。它读起来像代码 bug，其实是那一瞬间路由节点还没初始化；浏览器多半自己恢复，窗口不一定，刷新即可。要在开发中途做检查，用 `git worktree` 另开一份目录跑。启动先占端口再开库：抢不到端口的第二份进程不会改库。窗在 `local-api.json` 里的 pid 还活着时，即使健康检查暂时超时也不再拉第二份。修改 Rust 代码由 Tauri 重编译并重启窗口。桌面监督线程在释放应用状态锁后才更新托盘菜单，避免热更新后的本机接口查询与菜单更新互相等待。若旧版本窗口已经卡死，需要结束旧窗口进程，再重新运行 `pnpm dev`；热更新无法解除已经发生的原生线程死锁。

单独起信使（浏览器改 UI，不是黄金路径）：

```bash
pnpm --filter @real-bot/messenger dev
```

开发态窗在守护进程起来之前可以是「连不上运行时」。连上后是空名册的会话优先三栏。设置弹窗是向导空态：未完成时工作区文件夹、至少一个端点的 URL 和密钥齐了即完成（`wizard_complete` 看工作区 + 任一端点已配密钥）；工作区路径只展示、不能手填，点「选择文件夹」打开系统对话框（浏览器开发态打不开），选中即写入；可以向导里配第一个端点，之后在设置「模型服务」里再加：默认是端点卡片列表。每张卡片上，已启用的模型各占一行，点那一行就把这个名字设成该端点的默认模型（`PATCH /v1/providers/:id` 只带 `default_model`），当前默认是实心圆点；「名单」另开一层勾选启用、填价格、思考等级和擅长领域，「连接」另开一层改名称、URL 和密钥，两层互不带对方的字段。卡片上可删除（确认弹窗）。每个端点有自己的模型名单和默认模型；名单上的名字可填选路参考价 `price`、计费单价 `pricing`、支持的思考等级和擅长领域。`price` 用于选路，`pricing` 的输入 / 输出 / 可选缓存输入单价单位为 USD / 百万 token，用于缺实报金额时的估算；探测不自动填单价。「连接」里填好 URL 和密钥停手约 0.7 秒就自动打 `POST /v1/models/probe` 拉一次 `/models`，同一对 URL + 密钥不重复拉，也可手动「重新获取」；拉到的完整名单随端点存成 `available_models`（`POST/PATCH /v1/providers` 同名字段，`GET` 一并返回），再进编辑时直接展示，不用再拉；存过的端点若名单为空（旧数据）则打开时自动拉一次。探测响应还带 `catalog`：`/models` 对象若写了 `reasoning_efforts` / `thinking_levels` / `reasoning.supported_efforts` 等，就把那些档名自动写进该模型的思考等级（Grok 的 `xhigh`、Gemini 的 `max` 这类），设置里仍可手改或加自定义档；对象没写则仍是 none / low / medium / high。名单以勾选列表呈现（超过 6 条出现搜索框、「全部 / 已启用」切换和全选 / 清空），勾上即启用；名单上没有的名字用底部「手动添加模型名」补进去；什么都没勾且拉到的名单不超过 3 条时整单直接启用，更长的名单等你挑。已启用的行右侧有属性折叠：价格是数字框，思考等级和擅长领域都是点选芯片（擅长可加自定义标签），不再有多行文本框。默认模型在端点卡片上点已启用的名字来选，不再放进编辑浮层的下拉框。启用或取消一个名字不会改掉已经选中的默认；选中的名字被取消启用后默认清空，等你再点一个。用户发消息开一轮时，应用只在 Bot 钉的端点（没钉端点就是默认端点）的名单里选模型和思考等级，新加的端点不会自动进别的 Bot 的候选；Bot 钉了仍在名单上的名字则模型名受约束，钉的名字只在别的端点上时照钉的用。思考等级（`thinking_level`，即补全的 `reasoning_effort`，档名以该模型名单为准）和模型一起钉：不钉模型时模型和等级都由应用每条消息挑，传了 `thinking_level` 是 `422 thinking_level needs a pinned model`；钉了模型必须有等级，没给就落到该模型的默认档，换成不支持原档的模型也落到新模型的默认档，清掉模型一并清掉等级。Bot 面板里模型选「自动」时不显示思考等级，选了具体模型才出现，且只列该模型支持的档。空钉不是永远用端点默认模型，要用别的端点必须显式钉端点。选模型由 agent 做：开轮前一次短调用（`prompts/routing.ts` 的 `ROUTE_PICK_SYSTEM`，无工具、结构化返回 model / thinking_level / reason / continues_previous），看这条消息、Bot 人设、候选名单和该 Bot 最近的复盘结论；它固定打到默认端点的默认模型以免递归，`route-agent.ts` 校验模型必须在候选里、档位必须该模型支持，不合法或超时就落回 `route-decision.ts` 的规则兜底，不重试。Bot 钉死了模型和思考等级时跳过这一跳。用户后续的每一句都原样记到它答复的那一轮上（引用回复落在被引那一轮，`@` 了唯一一个 Bot 落在它最近那一轮，否则落在会话里最近可见的一轮），不按关键词筛；围绕同一件事的若干轮共用一个 `chain_id`，由选路调用的 `continues_previous` 判定，静默 3 分钟兜底；定时器只在内存里，守护进程启动时 `sweepStaleChains()` 会补扫已经安静、仍未复盘的链（`created_at` 在 24 小时内，一次最多 20 条）。链结束时发一次复盘调用（`ROUTE_REVIEW_SYSTEM`），看触发消息、选了什么、Bot 的回复、全部跟进和终态，答出 fault（model / task / prompt / none）、direction、rounds、confidence 和一句理由，写进 `route_reviews`；只有 fault 为 model 且 confidence 够高的结论会被下次选路读到。每轮的选择在结束时记下终态；`GET /v1/sessions/:id/routes` 按时间列出该会话每轮选了什么、怎么结束、收到哪些反馈，并在 `reviews` 里带上每条纠正链的复盘结论；会话顶栏的「模型选择记录」按钮从右侧滑出独立浮层（`RouteLog.svelte`，宽 560px，自己滚动，Escape 或点遮罩关闭，不进当前对话设置），倒序画这份记录（Bot、模型 + 思考等级、消息类别、用时、结束方式与失败原因、选路理由、复盘结论、可展开的模型反馈；配了多个端点时标出端点），点一行跳回触发消息并高亮；打开时拉一次、开着时该会话轮次状态每变一次再拉一次（没有推送事件）。列表是窗口化的：`route-log-window.ts` 按 scrollTop、可视高度和已测行高算出该画哪一段（上下各多留 6 行），窗口外用 `<ul>` 的上下 padding 顶住，行高由 `ResizeObserver` 测到后回填（未测过的按 80px 估），所以 383 轮只有 20 行左右在 DOM 里。补全和判断打到该模型所属端点，不再发字面 `default`。路径须已有绝对目录，URL 须 `http(s)`；`422` 画在字段下或滑出顶，不会变成「连不上运行时」。左侧会话列表与聊天内容之间可拖条改宽度（200–480px），产物预览栏和预览里的文件树同样可拖；三处宽度和桌面端的窗格布局（`real-bot-workbench-layout`）都记在信使 `localStorage`，退出后再开还是关前那样，窗口变窄时只临时收紧、变宽再回到记住的值。桌面窗的宽高和是否最大化记在窗口进程自己的 `window-size.json`（不记位置），下次启动按上次大小打开。拖边框时每次尺寸变化都会走到这条落盘，但落盘若在拖动中去问「是不是最大化」（macOS 的 `isZoomed`），窗口会在松手时跳到别处，所以拖动中只保留上次记下的大小和最大化标记，松手、关窗、退出才重新问。侧栏全局搜索覆盖会话、消息、文件和日程；消息命中带所属会话名，点击打开该会话并滚到命中消息（短暂高亮）。会话详情默认最近 50 条，更早的命中会继续向后翻页直到找到。打开你↔Bot 私聊可以发消息（可带文件，复制到工作区 `inbox/`；PNG / JPEG / GIF / WebP 会进这一轮补全，Bot 能看见图）。Bot 写出的工作区文件可用 `send_message` 的 `paths` 或正文里的 Markdown / 反引号路径挂在那条消息上（不复制）；点开可预览图 / 音视频 / PDF / 文本 / 单文件 HTML（正文里的工作区路径即使没挂成该条附件，也走 `GET /v1/workspace/file`；该接口不按 1MB 截断，预览视频与附件内容接口一样按文件字节返回），目录和未知类型用系统打开。同一条消息挂了多个路径时，气泡里收成一个入口，点开后预览栏左侧是引用路径嵌成的文件树（只含这条消息引用过的路径，不列未引用兄弟）；文本是 Monaco + Shiki 编辑器（行号、查找 / 替换、匹配括号·标签·标题折叠、换行、复制；Cmd+F 查找，Cmd+G / Shift+Cmd+G 下一个 / 上一个，Ctrl+G 跳行，Cmd+⌥F 替换，Escape 先关查找；Markdown / HTML 默认渲染，可切源码；点「源码」在源码未到之前不回落到渲染 iframe，切文件才退出源码；源码着色 `vitesse-light` / `vitesse-dark`，跟随应用 `data-theme`）。HTML 预览是 `blob:` iframe，`sandbox` 含 `allow-scripts` 不含 `allow-same-origin`：内联 CSS / JS 动效能播，脚本拿不到信使页面和本机 token；外链脚本仍受窗口 CSP 限制。窗口 CSP 允许 `style-src 'unsafe-inline'` 与 `script-src-attr 'unsafe-inline'`，内联 `<script>` 在打包态若 CSP 带了 nonce 会把同一 nonce 写进预览 HTML。区内 UTF-8 文本可 Cmd+S / 保存写回 `PUT /v1/workspace/file`。能落盘的文件从文件树那一项的右键打开：在 Finder 中打开，或用系统默认应用打开；本机窗口才生效，开发态浏览器只留一句提示。预览头部不再放这些按钮，也不再放查找、换行、复制、保存和关闭——查找仍是 ⌘F，保存仍是 ⌘S，桌面端的关闭在工作台标签上。窄屏和手机没有标签，头部只留返回和文件名。Markdown 和单文件 HTML 在内容顶部正中用一个浮动按钮在渲染和源码之间切换，按钮上带着对应的图标。按钮钉在预览区上，正文在它下面的一层里滚，所以滚下去按钮还在。侧栏底部带文字的「工作区」（⌘O）从右侧打开独立工作区浮层（完整文件树 + 自己的预览/编辑器，不占用对话框旁那条产物预览），按需展开；本机接口 `GET /v1/workspace/tree`、`GET /v1/workspace/file`（区内文件字节，目录 422，缺失 404；读取不按 1MB 截断）、`PUT /v1/workspace/file`（覆盖已有区内 UTF-8，过大 `too_large`）。聊天围栏代码块仍用 Shiki 分词着色（每 token 一个 span，亮/暗两套 CSS 变量；覆盖常见语言，含 JSON），流式输出过程中也会跟上。预览不写回工作区。交接仍是 `@Bot` 加上这些路径，没有单独的产物表。主转录里名册上的 `@Name` / `@everyone` 渲染成带头像的 chip（与作曲栏点名芯片同一视觉），点 Bot chip 打开人设；围栏和行内代码里的 `@` 不转。消息悬停工具栏在复制旁有「回复」：点了在作曲栏挂上被引的那一条，发送带 `parent_id`，引用 Bot 时正文自动 `@对方`；回复留在主转录，气泡里显示引用条。Bot 用 `send_message` 的 `parent_id` 同一套。Bot 一开始思考就在触发消息下出现紧凑「回复中」行（头像 + 名字）；群里多人同时思考收成同一列。侧栏会话行展示当前会话的状态（思考中 / 回复中 / 待审批 / 待回复 / 空闲）；Bot 自己的全局工作状态展示在 Bot 自己的头像上（状态标记）；会话行有未读角标，打开即已读。工具循环的中间跳不画气泡，一直保持思考；`send_message` 一旦发出就结束本轮，不再开下一跳补全。只有本轮最终那条 `kind: bot` 才渲染。空补全或「本轮没有新工作」这类收尾不插 bot 消息，也不再叫醒别人。终态 `kind: bot` / 你的气泡 / `system` 按 markdown 渲染。流中途卡住时，已写出的正文或完整工具调用会收下并继续这一轮，不插失败 `system`；还没有可用输出时会自动再试。同一端点同时最多两条补全 / 判断流，群里多人并行时其余排队。真正失败（连不上、端点拒绝、没有可用模型等）才出现那条 `system`。轮次卡住也会收尾：轮次回路是脱离的，里面抛出的异常以「这一轮没写完：运行时出错」结束这一轮（并打一条 `[turn <id>] crashed` 日志），不再无声地把轮次留在 `running`；调度器每次 tick（15 秒）还会扫一遍，`last_activity_at` 超过 20 分钟没动的 `running` 轮次以「这一轮没写完：卡住了，很久没有任何进展」收尾，等待批准 / 等待回复的轮次不在扫描范围内。为此每次工具调用在开始和结束各记一次活动，耗时长的壳命令或 MCP 调用不会被当成卡住：`shell` 单条命令最多 10 分钟，超时 SIGKILL 并作为工具失败返回（输出与超时赛跑，后台孙进程攥着 stdout 管道也不会吊住轮次）；HTTP MCP 的响应流静默超过 5 分钟放弃该次调用，读响应体期间 Stop 依然有效。守护进程死亡留下的中断行和其他 Bot 消息一样带头像与名字，「继续」贴在「中断」气泡后面（`POST /v1/turns/continue`）以该条为触发条新开一轮，不重试断掉的工具；系统提示点出断掉那一轮在处理的请求（谁、何时、前 200 字，`context.ts` 的 `interruptedTrigger` 沿着接连的中断和「这一轮没写完」最多追 10 层），选路也按那条请求，「这一轮没写完」行上的「继续」同样如此。继续过的中断行和「这一轮没写完」行旁标出下落（`chat-view.ts` 的 `interruptFollowUp`）：「继续中」「已继续」（点了跳到它留下的第一条）「已继续，没写完」「已继续，中途停下」「已继续，没有发消息」（只在窗口看着它结束时这么写；重新载入后找不到它的消息只写「已继续」，它可能发在别的会话）。提问卡在流里，回复带 `ask_id`；区外写 / 无约束壳停在主转录里的批准卡（允许一次 / Always allow / 拒绝），待批准角标在会话行；私聊 Stop 打眼前这轮；群聊没有 Stop，要停就发消息。协作工具、群判断（仅你的无点名群消息才判断；点名只开被点名的）、文件四件套和工作区壳已接通；区内读写直接干。Bot 可用 `update_profile` 改自己的名字、职责、边界、头像、钉的端点+模型和思考等级（`thinking_level`，null 清掉；生成风格或工作区 PNG / JPEG / GIF / WebP；区外读停待批准），改完不在转录里插人设条。Bot 也可用 `list_skills` / `read_skill` / `create_skill` / `update_skill` / `delete_skill` 维护自己的技能（具名工序：何时用 + 怎么干 + 可选的依赖 MCP 服务器名 `uses`）；启用目录进入每一跳 system，每条下标出「依赖 MCP」和本轮未连接的服务器；正文按需 `read_skill`，返回里 `stale_tool_names` 列出正文写了但本轮 tools 数组里没有的 `mcp_` 名字；改完不插转录条。你在人设抽屉里也能列表、编辑（含「依赖的 MCP」一栏）、停用和删除。Bot 也可用 `list_endpoints` / `add_endpoint` / `update_endpoint` / `delete_endpoint` 和 `list_mcp_servers` / `add_mcp_server` / `update_mcp_server` / `delete_mcp_server` 改名册级端点与 MCP：stdio 用 command / args，HTTP / Streamable HTTP 用 url（可附非鉴权 headers）。新建端点、改已有 URL、新增 MCP、改 command·args / url / headers 停在主转录批准卡（不能 Always allow）；新建 / 改 URL 的卡带密钥框，HTTP MCP 新增的卡带 Authorization 框且必须粘贴后才能允许一次，密钥只走 resolve、不进转录。默认端点不能改 URL / 密钥 / 删除。已有端点改名或整表替换模型名单、删非默认端点、MCP 改名 / 启用 / 停用 / 删除直接干。已配且启用的 MCP 服务器添加时会握手解析 `instructions` 和工具说明（设置里加和 Bot 批准后加同一条路）；每次补全都会把所有已启用且连接成功的服务器工具放进 `tools`（`mcp_<server>_<tool>`），服务器说明和你或 Bot 写的用法备注（`usage_note`，排在服务器说明前面，改它不等批准、改连接也不清）附在本轮 system 末尾，调用直接干；不按消息关键词、语言或 Bot 身份筛选。系统指令固定选用顺序：先看技能目录，命中就 `read_skill` 照做，正文点到的 MCP 工具按名调用；没有命中的技能才直接挑 MCP 工具。Bot 或设置中添加 / 修改 / 重新启用后，当前轮次下一跳、其他 Bot、后续私聊 / 群聊 / 日程均可调用，停用或删除后不可再调用。图片生成及视频提交 / 查询等能力来自 MCP 工具，不取决于补全模型能否直接输出媒体；「再来一张」这类后续请求也保留完整工具。设置里的名册级 MCP 服务（stdio 与 HTTP）使用紧凑列表，显示名称、传输、连接摘要和启用状态；列表独立滚动，搜索与添加入口保持可见，可按名称、传输或连接地址筛选，长名称与地址省略显示。点服务或添加入口打开独立编辑弹窗；名称和用法备注改完即写入，新增 / 改连接必须确认才发 POST/PATCH，没有 Always allow，不走转录批准卡；删 / 停用直接干。名册行「+」和「群」组头「+」打开居中弹窗，分别 `POST /v1/bots` 与 `POST /v1/sessions`；建完选中新会话。新建群的成员用可搜索的多选下拉挑：每行是头像 + 名字 + 职责，按名字或职责过滤，选中的成为字段里的带头像芯片，✕ 或空输入时 Backspace 移出，Escape 只关列表不关弹窗。头像由 `MultiSelect` 的 `media` snippet 画，组件本身不认识 Bot。Bot 支持 `avatar`，默认用 boringavatars 算法生成 SVG（beam、marble、pixel、sunset、bauhaus、ring 风格，可随机换一个）；也可上传 PNG / JPEG / WebP，信使压成正方形 JPEG data URI 再落库。若创建时未显式指定头像，守护进程默认按 Bot 名称生成 SVG 头像；侧栏名册、左侧会话列表、顶栏、欢迎卡片、消息转录与提问卡均渲染对应头像。会话列表中，你↔Bot 显示该 Bot 的头像，Bot↔Bot 显示双方叠放头像，群显示群图标；无头像或图片加载失败时列表回退到名字首字，已删除 Bot 显示占位符，归档仍保留头像。顶栏只留一个当前对话设置：群是「群组设置」，私聊是「Bot 设置」。左侧会话列表（群组、你↔Bot、Bot↔Bot）以及顶部的已置顶项目均支持右键菜单：支持置顶/取消置顶、查看信息（打开对应的群组或 Bot 设置抽屉）、清除历史（二次确认后清空会话历史）、归档/取消归档（Bot 会话可用）以及删除（群聊确认后删除群，Bot 会话确认后删除 Bot）。你↔ 打开右侧抽屉，「Bot 基础信息」一张卡改名字 / 职责 / 边界 / 头像 / 模型 / 思考等级：所有改动自动保存（文本停手约 0.6 秒后 PATCH，模型 / 思考等级 / 头像点了就存；切换 Bot、返回群设置或关面板前先把未保存的发出去），卡片头显示「保存中… / 已自动保存」，没有保存和关闭按钮，只有右上角 ✕；思考等级是一排快捷档位（自动 + 所选模型支持的档），换成不支持的模型时自动退回「自动」。「会话操作」归档 / 恢复，「危险区域」清空历史（确认弹窗，点确认才清）和删除（确认弹窗，点确认才删），排版与群组设置同一套行；已归档从名册行消失、你↔行标「已归档」；删除后标题为「已删除」、作曲栏禁用。群组设置可改名、拉人、移出（只剩两个 Bot 时移出不可用），删除群聊走确认弹窗；点成员名进人设并可返回群组设置。Bot↔Bot 设置里点成员名同样打开人设。Bot↔Bot 私聊一次发起一条：`create_direct` 每次新开一条会话并记下来源（叫醒发起方那一轮的 `trigger_message_id`），同一轮里重复调用返回同一条；会话上的 `origin_session_id` / `origin_message_id` 随 `GET /v1/sessions` 和 `session.upsert` 下发，信使据此把入口卡片挂在来源消息下方、在侧栏那一行标出来源。这类会话用户只能看：`POST /v1/sessions/:id/messages` 对不在场的用户返回 `403 not_a_member`，建议草稿返回空数组，`ask_user` 在其中直接拒掉（否则轮次会停在一个没人能答的提问上）；标记已读、归档、清空历史、Stop 和放行审批都照常。没有用户在场时，对方第二条消息改道进现有活轮而不是再分叉一轮。日历日程到点会在你↔该 Bot 私聊分叉叫醒（补跑只跑最近一次）。关窗隐藏到托盘且留 Dock；托盘左键叫回；退出后守护进程不在。黄金路径业务还没接。

### 花费账本与接口

信使通过桌面「工具」菜单、手机搜索旁的工具菜单、窗格标签菜单或桌面「视图 → 花费」打开独立视图。再打开一次定位到已有标签。宽屏只有一个 `spend` 标签，窄屏使用 `?o=spend` 浮层。`SpendView` 的常驻顶栏和独立内容滚动区由宿主分配尺寸；概览和调用明细共用数据与筛选，620px 容器断点将表格切为纵向记录，1000px 以上趋势与类别并排。`SpendTrend` 按时间顺序合并为最多 28 个区间，金额保持两组并使用共同刻度，点选/键盘可读分项；窄窗格不依赖视口媒体查询。范围、维度、排序和趋势指标写本机 `deskfolk.spend.view`；筛选只在当前视图。会话顶栏、列表行、会话设置与流程图维持现有展示。

`spend` 保存六类端点调用、实际模型 / 端点 / 思考等级及名称快照，无会话或 Bot 外键，删除业务记录保留账本。`turn` / `route_pick` 要求轮次 id，`judgement` 要求判断 id，`route_review` 要求链和轮次 id，`route_learn` 要求链 id，`composer_suggest` 的 Bot 为空。迁移夹具覆盖旧结构；旧模型仅从仍存在的轮次选路记录回填。实报字段为 `cost_usd_ticks`，按写入时单价冻结的估算为 `estimated_cost_usd_ticks`，两者分别统计。

| 接口 | 参数和返回 |
|---|---|
| `GET /v1/spend/summary` | `from` / `to` ISO 时间，范围 `[from,to)`；`group_by=model/session/bot/kind/day`；`tz` IANA 时区；`kind` 可重复或逗号分隔；`bot_id`、`session_id`、`model`、`provider_id`、`turn_id` 过滤。返回 `totals`、`groups`、五类 `categories`，分组各带同形指标及类别明细。 |
| `GET /v1/spend` | 同样的过滤；`limit` 1–200，默认 50；`cursor` 为上页返回的 `next`（UTC 时间和 ULID），按时间 / id 倒序。返回 `{items,next}`，每行带触发消息 id 和删除标志。 |

空 `model` / `bot_id` 过滤未记录模型 / 未归属 Bot。全组缺某个数字时仍是 null；`reported_calls`、`estimated_calls`、`missing_calls` 分别记录金额覆盖，`missing_usage_calls` 记录缺全部 token 字段的调用。聚合在守护进程完成，按日分组使用请求时区。快照不带花费行，客户端也不累计事件；打开的视图收到 `spend.created` 后去抖刷新。`spend.removed` 保留旧类型兼容且不再发出。远程配对设备经现有加密 RPC 访问同一接口。决定与公式见 [ADR 0027](adr/0027-spend-ledger-and-view.md)。

## 聊天输入区

消息流与输入框共用同一条居中栏（`--chat-max-width: 800px`），宽屏两侧留白，行宽不再随主栏拉满。顶栏、侧栏和滚动条仍铺满主栏。「回到底部」浮在输入卡片右上方，离开底部时从卡片里滑上来，回到底部时从卡片上沿钻到卡片后面。圆钮和滑动槽一样宽，外投影或外扩焦点环会被切成方框，所以钮上没有外阴影，键盘焦点画在圆内。建议芯片那一行比卡片高，按钮出现时这一行停在按钮左侧，不盖住它。输入区外层通栏透明、不接点击；毛玻璃（`--glass-composer` + `backdrop-filter`）只紧贴输入区轮廓：建议芯片贴在输入框左肩上，单行按芯片内容撑开（不定宽、不换行），和输入卡片连成一块「烟斗」形，快捷键提示单独一圈。宽屏两侧对话内容直接露出来。输入卡片本身用 `var(--input-bg)` 实体底色保持高对比度。输入区采用上方文字、下方工具栏的布局：附件在左，右侧固定一个圆形操作按钮，快捷键提示位于输入框外。发送按钮旁的 ✨ 按当前转录起草下一步建议芯片（`GET /v1/sessions/:id/composer-suggestions`，短、无工具调用）。每按一次调用一次模型、记进花费；打开会话、来了新消息都不会自己去拉。起草中 ✨ 转圈，再按一下停止；芯片出来后 ✨ 亮起，再按一下收起。有回复正在进行（含待判断）时 ✨ 不可按：这时起草的，回复一到就过时了。什么都没起草出来（调用失败也一样，守护进程两种都回空列表）时，芯片那一行写「这次没有起草出建议」，4 秒后自己收起。会话里来了新消息，已有的芯片作废收起；已有消息的表情、编辑、回答不算。芯片一行横向滚动，放不下时有更多的那一端渐隐，鼠标滚轮在这一行上改为横向滚动。点芯片把完整草稿填进输入框，需要叫醒谁时草稿里可以带 `@名字` 或 `@everyone`。输入框里打 `@` 仍弹出在场成员补全。你↔Bot 私聊空闲时显示发送箭头，有进行中的轮次（含待批准、待回复）时替换为停止方块；停止仍只针对眼前这一轮。群聊不论是否有进行中的轮都保持发送，不出现停止按钮；要停就发消息让 Bot 们停下来。私聊生成期间可以编辑下一条草稿、添加附件，但发送按钮和 Enter / ⌘+Enter / Ctrl+Enter 都不会提交；结束或停止后恢复发送，草稿保留。群聊有活轮或判断进行中时仍可发送。输入法选词窗口开着时 Enter 只确认候选，不发送；选词刚结束的那一下 Enter 也不发送。Shift+Enter 始终换行，多行内容不再误显示占位提示。消息提交中暂不允许重复发送；只读会话保持禁用。停止待批准的私聊轮次后，批准卡立即显示已作废，侧栏待批准状态同步清除。移动端隐藏快捷键提示，操作按钮使用 44px 点击区域。会话窄到手机宽度（手机、小窗口、窄窗格都算，按会话自己的 `conversation` 容器宽度 ≤680px 判断）时输入区不再浮动：整条贴底、贴两侧，上沿一条细线，聚焦时细线变成强调色；没有圆角卡片、外投影和雾面，建议芯片也在这条底栏里。输入区在舞台的正常流里，转录停在它上方而不是被它盖住，芯片出现时转录让出高度并仍贴底。iOS 键盘弹起时底栏跟着升到键盘上方，此时不再给 home 指示条留安全区。✨ 在输入框右侧、发送按钮左边（各宽度都是），窄布局里一旦有文字或暂存文件要发就隐藏，把宽度还给输入框：输入框空着时只有占位符，✨ 占的那段本来就空着；发送按钮也就不会紧挨着一个你想点的别的按钮。触屏（`pointer: coarse`）上底栏离两侧至少 16px、离底边 12px，四曲面屏的弯边不报安全区，只能自己留；附件、✨、发送都是 40px，✨ 和发送之间隔 8px，「回到底部」对准发送按钮居中。

## 工作目录

一件事的中间产物集中在一个目录里，而不是散落在工作区根。身份是**一次触发展开的轮次树**：交接、点名、判断下场、Bot↔Bot 私聊和中断续跑都继承唤醒方那一轮的目录，日程每次触发新开一个，同一会话静默 6 小时后的下一轮也新开；每个会话最多一个开着的目录（`store/tasks.ts`，`turns.task_id` / `messages.task_id`）。目录名是 `work/<日期>-<触发消息前 12 码点>-<id 后四位>`，在第一次真被用到时才创建，只说话的轮次不留空壳。

**两个基准，一句话记住**：`shell` 不传 `cwd` 就在本轮工作目录里跑，而 `read_file` / `write_file` / `delete_file` / `list_dir` 的路径永远相对工作区根。这是[中间产物的工作目录](../.scratch/v1/issues/55-work-dir-and-artifact-entry.md)的 D2 明知故犯：堵住下载、转换、脚本产物这个最大的泄漏口不需要模型配合，而改文件工具的路径基准会让 `read_file("x")` 和 `write_file("x")` 指向两处。代价是「写个脚本再跑」这类流程要么把脚本写进工作目录（用局面块给的完整前缀），要么给 `shell` 传 `cwd: "."`；`full_result_path` 也是工作区相对的，轮次指令和 `recovery_hint` 都写明了这一点。

Bot 在正文里按它壳的视角写路径（刚 `echo ... > sales.csv` 之后它自然就叫 `sales.csv`）时，`resolveBodyPathsToWorkDir` 会把只在工作目录里存在、在工作区根上不存在的那种裸路径改写成能解析的那条——否则挂出来的是一个根本不存在的根路径，转录里的链接也是死的。根上确实存在的、以及两处都不存在的（Bot 在说还没做的文件）都原样不动。

交付物不进工作目录：用户点名了路径就照他说的写，没点名的落工作目录根。局面块每轮带一行 `本轮工作目录：<路径>/`，私聊也有（私聊的局面块只有这一行）。

消息末尾那个产物入口点开后，左侧的树不再只有这一条消息的路径：`GET /v1/tasks/:id/artifacts` 给出**这件事**引用过、磁盘上还在的全部路径（`attachments` join `messages` 按 `task_id` 聚合，一条路径一行，最近引用在前；是否还在由 `citedPathExists` 判断，和附件的 `exists` 同一个口径，还在暂存提交里的也算；上限 200 按留下的算，删掉的不占名额），`buildTaskArtifactTree` 把工作目录做成唯一的树根、目录之外的路径与它并列平铺、本条消息自己引用的那几个打点（`exists: false` 的附件不进树）。工作台预览标签在树里点文件只改当前文件，标签里存的仍是来源交付的列表；没有附件行的文件（正文里点名的、或当前显示却没人列出的）在前端是 `virtual-` 开头的占位 id，`artifactByteSource` 遇到它一律走工作区读，不拿去请求附件接口。不用最深公共祖先——只要有一个 `report.md` 在工作区根上，公共祖先立刻退化成根，读者又得先展开 `work / <带日期的目录> /` 才看见文件。和路由记录一样是开面板拉一次，没有推送事件；拉失败就退回只列这一条消息，入口照常能用。⌘O 冷启动时也会跳到本会话当前的工作目录。

同一件事也能按状态流转看。`GET /v1/tasks/:id/trace` 把共享这个工作目录的轮次读成一张经过：你的发言一张卡，每个 Bot 的一轮一张卡，边是触发消息的 `turn_id`（没有就是你），产物是这一轮消息上的附件（每个带 `exists`，从卡片打开预览时删掉的文件不会回到树里），旁观人数记在叫醒它们的那张卡下。信使按这条边从上到下排成流程图（同一轮叫醒的人并排在一行），每张卡片在名字左边放这个人的头像。点卡片跳到这一轮自己的那句话：还在写或已经说完的，是它最后一句；被中断的，是那条「中断」，不是它上面那一句。点一个文件，它作为交出它的那一轮的下一站展开：只读，图、Markdown、音视频和 PDF 直接看，没有聊天旁那条预览的文件树、源码切换和保存；再点同一个文件、它自己的 ✕ 或第一次 Escape 收起。`GET /v1/sessions/:id/tasks` 列出这个会话参与过的事，按最近活动倒序。会话顶栏的「经过」在桌面端开成一块窗格（`TraceView.svelte`；想让它浮起来就按住 ⌥ 把标签拖出去，那是窗格布局的事，板子自己不再带浮动窗；点一个节点，对话切到那一轮所在的会话并高亮，窗格留着，当前会话里的节点加一圈标记；换一条对话，窗格改成那条对话最近的一件事）。手机上是单独的一页（`TaskTrace.svelte` 是那个壳），铺满屏幕，消息菜单的「看这件事」和 Bot↔Bot 私聊来源头打开同一张。从一条消息打开时，板子打开后直接移到这条消息自己的那张卡片，并把它放在视口中间、按原尺寸画；对不上卡片就仍是整张适应。板子已经开着时，再从一条消息打开，画面从当前位置平滑滑到那张卡片，拖动或缩放会停掉这次滑动。顶栏的「经过」不指定卡片。地址是 `?o=trace&k=<taskId>`，开着时该工作的轮次或消息一变就再拉一次。超过 40 张卡片时不再画线，改由卡片自己写「由谁的上一轮叫醒」。手机宽度改成从上到下，预览改到流程图下面。

`shell` 每次调用前后会扫一遍工作目录（深度 2，跳过保留子目录和点文件 / `node_modules`），新增或 mtime 变了的文件作为 `paths` 回在工具结果里，并自动挂成消息产物——`write_file` 会报出自己的路径，命令不会，下载 / 转换 / 渲染留下的文件此前一个都不上榜。超过 200 个条目就一个都不报并标 `paths_truncated`，`npm install` 不是一份产物清单。

工作目录下有两个保留子目录：`tool-results/`（守护进程的大工具结果）和 `scratch/`（轮次指令让 Bot 放纯过程文件的地方）。**写进这两处的文件不会自动挂成消息产物**，其余位置照旧；这条规则在 `store/tasks.ts` 的 `isReservedTaskPath`，由 `turn-engine.ts` 的 `noteWrittenPaths` 执行。

## Bot 遇到障碍时

所有 Bot 的中英文轮次指令都要求先主动排查和尝试解决：检查实际错误、工具说明与已有文件，用低风险、可逆的方法推进；失败后根据证据调整参数或换用工具，完成后验证原始目标。技术问题不能仅以「遇到问题」收尾，不能让用户代做可自行完成的下载、查找、转换，也不能擅自用替代产物冒充完成。用户指出上轮问题或要求继续，仍是待处理的新工作。Bot 私聊没有作曲栏，一轮中断或没写完时，「继续」贴在那条系统消息上：`isContinuableNote` 认「中断」和全部「这一轮没写完：…」，`claimInterruptContinue` 在私聊和群里都以这条消息新开一轮；私聊里作曲栏锁着也不收起这个按钮（`canContinueInterrupt` 的 `readOnly`）。群里同一 Bot 同时最多一轮进行中：再被点名或判断下场时听进那一轮，不另开分身。群轮补全能看见谁有活轮、谁叫醒、用户最近一句；达成一致由 Bot 自己停嘴，没有跳数或花费熔断。

超过上下文限额的工具结果会先保存完整 JSON 到本轮工作目录下的 `tool-results/<唯一标识>.json`（没有工作目录的旧轮次仍落工作区根），再提供 `full_result_path`（**工作区相对**路径）和受限预览。文件以仅当前用户可读写的权限独占创建，保留原始内容，可能包含工具返回的敏感信息。Bot 可用现有 `shell` 解析文件、筛选日志或提取链接、把内嵌 base64 图片解码为文件，不必反复生成或要求用户手工保存——注意 `full_result_path` 相对工作区根而 `shell` 默认在工作目录里跑，用命令或脚本读它要传 `cwd: "."`，`recovery_hint` 和中英轮次指令都写明了这一点。守护进程启动时会把**关闭超过 7 天**的工作目录里的 `tool-results/` 扫掉（一次最多 200 个），工作目录里的其它东西一律不动——那是用户的。模型看到的单条工具结果仍限制为 8,000 个 Unicode 码点；保存失败会明确标记，不会假称已经保存，真实失败状态也不会因裁剪而变成成功。

主动排障不等于无限重试或绕过边界：有副作用且结果不明时先检查是否已成功，拒绝与 Stop 必须尊重。只有确实需要用户独有的权限、凭据、信息或决策时才求助，并说明实际尝试、剩余阻碍和最小必要操作；危险动作仍走批准卡，密钥不进聊天。`send_message` 成功会结束本轮，因此不能用它提前发送排障预告。

## 工具选择评估

Bot 选对技能 / MCP 工具几乎全靠目录里那几行说明，所以改了系统指令、技能目录或「本轮 MCP」段的措辞之后，用真实模型量一下：

```bash
REAL_BOT_EVAL_API_KEY=sk-… pnpm --filter @real-bot/daemon eval:tool-selection \
  --base-url https://api.example.com/v1 --model model-a --model model-b --repeat 3
```

用例在 `apps/daemon/eval/tool-selection-cases.json`：`servers` / `skills` 是可复用的库，每条 case 引用库里的键（`{ "use": "github", "usage_note": "…" }` 可覆盖单个字段），给一句触发消息和期望：`expect.first` 是允许的第一个工具调用（`reply` = 不调工具或先 `send_message` / `ask_user`；`read_skill:<技能名>`；或 `mcp_<server>_<tool>` 这类工具名），`expect.forbid` 是整轮都不许出现的调用（`*` 结尾按前缀匹配）。每条 case 发一次补全，system 与真实私聊轮次完全一致（人设 + 技能目录 + 系统指令 + 本轮 MCP），tools 数组是内建工具加按 `mcp_<server>_<tool>` 映射的假 MCP 工具；只看第一个调用是否命中，另记禁止调用和不在数组里的编造名。`--only id,id`、`--category`、`--locale` 筛用例，`--thinking` 选思考等级，`--min-pass 0.8` 让命中率不够时退出码为 1。结果按模型 × 类别 × 语言汇总打印，JSON 写到 `.scratch/tool-selection-eval/<时间戳>.json`（已忽略）。用例文件本身有单测把关：期望里写的技能名或工具名必须在那条 case 里真实存在。密钥只从环境变量读，不进仓库、不进结果文件。

## 远程音视频预览

`ArtifactPreview`（消息附件、工作区）与 `TraceOutput`（流程图产物）在远程连接下调用 `RemoteApi.openMediaSource`。页面注册 `/sw.js` 后探测媒体能力；`static/media-stream.js` 为播放器提供 `/__remote_media/<随机 id>` 临时同源 URL，经 MessageChannel 把范围请求交给拥有该预览的页面，再由原有 Noise 连接读取文件。URL 只带随机 id；路径和字节范围留在加密 RPC 内。浏览器按需消费响应流，每次 RPC 最多 256 KiB，拖动进度可直接读文件中间或尾部，MP4 的尾部索引也由浏览器请求。预加载只取元数据，用户点播放后继续读取。Worker 不写入媒体缓存，返回 `Cache-Control: no-store`；关闭、换文件、连接结束会注销媒体源并取消在途读取。

现有文件 GET 新增 `range=bytes=<start>-<end>`（含开放尾部和后缀形式），回环 HTTP 同时支持 `Range` 请求头；206 响应含 `Content-Range` / `Accept-Ranges` / `Content-Length`，无效或不可满足的单段范围返回 416。范围读取只读选中片段，ETag 校验选中片段的 SHA-256；远程仍按原始文件大小执行 50 MiB 上限，范围与 `size` 图片变体不能组合。浏览器无 Service Worker、旧 Worker 无媒体能力或旧主机拒绝 range 时保留整文件 Blob 预览；编解码支持仍由浏览器决定。本机窗口保留原加载路径。

## 本机接口

守护进程绑 `127.0.0.1:17890`，并在同一端口再听 `[::1]`（给 Vite 开发页的 IPv6 回环用）。前缀 `/v1`。`GET /v1/health` 不鉴权；其余 HTTP 用 `Authorization: Bearer`。WebSocket `ws://127.0.0.1:17890/v1/events`（或 `ws://[::1]:17890/v1/events`）连上后第一条消息 `{ "type": "auth", "token" }`。HTTP 还校验 Origin：缺省（curl / 测试）放行；`http://localhost`、`http://127.0.0.1`、`http://[::1]` 和 `tauri://localhost` 放行并回显 CORS（含 `Access-Control-Allow-Private-Network`）；其它 Origin 是 `403 forbidden_origin`。信使 Vite 常只听 `[::1]:5173`；浏览器开发态发现接口时按页面地址族拼 origin（`[::1]` 页连 `[::1]:17890`），避免 Chrome 把跨地址族回环请求当成本地网络访问拦掉。`GET /v1/tasks/:id/artifacts` 返回这件事的工作目录、标题和它引用过的全部路径。批注：`GET /v1/annotations`（按 `relpath` / `session_id` / `target_session_id` / `message_id` / `target_message_id` / `status` 过滤，每条带现算的 `stale`；`relpath` 存的是引用时的写法，旁边另存解析掉符号链接和大小写的 `file_key`，按路径过滤时两者任一对上都算，所以 Bot 的 `read_file` / `list_annotations` 用解析后的路径也找得到）、`POST /v1/annotations`（新建草稿，守护进程按「挂到谁」补齐交付 Bot、交付轮次和发往的会话；非 Bot 消息、区外路径、链接、不存在的文件都是 422）、`GET` / `PATCH` / `DELETE /v1/annotations/:id`（草稿改 `body` / `anchor` / `crop` / `content_sha256`，已发出的只改 `status`；只能删草稿）、`GET /v1/annotations/:id/crop`（裁图字节，PNG / JPEG ≤ 1 MB）、`POST /v1/annotations/send`（`{ session_id, body, annotation_ids }`，一个事务里建一条引用交付消息的用户消息并 @ 交付 Bot，草稿转「待处理」，再走普通用户消息那条路开轮；跨会话混批或超过 50 条整批拒绝）。事件 `annotation.upsert` / `annotation.removed` 走同一条同步流，负载不含裁图字节；快照里不带批注，按文件、按消息去拉。`GET /v1/tasks/:id/trace` 把同一件事的轮次读成一张经过：你的发言一张卡，每个 Bot 的一轮一张卡，边是谁叫醒了谁，产物挂在交出它的那一轮上，旁观记在叫醒它们的那张卡下；`GET /v1/sessions/:id/tasks` 列出这个会话参与过的事，按最近活动倒序。会话顶栏的「经过」从右侧滑出这块板（`TaskTrace.svelte`），消息菜单和 Bot↔Bot 私聊的来源头也能打开同一张；地址是 `?o=trace&k=<taskId>`，开着时该工作的轮次或消息一变就再拉一次。`POST /v1/turns/continue` 用中断系统消息的 `message_id` 给该 Bot 新开一轮。`GET /v1/sessions/:id/composer-suggestions` 按该会话最近转录返回用户下一步草稿（`{ items: [{ id, label, prompt }] }`）；打默认端点上名字带 flash / mini / lite / fast 的模型（没有就用默认模型），无工具，20 秒首字节超时（有人按了 ✨ 在等；思考型 flash 模型要 3–8 秒，原来的 8 秒常常超时）；失败或没配端点返回空列表。信使只在按 ✨ 时调用它。

每次守护进程启动新铸本机 token，写到 `~/Library/Application Support/real-bot/local-api.json`（目录 `0700`，文件 `0600`）。库文件同目录 `state.sqlite`。每个端点的 API key 在钥匙串 `com.real-bot.daemon` / `endpoint-api-key:<provider-id>`（旧的单端点项 `endpoint-api-key` 会迁到默认端点）。测试或隔离跑可设 `REAL_BOT_DATA_DIR` 换这个目录。

单独起信使时，Vite 开发服务器提供同源 `GET /__local-api` → `{ name, port, token }`（守护进程未起时是带 `name` 的 `not_found`），不把 token 写进仓库或 bundle。页面只用 `port` 和 `token`，origin 按当前页是 `127.0.0.1` 还是 `[::1]` 拼。

### 快照与事件同步（sync-v1）

信使首帧是 `{ "type": "auth", "token": "…", "protocol": "sync-v1" }`，收到 `ready` 才读取 `GET /v1/snapshot`；订阅确认到 HTTP 返回期间缓冲事件。省略 `protocol` 的旧客户端仍收到原来的 `ClientEvent`，不会收到 ready / 水印信封；未知协议关闭连接。

- `RuntimeSnapshot` 包含 `event_instance_id`（CSPRNG 16 bytes，hex32）、`watermark_seq`、settings / bots / sessions / approvals / mcpServers / providers / skills / memories / routines / allowRules。花费账本通过聚合与分页接口读取；密钥本身不进入快照或事件。
- 新事件形状为 `{ type: "event", event_instance_id, seq, payload: ClientEvent }`。装快照后仅接受同实例且连续的 `seq > watermark_seq`；重复忽略，缺口、乱序前跳、实例变化、`resnapshot` 或本地缓冲溢出都断开重订阅、重取快照。只在内存缓冲，不离线存正文。
- `GET /v1/events/catchup?event_instance_id=<hex32>&after_seq=<非负安全整数>` 返回 `{ event_instance_id, watermark_seq, events, resnapshot }`。环只存可回放事件，最多 2000 条 / 16 MiB（按 UTF-8 JSON 计）；超限清环并重新随机实例，旧游标必须重取快照。单条超过环限额不保留，广播 resnapshot。进程重启也重新随机，不是耐久身份。
- `GET /v1/sessions/:id/snapshot` 在同一屏障返回 `{ session, judgements, event_instance_id, watermark_seq }`，包含最近消息、活轮及 pending_judgements。切会话读取期间仍缓冲所有事件；HTTP 可以比 WebSocket 先到，因此收到详情后还要等事件流的全局连续前缀到达详情水印，再更新全局状态、装详情并重放水印之后的事件。不得直接抬高全局游标或只检查 HTTP 返回时已有的缓冲，否则会丢其它实体更新或被迟到的旧事件覆盖。断线取消水印等待并脱开旧会话请求链；连接恢复不等待旧 HTTP 结束，会话载入也不阻塞健康检查/重试。连接代际清理与断线导航重置分开，初次连接不清除页面从 URL 初始化的设置/会话/Bot/工作区浮层。普通选择与同会话搜索的分页返回后，在合并、高亮和标已读前重新检查 API、同步实例、选择序号、当前会话及历史版本；过期分页不能经替代连接发出已读写入。同会话分页快捷路径只适用于已经安装详情、初始化游标的会话；选中但详情仍在途时，新的搜索走替代详情加载，排队中的较旧搜索由选择序号淘汰。连接重置、重新载入或历史清除会取消该就绪标记。`LocalApi.routines()` / `allowRules()` 保留对应列表读取方法，后续日程 UI 直接消费快照与事件。
- `GET /v1/sessions/:id/messages` 每页最多 50 条（`limit` 1..200），并且**按正文字节再截一次**：累计超过 `MESSAGE_PAGE_BYTES`（256 KiB）就在该条停下并给出 `next`。远控一次响应是一条 ≤1 MiB 的逻辑消息，长正文的会话否则会整页发不出去；分页变多、但每页一定送得到。客户端不得假设一页等于 `limit` 条。
- 转录只挂载最新的一段（`chat/history-window.ts`，初始 60 条，向上滚动每次 +40），滚到顶部先补已载入的消息，都补完后由「载入更早的消息」按钮取下一页；扩窗前记录距底距离，扩完还原，避免视图跳走。搜索命中比窗口更早时先扩窗再滚动。
- 转录的每条气泡复用同一个 item 对象与同一份 markdown 选项，`renderMarkdown` 也带结果缓存；快照每变一次就重建全部气泡的话，长会话在流式输出时每个 token 都要重排整屏。改动这几处时注意别把稳定的对象身份弄丢。
- Store 的同步方法在 SQLite 事务内运行，TEMP change journal 触发器跟随所有嵌套领域写入，回滚不出事件；提交完成后、返回调用方前统一分配 seq。异步 settings / providers / MCP 方法的每段 SQLite 写入显式 `ctx.commit`，不跨钥匙串或网络等待持有事务。快照使用同步缓存映射和读事务，读数据与水印之间不 await。Keychain 与 SQLite **不是**一个原子事务；已提交的 SQLite 变化即使后续凭据操作失败也会同步，密钥状态另发更新。provider 行提交也会在同一发布批次发出由其派生的 `settings.changed`，包括非默认端点改变 wizard_complete、或后续凭据操作失败的情况。快照只读取一次会话集合，在原数组上补 pending/partial 展示数据。信使只有 sync-v1 状态通道，不从 mutation HTTP 结果合成事件；仍用于导航/焦点/草稿等 UI 的结果与失败均核对发起 API 实例，旧连接不能影响替代连接。
- 新增 Store 方法若是 async，在门面显式 `bind(fn, true)`，每段 SQLite 写入必须用 `ctx.commit`；不要直接从运行时改 `store.db`。新增同步实体表需注册 `store/events.ts` journal 与事件映射。Bun `run().changes` 会包括触发器写入，单行 claim 使用 `RETURNING` 而不是 `changes === 1`。
- 消息首次写入发 `message.created`；回应、附件或中断 Continue 等后续更新发 `message.upsert`（完整消息含 reactions）。级联删除审批发 `approval.removed`；花费账本保留，`spend.removed` 不再发出。旧本机事件不变。`turn.token` 不进环，若发布则转成 Store 中绝对 `partial_text` 的轮次更新；`turn.tool` 仅保留旧本机流，不进入新同步流。当前引擎仍不把工具中间跳当作用户回复。

回归在 `apps/daemon/src/session-events.test.ts` 与信使 `event-sync.test.ts` / `runtime-sync.test.ts` / `page-startup.test.ts`（真实页面 URL effects + 延迟首次快照）；全仓跑 `pnpm test` / `pnpm typecheck`，再构建信使。隔离 UI fixture 可调用 `startRuntime({ dataDir, bind, endpointKey, completions, schedule: false })` 注入 fake keystore / fake completions，Vite 用相同 `REAL_BOT_DATA_DIR` 并选独立端口；单设数据目录不能隔离个人钥匙串。此协议不扩大 loopback / Origin，也不启用远控或离线命令；日程 CRUD 界面沿用上述快照与事件通道。

### 断线怎么被发现，什么时候再连

本机事件 socket 的 close 事件由 `openSocket` 报告。远控链路由 `RemoteTransport` 区分「自己关」（`close()`，不报）与「被关」（`fail()`，一次性 `ondrop`）：socket 的 close/error、type 7、帧或响应对不上都走后者，`RemoteApi.connect(onEvent, onDrop)` 把它交给 `runtime.markDisconnected()` + `reconnectNow()`。没有这一路，掉线的页面在下一次写失败之前一直显示已连接，重连只能由交互触发。

浏览器不报的那种死链（换网后 socket 仍称 open 却什么都不送）按静默判定：有未回答的请求、发送缓冲与上次检查相比没变、且距最后一帧或该请求发出满 30 秒，才判死。空闲链路不判（没有等待就没有证据），仍在上传的链路不判（缓冲在动就是还在走）。窗口取 30 秒是因为主机侧模型探测封顶 12 秒、一轮工作期间事件本来就在流；判错的代价是一次握手加一次回执查询，判不出的代价是页面一直装作连着。

握手失败必须关掉 socket：中继一台设备只给一条路由，留着它会让之后每一次重连都被自己丢下的链路挡住。握手期间那个读帧监听器在 Split 之后必须摘掉，否则整个会话的帧都堆在没人取的队列里。

重连仍由同一个 tick 循环执行：`schedule()` 只保留一个定时器（掉线撞上正在跑的 tick 不能留下两个循环），`pump()` 不并发跑第二次 tick（第二条链路会被中继拒），`nextAttemptAt` 记住下一次尝试该在什么时候。`visibilitychange` / `focus` / `online` / 推送只把定时器提前到那个时刻，不重置退避、不越过中继每分钟十次握手的额度。远控退避仍是 `nextRemoteRetry`（1s 起、20s 封顶、带抖动），连上即归零。回归在 `remote/transport.test.ts`（进程内真实 Noise 主机与可被「网络」掐断的 socket）与 `remote/runtime-remote.test.ts`。

### 事务回执、版本与文件完整性

Store 的 `ctx.commit`、`Store.transaction` 和回执共用 `Transactions.run`：只有最外层业务+回执 SQLite 提交后同步清空 journal 并发布当前映射，再按顺序执行文件提交与引擎回调。文件预暂存不包入业务事务；`postMessage` 自管暂存/事务；快照读事务内不嵌套会触发发布的写事务。pending_keys 与设置版本也进入 journal，凭据写入等待不持有 SQLite 事务，完成事务一次性发布当前凭据状态和设置版本。新增可选 `RuntimeSnapshot.credentialOperations`（缺省为空）与 `credential_operations.changed {items}`，只用于协商同步流，不改变旧客户端原始帧；设置直接消费同步状态，第二客户端修复/取消也能移除原客户端已确认待写的内存请求。客户端只在EventSync接纳的连续流中，先观察到该request_id自己的operation id，再观察到同实例更大seq中该操作移除/替换时退休请求；不能把较旧的空列表当作较新HTTP503已完成。LocalApi的请求对象保留终态标记，迟到503/网络失败不能复活已退休载荷，终态HTTP回执也同时清理内存请求与对应横幅。display code与已观察操作证据独立，改载荷产生的本地409不抹掉确认。重复详情回放的旧seq不推进生命周期。没有本请求的操作转换或终态回执时保留未知结果，不因无关列表或成功变更而清除，也不自动重放。

- 本机 `POST/PATCH/PUT/DELETE`（除只读模型探测）可带 `X-Request-Id: <uppercase ULID>`；未带时服务端生成并回传。所有本机调用归 `device_id = local`，不能从 HTTP 头指定设备。`request_receipts` 的 `(device_id, request_id)` 唯一：同摘要重放首次 status/body（包括首次 409/422），异摘要 409。业务写入与回执是同一个**同步** SQLite 事务，事务函数拒绝 Promise；外部工具、模型、MCP 检查、退出与事件发布在提交后运行。不承诺进程崩溃前后外部副作用精确一次，也不在重启后偷偷重放工具。
- daemon 通过 workspace 依赖直接使用 `@real-bot/remote/canonical` 的 RFC 8785 编码、完整六字段预像/SHA-256 与附件校验排序；`request-digest.ts` 只保留业务校验、参数适配及422错误映射，不再维护独立编码/摘要算法。`LocalApiOptions.canonicalEncoder` 保留为可信测试注入点，交给共享预像实现编码 body 和规范条件头，生产默认仍是共享 JCS。编码结果必须同步返回原始 string；Promise/其它非字符串拒绝为422，原生Promise仅挂拒绝处理，不等待或调用任意thenable。原始及已规范附件数组逐下标拒绝空洞，不将其忽略或当成空列表。摘要以 `0x1f` 连接 method、path+query、规范 JSON、`json|multipart`、文件列表、规范 conditionalHeaders；文件项为 filename + `0x1e` + SHA-256，按 UTF-8 filename 字节序、同名时 hash 排序。显式媒体类型/条件头绑定修正了空 multipart 与 JSON、不同前置条件可能同摘要的歧义。multipart 非文件字段禁止重名，文件名禁止控制字节。conditionalHeaders 只包含小写 `if-match` 键（无条件时 `{}`），值必须是引号包裹的64位小写SHA-256；不接受星号、弱ETag或列表。媒体类型精确接受 application/json 或 multipart/form-data，非规范路由 pathname（重复/尾随斜杠、编码分隔符等）在摘要和业务分派前拒绝；query值中的编码斜杠/反斜杠是数据，不当作路由分隔符拒绝，完整query仍参与六字段摘要。解码后的工作区path仍由文件包含边界校验。文件字节只计算摘要一次，执行分配与摘要均使用共享附件校验/排序；同名及完全相同的附件保留数量。共享预像会重新验证并排序传入的文件摘要，避免信任调用方声称的规范顺序。
- 7 天或 20,000 个完成回执正文后清理为 `expired`，保留唯一键墓碑；旧键返回 `410 receipt_expired`，用户确认后才用新键。墓碑**不随正文删除**，因此键元数据会增长；只有永久吊销且不能再认证的设备身份才能整体退休，当前不提供删除墓碑接口。待写密钥回执不参与清理。可信运输可用 `store.receipts.read(scope)` 查完成/503 待密钥/410 状态，不能把内部 pending 回执体当成功响应。
- 手机返回的规则集中在 `mobile-route.ts`：`routeLayers(view)` 把地址解释成一叠屏幕（会话 → 浮层 → 工作区文件/预览），`planUrlNavigation` 决定这次地址变化是 push / replace / back —— **打开才 push；落在下一条记录上就 back；其余变浅的一律 replace**，所以关闭界面不会再往历史里压新记录（这正是「关掉又被返回键打开」的成因）。预览或工作区里换一个文件（`routeStep` 返回 `swap`：只有文件那一层变了）也是 replace，返回直接离开预览，不会把看过的文件倒着走一遍。`stackAfter` 维护 `+page.svelte` 里的 `routeStack`（本页压过的记录）。
- 手机上的新建是 `Sidebar.svelte` 的 `.fab-wrap`（`position: fixed`、`z-index: 12`：压住列表，但抽屉、弹窗和设置页都比它高，所以不会从遮罩里透出来），只在手机宽度、会话列表这一页上渲染（`selected` 非空即不渲染 —— 会话是另一页，`.side` 那时本来就 `display: none`；归档视图、搜索整页、工作区和设置同理）；菜单开合的标记 `createMenuOpen` 由 `Shell` 持有并双向绑定，它在 `topLayer` 里紧跟 `theme-menu`（菜单永远第一个被返回键和 Escape 收起），切换底栏目的地也会收起它。
- 不在地址里的层由 `topLayer(state)` 定顺序（与 `Shell.svelte` 里 Escape 链一致），`Shell.backMobileLayer()` 按它收起一层并返回 true，`+page.svelte` 的 `beforeNavigate` 据此 `cancel()`。地址里带的层（设置、会话抽屉、Bot 资料、工作区、预览）返回 false，交给历史；只有 `blocksClose()` 为真（未保存/正在保存）时才拦下返回让面板先问。两个易错点：`selfBack` 标记本页自己发起的 `history.back()`，不能被当成用户按返回；`cancelledBack` 标记「返回被应用接住」，此后那次变浅要 replace 而不是 back，因为 cancel 会让 SvelteKit 往前补一步，两者相撞就什么都不动（前向的 popstate 不清这个标记）。
- 手机上的浮层进出用 `mobile-page-slide.ts` 的 `transition:pageSlide`：一条对称的路径，进入 `translateX(100%) → 0`，离开由 Svelte 反向走回去，所以**返回一定是进入的反向**，不需要任何方向状态。曾经按底栏顺序算左右方向，但只有 `navigateMobile` 能更新那个状态，返回键/✕/会话被删都会让它过期并滑错方向——不要再引入这类「上一个目的地」记忆。底栏三个入口（会话 / 工作区 / 设置）后来连整页对滑也去掉了：点一个入口是换目的地，不是推入一页，所以工作区和设置传 `instant: true`，出现和离开都不写 transform。不要把方向切换加回去。非手机宽度与减少动态下同样返回 0 时长，桌面仍走各自的 CSS 动画（工作区 `slideInRight`、设置 `backdropFadeIn`）。从工作区进别的入口时，未保存的文件仍走 `requestCloseFromParent(afterClose)`：保存或丢弃之后才真正关闭并导航，取消保留草稿。`openSettings` 在已打开时是关掉。
- 手机（≤680px）上的设置类界面统一是「分组列表 → 分节」两屏：全局设置在 `SettingsModal`（`mobileSettingsDetail`，720px 断点），Bot 与群组在 `ProfilePane` / `GroupPane`（`mobileDetail`，680px 断点，与样式表一致）。这个标记由 `Shell` 持有并双向绑定，因为抽屉自己的标题栏要在进入分节时让位（`.sheet.session-settings.is-mobile-detail`），而且 `Shell.backWithinSettings()`（由 `+page.svelte` 的 `beforeNavigate` 调用）要先退一层再放行导航。GroupPane 在手机上只渲染打开的那一节，`ProfilePane` 沿用原有标签页内容并靠 CSS 滑动；两者的返回都走各自的 `backFromDetail()`。改断点时记得样式表与 JS 的媒体查询要一起改。从群组点进某个 Bot 时，窄屏打开的就是这个 Bot 的设置页：顶栏返回（`Shell.svelte` 的 `.sheet-back`，≤680px 只显示图标，`aria-label` 是「返回」）和 ✕ 都关掉设置、回到对话，不再退回群组设置。地址上这次是 `swap`：`+page.svelte` 先把返回栈顶的群组设置改成这条对话，再把当前地址替换成 Bot 设置，所以返回落到对话。宽屏仍写出「返回群组设置」，点它回到群组。
- 表单性质的弹窗在手机上是页面，共用一套框架：给遮罩加 `page-on-phone`（`styles/modals.css` 的那段媒体查询）就得到整屏、无圆角、页头 52px + 安全区、✕ 换成 `.modal-back` 的返回箭头（基础样式在 `styles/shared.css`，宽屏隐藏）、底部只留一个整宽主操作。新建 Bot、新建群、记忆编辑、技能编辑都走这套，并各自带 `transition:pageSlide`。**框架里改盒子尺寸那条用了重复类名**（`.page-on-phone > .modal-dialog.modal-dialog`）：每个弹窗都在自己的组件里写了宽高，Svelte 给那些规则加了作用域类，单个类名的全局规则压不住它。确认框（`.confirm-dialog`：危险操作、独立运行时、预览未保存）**仍然是居中对话框** —— 回答一个问题不该把人带离原来那一页 —— 只是手机上两个按钮各占一半、44px 高。模型选择记录（`RouteLog`）、首次向导（`Onboarding`）和远程配对（`PairingScreen`）在手机上也铺满整屏，不再是留一条背景的侧边卡片。
- 手机（≤680px）上的侧栏搜索是一整页：`Sidebar.svelte` 里 `.search-page` 是组件的第二个根元素（`position: fixed`、`z-index: 120`，盖住底栏），列表上那个框只是入口按钮，点开后字段在页头、命中铺满全屏、输入框自动取焦；`Shell` 同时把底栏收掉（`mobileNavigationVisible`）。这一页不进地址，所以由 `topLayer` 的 `search-page` 层收起 —— `Shell.backMobileLayer()` 调 `Sidebar.closeSearchPage()`，它顺手清空输入，因为**离开这一页就等于结束这次搜索**；切换底栏目的地和窗口变宽（媒体查询回到宽屏）也会收起它。宽屏仍是字段下方的 `.search-drop` 下拉，两种形态共用同一份命中列表（`{#snippet hitList()}`）与键盘处理。命中要跳哪里在清空之前算好（`searchJump` 先算、`closeSearchPage()` 后清），否则列表清空后那一行的数据已经不在了。
- 远程客户端（`RemoteApi`）按 `${method} ${path}` 占一个待确认槽位：结果未知时载荷不同的后续请求返回 `409 request_pending`。**结果未知**仅指发送本身失败（连接断了、响应没回来），不包括守护进程明确回答的 `key_write_pending`。这种未知槽位在下一次载荷变化时，会先 `GET /v1/requests/:id` 问回执：404 或 `410 receipt_expired` 说明业务事务从未提交（回执与副作用同一事务），槽位直接让给新载荷；回执存在时只有 **PATCH** 可以接着改（同一实体再 PATCH 一次不会产生重复），POST 之类的新建仍须显式重试/退休，否则会多出一条记录。问不到 Mac 就保持阻塞，绝不猜。页面刷新后恢复的待确认行按未知处理。本机回环没有这条：`/v1/requests/:id` 只在远程 `dispatchBusiness` 上提供，`LocalApi` 保持原来的显式重试。
- `createLocalApi().dispatchBusiness(request, {deviceId, requestId, requireRevision})` 是供后续已认证运输注入的内部接口，不是鉴权器；调用方负责认证/吊销/UV、准入、限额与只读 GET 政策。它拒绝 runtime 和非 `/v1/` 路径，不新增任何 `/remote/*` 回环路由。注入运输与本机HTTP共用快照、会话详情和catchup读取实现及同一同步水印屏障，不再另建读取业务层。`requireRevision: true` 时 PATCH 必带 `if_revision`：实体比较 `updated_at`，设置比较 `settings_rev` 整数；每次成功设置 PATCH 至少递增一次，端点表的任意insert/update/delete及凭据待写/完成也事务性递增，覆盖本机API与Bot直接Store调用。不要假定复合PATCH只增加1。字段从业务体剥离前先进入摘要。远程 Stop 的 204 映射和远程文件 50 MiB 限额仍由后续运输票实现，本机 Stop 语义未改。
- 端点/MCP 凭据先提交业务行 + `pending_keys`（仅名称/值摘要），再 await Keychain，最后提交完成状态。待写期间 GET 的 `key_set/auth_set` 为 false；失败返回 `503 key_write_pending`，**同一请求 id 和原始载荷**可跨重启续办，不新建实体。回执只留字段名、摘要和不含原始密钥的成功响应。其它普通请求不能改删待写凭据实体。`GET /v1/credential-operations` 仅返回 operation id、provider/mcp类型、实体id、拥有者request_id及can_repair，不返回密钥或摘要；删除意图（空密钥摘要）或实体已删除时can_repair=false，界面隐藏修复输入，API拒绝repair且保留清除操作，不能重新写成孤立密钥；`POST /v1/credential-operations/:id/resolve` 的 `{action:"repair",value:"新密钥"}` 或 `{action:"cancel"}` 只接管凭据阶段，取消会删钥匙串项而非回滚已经提交的配置。接管先将旧pending receipt变为409 credential_superseded，防止旧请求恢复原密钥；新操作也有回执和可续办pending状态。正在实际写Keychain的操作拒绝接管。原生 Keychain 删除错误不能吞掉。Bot 直接调用的凭据写失败同样留下未设状态，有独立耐久operation id，可跨重启从上述接口显式修复/取消；没有客户端请求 id 的工具调用不会自动重放。这不是外部工具 exactly-once。
- 批准接口先提交接受结果，不再等 `pending.run()`；工具失败走轮次结果。MCP create/patch 返回提交的配置，检查后的 instructions/tool_catalog 通过后续 `mcp.upsert` 与 GET 更新，不属于首次回执响应。探测写回以 inspected updated_at 做同步CAS，过期/删除/待凭据结果丢弃。凭据业务TX提交时立即发布重新读取的pending状态及removal事件，await完成后重新读取当前状态，不发布旧快照。
- 文件先记 `file_stages` 意图，再同目录 `.real-bot-stage-<id>` 写入+fsync（含目录）；业务 TX 内把意图转成 `file_commits`，提交后 rename+目录 fsync，最后删提交记录。开库先恢复：未提交暂存删除，已提交未 rename 补 rename，已 rename 校验最终 hash；两份都缺或损坏则失败关闭，不启动会读缺失附件的任务。无工作区时持久库的 inbox 使用库所在目录，测试不会落到个人 inbox。工作区切换/路径变化会拒绝正在准备的旧目标。内部软链接的预留、提交与附件路径统一使用规范目标；无工作区时读写都限制在数据库目录内部的规范inbox子树，兼容inbox→uploads别名，但不允许inbox指向数据库目录本身，也不允许读取同目录其它文件或经子软链接逃出inbox；树节点保留逻辑别名避免重复键。空附件不访问工作区路径，不阻断Stop或修复设置。
- 工作区和附件 GET 返回强 ETag `"<明文 SHA-256>"`；当前本机实现读取同一份字节产生 body/hash（本机 GET 仍无上限，超大文件会占内存，远程流式实现不能直接照搬）。工作区 PUT 的 UTF-8 内容仍上限 1,000,000 bytes，仅覆盖已存在的内部文件；本机 If-Match 可选，注入强制版本时必需，失配 409，成功 204 + 新 ETag。信使保存携带**该次加载 blob**的 ETag，冲突保留编辑并提示复制后重开。API、Bot 文件写入使用相同同步路径锁与原子替换，原生窗通过本机 API 保存；shell/任意外部进程不遵守锁，不能声称 POSIX compare-and-swap，检查后到 rename 的外部 TOCTOU 仍存在。

信使LocalApi对可变JSON/multipart调用生成ULID，pending/网络结果未知时只在当前实例内存保留原始载荷，重复显式调用或“重试原请求”复用ID，改载荷先要求解决旧请求；没有定时重试或磁盘队列。凭据接管在内存记录前驱request_id；收到成功或key_write_pending响应即证明接管事务已提交，递归释放前驱载荷。修复本身写钥匙串失败也不再保留已终结的原请求；响应丢失则保留链，后续明确提交的接管可一起清理，绝不为了清理而重放前驱。设置展示pending操作并支持凭据修复/取消，关设置清空修复输入，关页丢掉客户端载荷但daemon操作仍可显式修复。历史回执响应不会覆盖当前设置/端点/MCP快照；信使只消费sync-v1服务端状态，不另取GET合成状态。取消不撤回已提交业务、已发送消息或外部副作用。

验证使用隔离 Store + 内存密钥 + 假模型，不能仅靠 `REAL_BOT_DATA_DIR` 隔离个人 Keychain。新增回执/恢复/ETag 回归在 `apps/daemon/src/receipts.test.ts` 和 `receipt-review.test.ts`，信使 blob/保存回归在 `file-etag.test.ts`。

## CI、落地页与快照发布

仓库在 GitHub Actions 里跑与本地相同的验证，不代替本机 UI 或原生桌面检查。

| 工作流 | 触发 | 做什么 |
|---|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | `main` 推送、PR | `pnpm test`、`pnpm typecheck`、remote/browser、信使与落地页 build、真实 Caddy edge；macOS 上 desktop script tests/typecheck、Swift 凭据 fixture 与 `cargo test` |
| [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) | `main` 推送 | 构建 `apps/landing` 并部署 GitHub Pages |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | 推送 `v*` 标签，或手动 | 再跑验证后打 **未签名** 的 macOS `.dmg` / `.app`，发布为 GitHub **prerelease** |

落地页本地预览：`pnpm --filter @real-bot/landing dev`（5174）。Pages 构建会设 `BASE_PATH=/<仓库名>`，适配 `https://<owner>.github.io/<repo>/`。仓库链接集中在 `apps/landing/src/lib/site.ts`。

落地页首页是随滚动推进的完整流程演示：`apps/landing/src/lib/demo/scenes.ts` 用纯函数按（场景，节拍）算出信使窗口的状态，`SCENE_BEATS` 定义每个场景各节拍的毫秒偏移。十一步演示走同一条故事线：配端点、建 Bot、组群、参与判断、批准卡、交接与命令输出、产物在旁边分出一块窗格、流程图卡片上的模型选择、右键分割开终端、关窗后的横幅与 Dock 角标、配对过的手机经中继接着回消息（`phone` 状态画在桌面上，窗口仍隐藏，`tray.badge` 在手机读过后消掉）；首屏是做完的群聊配流程图。状态里的 `right` / `bottom` / `focus` 描述工作台的窗格（会话窗格右边一列，再往下分一块），有多块窗格时会话窗格按手机布局排、当前窗格描边，和真实的工作台一致。`AppMock.svelte` 只负责把状态画成窗口，`Walkthrough.svelte` 用 IntersectionObserver 决定当前场景并把窗口按容器宽度缩放。中英文案（含各步标题、标注和演示台词）都在 `apps/landing/src/lib/i18n.ts`；改台词或加步骤时同时改两种语言。窗口内标注用 `data-hit` 属性定位界面元素，`Walkthrough.svelte` 里的 `CALLOUT_TARGETS` 指定每步指向哪个元素及偏好的一侧。窄屏（<1024px）下 `Walkthrough.svelte` 用同一批标注元素做「聚焦缩放」：`AppMock` 通过 `onFocus` 回传目标矩形，镜头推到以它为中心、至少 460 设计像素宽的区域；目标还没出现时用 `FOCUS_FALLBACK` 里每步的静态区域；`WHOLE_WINDOW` 里的步骤（关窗后的桌面，横幅在右上、Dock 在底部；竖长的手机）不推镜头，整窗显示。步骤文案可带 `link` 指向某个文档页，显示在正文下面。向上滚动进入的步骤直接显示终态（`skipToEnd`）。文档站由 `apps/landing/src/lib/docs.ts` 把 CONTEXT.md 拆成主题页（`/manifesto` 总览 + `/manifesto/{topic}`），与「指南」组的远程访问页（`/remote`，按语言渲染 `docs/remote-access.md` / `docs/remote-access.zh.md`）、路线图共用 `DocsShell.svelte`：左侧分组导航、右侧本页目录、页底上一页 / 下一页。`docs/` 下文件里的相对链接按该目录解析：指回 README / ROADMAP / CONTEXT 与远程访问指南的落到站内页面，其余指向 GitHub 上的仓库文件；指南首行的另一语言链接在站内去掉，由站点的语言切换代替。术语分组写在 `TERM_GROUPS`；`docs.test.ts` 要求 CONTEXT.md 每个术语都有且仅有一组。HTML 由 `content.server.ts` 的 marked 渲染器生成：术语标题用 `term-` 前缀 id；`_Avoid_:` 行标成 `avoid`。旧的 `/manifesto#term-…` 在总览页会跳到对应主题页。

品牌与 SEO 资产在 `apps/landing/static/`：`favicon.svg` 是标识源文件（消息气泡 + 两个叠放头像），`icon.svg` 是无留白的应用图标源文件，`icon-512.png` / `icon-192.png` / `apple-touch-icon.png` / `favicon-48.png` 由它导出，`site.webmanifest` 引用这些 PNG。`og-zh.png` / `og-en.png` 是 1200×630 的 Open Graph 图。重新生成：起开发服务器后在浏览器里以 1200×630 视口打开 `/og/zh` 与 `/og/en` 截图（该路由 `prerender = false`，只在开发态渲染，不进静态构建）。同一路由还带两个变体：`/og/en?variant=social` 以 1280×640 截出仓库社交预览图 `docs/assets/social-preview.png`；`/og/en?variant=hero&theme=light|dark` 以 1600×900 截出 README 顶部的界面组合图 `docs/assets/readme-hero-light.png` / `readme-hero-dark.png`（三扇窗口：群聊配流程图、待批准卡、产物编辑器；README 用 `<picture>` 按 GitHub 外观切换）；图标则以 512×512 视口打开 `/icon.svg` 截图，再用 `sips -z` 缩到 192 / 180 / 48。每页的 `<title>`、描述、canonical、`hreflang`、Open Graph / Twitter 卡片和首页 JSON-LD 由 `src/lib/Seo.svelte` 输出；绝对 URL 的站点根在 `src/lib/site.ts` 的 `SITE_URL`，换域名时改这一处，`sitemap.xml` 与 `robots.txt`（`src/routes/*/+server.ts` 预渲染）会跟着变。`<html lang>` 由 `src/hooks.server.ts` 按路由语言写入。

下载入口统一指向 `src/lib/site.ts` 的 `LATEST_RELEASE_URL`（`…/releases/latest`）：有正式版后直达最新正式版；目前只有预发布时 GitHub 会跳到 Releases 列表，最新 Alpha 排在最上面。

GitHub 仓库侧的展示信息：描述、主页（落地页地址）和 topics 用 `gh repo edit Blackman99/deskfolk --description … --homepage … --add-topic …` 维护；社交预览图没有 API，改动 `docs/assets/social-preview.png` 后要在仓库 Settings → General → Social preview 手动上传同一张图（GitHub 建议 1280×640）。

主题：页面令牌在 `src/app.css` 的 `:root` 上定义亮色，暗色分别写在 `@media (prefers-color-scheme: dark)` 的 `:root:not([data-theme="light"])` 与 `:root[data-theme="dark"]` 两处，同一块里也定义演示窗口用的 `--app-*` 令牌（取自信使 `styles.css` 的亮 / 暗调色板）。默认跟随系统；导航栏的 `ThemeToggle.svelte` 通过 `src/lib/theme.svelte.ts` 写 `data-theme` 与 `localStorage` 的 `real-bot-theme`（选「跟随系统」即删除两者），`app.html` 里的内联脚本在首屏绘制前读同一个键。演示窗口 `AppMock.svelte` 只引用 `--app-*`，不写死颜色。

桌面 App 图标的源文件是 `apps/desktop/src-tauri/icons/app-icon.svg`（1024 画布、macOS 式圆角方块留透明边距）。改动后在 `apps/desktop` 下执行 `pnpm exec tauri icon src-tauri/icons/app-icon.svg --output src-tauri/icons` 重新生成 `tauri.conf.json` 引用的 `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.icns` / `icon.ico` 以及 Windows 商店尺寸；托盘图标取自窗口默认图标，无需单独维护。SVG 注释里不能出现 `--`，否则 CLI 的 SVG 解析会失败。信使窗口的 favicon 在 `apps/messenger/src/lib/assets/favicon.svg`，与落地页 `static/favicon.svg` 是同一份标识。

release 正文由 `apps/desktop/scripts/release-notes.ts` 生成：按 `tauri.conf.json` 的版本在 `CHANGELOG.md` 里找 `## <版本>` 那一段，正文 = 该段内容 + 未签名说明，`generateReleaseNotes` 关掉。信使的「关于」卡片直接画这份正文（见下一段），所以正文必须是「改了什么」而不是「去看 CHANGELOG」。找不到该段时脚本以非零退出、打包任务失败——发版前先滚 CHANGELOG。GitHub 拒收超过 125,000 字符的正文，一个周期攒得太长时，脚本从较长那种语言的末尾（最早的条目）逐条去掉，并在那一节末尾写明「另有 N 条」、指回 CHANGELOG。脚本的纯函数由 `apps/desktop/scripts/release-notes.test.ts` 覆盖（`pnpm test` 会跑），其中一条直接拿本仓库的 CHANGELOG 和当前版本对，防止两边脱节。

当前没有稳定版或受支持的签名安装包。快照使用 ad-hoc 签名（`signingIdentity: "-"`）。Gatekeeper 可能拦截；优先 `pnpm install` 后 `pnpm dev`。打标签前把 `apps/desktop/src-tauri/tauri.conf.json` 与 `Cargo.toml` 的版本改成与标签一致（去掉 `v` 前缀），否则 `tauri-action` 会按配置里的版本建 release。例如标签 `v0.1.0-alpha.1` 对应配置版本 `0.1.0-alpha.1`。Windows / Linux 不在发布范围。Apple Developer 证书与公证需要以后另配仓库 secrets，不写进工作流。

自动检查更新走「检查 + 应用内下载安装」，浏览器下载作为降级（检查见 [ADR 0015](adr/0015-update-check-via-github-releases.md)，下载与替换见 [ADR 0022](adr/0022-in-app-update-download-and-swap.md)）。窗口进程启动 15 秒后发起首次检查，之后每 6 小时重复一次；设置里的「检查更新」按钮随时可强制刷新。网络请求只在 `apps/desktop/src-tauri/src/updates.rs`（Rust 侧）发出——webview 的 CSP 把 `connect-src` 钉在回环地址，前端本身拿不到 GitHub 的公网访问。结果在 Rust 进程内缓存 30 分钟，非强制检查命中缓存不重复请求。请求的是 `GET /repos/Blackman99/deskfolk/releases?per_page=10` 而不是 `/releases/latest`：仓库目前每个 release 都是 prerelease，`/releases/latest` 会 404。拿到列表后跳过 draft 与无法解析的 tag，按 semver 取最高版本；比较基准是 `tauri.conf.json` 的 `version`（经 `app.package_info()` 读出），当前版本带预发布标识时所有 release 都参与比较，否则只看正式 release。下载按钮按机器架构在 release 资产里找 `Deskfolk_<ver>_aarch64.dmg` / `Deskfolk_<ver>_x64.dmg`，这依赖 `tauri-action` 产出的命名规则；资产改名不会报错，只会让按钮退化成打开发布页。打开外链统一经新命令 `open_external_url`，只放行 `https://github.com/Blackman99/deskfolk/` 前缀，防止把系统浏览器带去任意地址。本地验证可设 `REAL_BOT_UPDATE_FEED=<url>` 让窗口进程改从该地址取 releases JSON：起一个 `python3 -m http.server` 在本地端口提供伪造的 `releases.json`，但里面的 `html_url` / `browser_download_url` 仍必须是真实的 `https://github.com/Blackman99/deskfolk/...` 链接，否则会被打开外链的白名单拒绝。检查结果多带一个 `notes`：所选 release 的正文（空白则为 null）。「关于」卡片发现新版时不只给一个跳浏览器的「查看发布说明」，而是把正文里的 `###` 分组和条目直接列出来（`settings/release-notes.ts` 的 `releaseNoteGroups`，只取标题和列表项，段落和围栏留在发布页）。这里不走聊天的 markdown 渲染器：它会把看着像工作区路径的字串变成产物链接，而 changelog 里全是这种路径。「忽略此版本」只记在信使 webview 的 `localStorage`（键 `real-bot-ignored-update`），不进守护进程的 `Settings` 契约——这是纯界面偏好，浏览器开发态也压根没有可更新的桌面壳。仍然不用 `tauri-plugin-updater`：它要 `latest.json` 加 minisign 签名，而当前构建是 ad-hoc 签名（`signingIdentity: "-"`），没有密钥，`release.yml` 也没开 `uploadUpdaterJson`；关掉验签用它不会比自己这条路更可信。

「下载并安装」按钮走 `apps/desktop/src-tauri/src/installer.rs`：`start_update_install` 先做前置检查（开发态构建、不在 `.app` 里、`.app` 或其父目录不可写都直接拒，信使收到拒绝码后只画浏览器下载），通过了就起一个线程下载到 `<应用缓存目录>/updates/`，信使每 300ms 问一次 `update_install_state` 画进度条（没有 `Content-Length` 时进度条改成来回扫），`cancel_update_install` 取消当前这次并删掉半个包。下载完 `hdiutil attach -nobrowse -readonly -mountrandom` 挂到 staging 下（不挂 `/Volumes`），`plutil` 读包里的 `Info.plist`，identifier 必须是本应用、`CFBundleShortVersionString` 必须正好是这次检查给出的版本，然后 `ditto` 出来、卸载镜像。替换由一段分离出去的 `sh` 脚本做：等窗口进程退出 → `mv` 旧 `.app` 到 staging 当备份 → `ditto` 新的过去（失败就把备份 `mv` 回来）→ 清 quarantine → `open` 回来 → 删 staging 和脚本自身；路径全部以参数传入，脚本里不做字符串插值。窗口这边不是直接 `exit`，走平时的退出路径（守护进程收 `/v1/runtime/quit`、窗口大小落盘），脚本等到的才是干净退出。失败码是稳定的几个（`not-installed` / `read-only` / `bad-url` / `busy` / `download-failed` / `verify-failed` / `install-failed`），信使映射成一句话，技术细节以小字附在下面，并且仍然给「下载更新」这条浏览器降级。开发态（`tauri::is_dev()`）永远答「不能装」，不会替换你正在跑的那份构建。

`ureq` 不读代理环境变量，而 GitHub 在不少机器上只有走代理才通，所以检查和下载都过一层 `HTTPS_PROXY` / `ALL_PROXY`（`NO_PROXY` 命中就不走代理）——只对从带这些变量的 shell 里启动的那份有效，从 Finder 启动的拿不到。要真的验一遍下载 + 挂载 + 校验 + 替换这条链，不必打包：临时在 `installer.rs` 里写一个 `#[ignore]` 测试，用真实的 release 资产 URL 走 `open_asset` → `stream_to_file` → `attach_dmg` → `read_bundle_plist` → `verify_bundle` → `copy_bundle`，再把 `/Applications` 里那份复制到临时目录当替换目标跑一次脚本（`REAL_BOT_OPEN=/usr/bin/true` 拦住重新打开），跑完删掉测试。
