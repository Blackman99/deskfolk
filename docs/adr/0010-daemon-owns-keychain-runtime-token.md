# 守护进程独占 Keychain，本机 token 只活在运行时文件

窗会崩、守护进程还在，端点 API key 必须由守护进程自己用 `Bun.secrets` 读写登录钥匙串；Tauri 不碰 Keychain——两个二进制不能静默共享受限项，Stronghold 也不是钥匙串。每个端点一项：`service = com.real-bot.daemon`，`name = endpoint-api-key:<provider-id>`（升级时把旧的 `endpoint-api-key` 拷到默认端点）。本机 token 每次守护进程进程启动新铸，写在 Application Support 里 `0600` 的运行时描述里，不进 Keychain、不进库、不进仓库。浏览器 `WebSocket()` 不能自定义握手头，但 query 会进日志和历史，所以 WebSocket 只在连上后第一条消息里交本机 token，HTTP 仍用 Bearer。
