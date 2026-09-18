# 本机接口是 HTTP 资源加一条只收的事件 WebSocket

窗是客户端，不是运行时。变更走 REST `/v1`；一条 WebSocket 只推事件；重连后的真相是 HTTP 快照，不是事件日志。浏览器 `WebSocket()` 不能自定义 `Authorization`，本机 token 在连上后第一条消息里提交，不进 URL（见 [守护进程独占 Keychain，本机 token 只活在运行时文件](0010-daemon-owns-keychain-runtime-token.md)）。HTTP 仍用 Bearer。环回不是鉴权：token + Origin 白名单（`http://localhost`、`http://127.0.0.1`、`http://[::1]`、`tauri://localhost`；无 Origin 放行）。本机接口在 `17890` 同时听 IPv4 与 IPv6 回环。工作区文件不经本机接口新建或删除；已引用附件的只读字节走 `GET /v1/attachments/:id/content`；整棵工作区浏览走 `GET /v1/workspace/tree` 与 `GET /v1/workspace/file`；覆盖已有区内文本走 `PUT /v1/workspace/file`。退出是已鉴权的 `POST /v1/runtime/quit`，不是杀 PID。

不选双向 WebSocket 或 JSON-RPC：变更要能 `curl` / 单测，协议包里 HTTP 与事件类型分开。不选 SSE：Tauri 窗和开发态浏览器已经要维护 WebSocket。
