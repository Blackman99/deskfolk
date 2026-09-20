# 本机接口是 HTTP 资源加一条只收的事件 WebSocket

窗是客户端，不是运行时。变更走 REST `/v1`；一条 WebSocket 只推事件；重连后的真相是 HTTP 快照，不是事件日志。浏览器 `WebSocket()` 不能自定义 `Authorization`，本机 token 在连上后第一条消息里提交，不进 URL（见 [守护进程独占 Keychain，本机 token 只活在运行时文件](0010-daemon-owns-keychain-runtime-token.md)）。HTTP 仍用 Bearer。环回不是鉴权：token + Origin 白名单（`http://localhost`、`http://127.0.0.1`、`http://[::1]`、`tauri://localhost`；无 Origin 放行）。本机接口在 `17890` 同时听 IPv4 与 IPv6 回环。工作区文件不经本机接口新建或删除；已引用附件的只读字节走 `GET /v1/attachments/:id/content`；整棵工作区浏览走 `GET /v1/workspace/tree` 与 `GET /v1/workspace/file`；覆盖已有区内文本走 `PUT /v1/workspace/file`。退出是已鉴权的 `POST /v1/runtime/quit`，不是杀 PID。

2026-09 同步补充：新信使在 auth 首帧显式协商 `sync-v1`，先等订阅 `ready`、缓冲，再读取单一 `GET /v1/snapshot`（会话详情是 `/v1/sessions/:id/snapshot`）。同步提交与统一 publish 连续执行，快照在同步读事务里取数据与 `(event_instance_id, watermark_seq)`；客户端只应用同实例连续后继，重复忽略，缺口 / 环溢出 / 重启重取快照。内存回放环最多 2000 条或 16 MiB；实例是每进程和每次清环新抽的 16 字节随机值。token 不回放，工具中间态不进新同步流。省略协议的旧客户端仍收原始帧。字段、catchup 接口和 Store 写入约束见[开发说明](../development.md#快照与事件同步sync-v1)。这不改变 HTTP 变更入口、鉴权边界或默认本机运行模式。

不选双向 WebSocket 或 JSON-RPC：变更要能 `curl` / 单测，协议包里 HTTP 与事件类型分开。不选 SSE：Tauri 窗和开发态浏览器已经要维护 WebSocket。
