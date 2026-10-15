# 工作区框住 Bot，不框你 / The workspace bounds Bots, not you

Status: implemented 2026-10-15. Changes what the file routes (`GET /v1/workspace/tree`, `GET /v1/workspace/file`) and the preview open; nothing about what Bots may do outside the workspace changes.

部分被 [ADR 0092](0092-permission-modes.md) 取代（2026-10-16）：「Bot 读写工作区外照旧要批准」不再成立，Bot 要不要等批准由权限模式决定，和在不在工作区无关。 / Superseded in part by ADR 0092 (2026-10-16): a Bot no longer needs your OK because a path is outside the workspace; its permission mode decides.

2026-10-15 一个 Bot 把 landing 页加进 `~/my-projects/curio`（工作区外的一个仓库），回复里写了 `[~/my-projects/curio](~/my-projects/curio)` 和 `[lumen-landing/index.html](lumen-landing/index.html)`。前一个点开报「路径在工作区外」，后一个按工作区解析、找不到；`/` 开头的路径干脆不是链接。你说：「工作区外的文件，文件夹也要支持打开，工作区只是一个用来约束 bot 们工作大致范围的地方。」

On 2026-10-15 a Bot added a landing page to `~/my-projects/curio`, a repository outside the workspace, and its reply linked `[~/my-projects/curio](~/my-projects/curio)` and `[lumen-landing/index.html](lumen-landing/index.html)`. The first answered "path is outside the workspace" when pressed; the second was looked up in the workspace and not found; a path starting with `/` was never a link at all. You said: "Files and folders outside the workspace should open too; the workspace is only where the Bots' work is roughly bounded."

## 决定 / Decisions

1. **写成绝对路径的，在哪就读哪 / A path written absolute is read where it is.** `/x`、`~/x`、`C:\x` 落在工作区外时，两条读路由按本机路径读：文件夹列出里面的东西，文件给字节；和主机浏览同一套符号链接解析，别的用户的家目录不给看，没设工作区也能读。写成相对路径的仍是工作区的，`../x` 仍是越界；写成绝对路径、落在工作区里的照旧按工作区规则。 / When `/x`, `~/x` or `C:\x` lies outside the workspace, the two read routes read it on this machine: a folder lists what is in it, a file gives its bytes, through the same symlink walk as host browsing, never in another user's home, with or without a workspace set. A relative path is still the workspace's, so `../x` is still an escape; an absolute path into the workspace keeps the workspace's rules.

2. **只读 / Read-only.** 保存、移到废纸篓、批注仍只认工作区里的文件：批注要交给能改它的 Bot，工作区外的东西不是 Bot 能随手改的。预览里工作区外的文件源码视图打不了字，没有批注栏，树的右键菜单没有「复制工作区路径」和「移到废纸篓」。 / Saving, the Trash and annotations still take workspace files only: a note goes to a Bot that can act on it, and what lies outside the workspace is not the Bots' to change. In the preview, a file from outside takes no typing in the source view, has no annotation bar, and its tree menu has neither Copy workspace path nor Move to Trash.

3. **消息里的绝对路径是链接 / An absolute path in a message is a link.** POSIX 绝对路径至少两段、不含 `{}<>*?|`、反斜杠和空白才算（`/sidebar`、`/tasks/{id}`、`/\s+/g` 仍是正文）。工作区外的路径各自是文件树顶层的一行，引用过的更深的路径挂在它下面。 / A POSIX absolute path counts with two names or more and none of `{}<>*?|`, backslashes or whitespace (`/sidebar`, `/tasks/{id}`, `/\s+/g` stay text). Each path outside the workspace is a top row of the file tree, holding what else was cited inside it.

4. **手机和窗口一样 / The phone reaches what the window does.** 手机经同一对路由读。手机的预览只按附件 id 打开，没有附件撑着的路径——工作区外的都是——补一行占位，原来点了没反应。 / A paired device reads through the same routes. Its preview opens by attachment id only, so a path no attachment backs — every path outside the workspace — gets a stand-in row; pressing one used to do nothing.

5. **Bot 用绝对路径点名工作区外的文件 / Bots name files outside the workspace by absolute path.** 本地 Agent 的前言加了这一句，应用才打得开。 / The local-agent preface now says so, or the app cannot open them.

## 不变 / Unchanged

- Bot 读写工作区外照旧要批准（[危险动作矩阵](../../CONTEXT.md)、[ADR 0087](0087-always-allow-covers-the-project.md)）。 / A Bot reading or writing outside the workspace still needs your approval.
- 工作区外的路径不挂成附件，交付的约定不变。 / Paths outside the workspace are not attached; hand-over stays as it was.
- 工作区浏览器只列工作区。 / The workspace explorer lists the workspace only.

## 取舍 / Trade-offs

- **配对的设备能读这台 Mac 上你能读的文件。** 和终端（[remote-protocol](../remote-protocol.md)）、主机浏览给它的范围一样，不是新边界。 / **A paired device can read what your account on the Mac can.** That is the reach terminals and host browsing already give it, not a new frontier.
- **反引号里的 `/v1/turns/stop` 这类三段路由也会变成链接**，点开是「找不到」。 / **A three-name route in backticks such as `/v1/turns/stop` becomes a link too**, which opens to "not found".
- **旧消息里相对工作区外目录写的路径仍然打不开**；前言只管以后的回复。 / **Paths in old messages written relative to a folder outside the workspace stay dead**; the preface only helps later replies.

## 实现 / Implementation

`apps/daemon/src/workspace-browse.ts`：`listCitedDir` / `locateCitedFile`（`outsideAbsolute` 决定走哪条），区外交给 `host-paths.ts` 的 `listHostDir` 和新的 `locateHostFile`。`packages/protocol/src/cited-path.ts` 的 `looksLikeWorkspacePath` 认 POSIX 绝对路径。信使：`overlays/artifacts.ts`（`isHostCitedPath`、`citedInWorkspace`、`absWorkspacePath` 带 home）、`artifact-tree.ts`（顶层行）、`artifact-tree-source.svelte.ts`（问一次 `~` 拿 home，列表沿用引用时的写法，菜单）、`ArtifactPreview.svelte`（只读、批注闸门 `outside`）、`session-url.ts` 的 `sanitizeCitedPreviewPath`、`shell-artifact.svelte.ts`（手机的占位行）。`prompts/agent-system.ts` 的前言。
