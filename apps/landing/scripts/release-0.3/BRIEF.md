# The 0.3.0 release film — brief

A 30.5 s, 1080p30 film for v0.3.0 (2026-11-02), zh and en. It keeps the 0.2.0 film's form (`../release-0.2`): the
release and its highlights, the reel's mascots with the app's surfaces redrawn, about 30 s landscape, film only (README
and site untouched). Unlike 0.2.0 nothing is captured: every surface, the 19–24 scene included, is drawn in `film.js`.

The cast, the sprites and the music are the reel's (`../reel`): sprites from `film-out/reel/sprites`, Mixkit audio from
`film-out/reel/assets`. The renderer and the mixer are the 0.1.0 film's (`../release/render.mjs` and `../release/cover.mjs`
with `FILM_DIR` set to this folder, `../release/mix.py`), unchanged; the scene boundaries stay on 0.2.0's bars, so the
music edit (groove, the breakdown at 10–14, the last bar on 26.5) fits as it is. Move a boundary and the splice in mix.py
moves with it.

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.3.0 | bars 0–1 | The name with 0.2.0; its middle digit shakes and rolls over to 3 on the 2.0 downbeat; 「31 项更新」/"31 updates"; macOS 已签名、已公证 · Windows 预览版 | 31 `###` sections under Unreleased in both changelogs (0.3.0's); platform line as `apps/desktop/scripts/release-notes.ts` NOTARIZED_NOTE says it (Developer ID + notarized; Windows installer not signed) |
| 4–10 | Plain (自由) | bars 2–4 | Roles as a tab of its own (分工/Roles, the `nodes` icon), wide: the engines down the left, 通用★ 视频 代码 自由 each with its line, no time; over the map the shown built-in's line and the intro; the map hangs its steps down a spine; 「一件件事」 picked, its switch 开 under 通用. On 6.0 the pointer picks 自由: its row tints, Plain's line takes the head, the switch goes 关, 「一件件事」 and every step that needs it dim to 「已关」, 读句 loses its lock; the map scrolls to 「Bot 的一轮」 (跳数节奏、收尾自检、整理器 已关). Pudding presents | `RolesPage`/`RoutingTab` (wide past 760 app px, drawn at 1.5×: list `clamp(184,22%,248)`, step `clamp(320,46%,420)`); `PlaybookList` (★, `formatListTime(null)` blank for built-ins, `builtinHint`); `PlaybookMap` + `layPlaybookFlow` (spine, ported as is), off = dashed, .55, grey dot, `offShort`; `PlaybookStepDetail` (`runs · name`, Switch, `on`/`off`); `BUILTIN_PLAYBOOKS.plain` = jobs + pacing off, `requires: ["jobs"]` steps follow, reader `onWhile` jobs; copy/routing.ts, copy/playbooks.ts |
| 10–14 | A plan, full screen | bar 13 (breakdown), bar 18 | A Claude Code session in plan mode (计划 on, the plan placeholder), the working bubble 「Claude Code 在等你批准计划」, the plan card scrolling inside; the pointer rests on its head's button (title 「全屏查看」) and presses on 11.25; the plan fills the window, its lines at a reading width, the button now `minimize`, 「批准，开始做 / 接着改」 and 「要改哪里，退出全屏后在输入框里说。」 under it; approved on 13.3, it leaves full screen first; the row says 待审批 then 思考中. The Reviewer thinks, inspects, nods; the room dims | `ProjectPlanCard.svelte` (maximize/minimize `IconButton`, `is-full` fixed inset 0, `--reading-width: 760px`, foot padded to the column, `planHintFull`, `answer()` sets full off first); copy/project.ts plan*, waitingPlan, composerPlaceholderPlan; `agentRunStatus` waiting_approval → 「待审批」 |
| 14–19 | Background tasks | bars 19–21 | Your line; Claude Code replies (dev server in the background, a Monitor, a subagent); under the reply the subagent's chip 「查登录测试 • 运行中」; the working bubble stays, its last line 「3 个后台任务运行中」 as a toggle, the run's time at the right end; the sidebar row reads 「后台任务运行中」. Pressed (15.9), it opens onto 「Claude Code 正在做的 3 件事」: 后台运行 pnpm dev with its output ticking, 监视 tail -f …, 子代理 查登录测试; the subagent's row opens its popup (17.25): its name, `general-purpose · 3 次工具调用`, what it was asked in full, what it said, 「3 次工具调用」, where it is now. Mochi types and points | `ProjectChat.svelte` (`tasksGoing` only once `run.idle` with tasks going; `.stream-foot` toggle; `ProjectTaskSteps`/`TurnStepList`: `nowTitle`, `taskStepRow` = `taskDoing[kind] + command`, output `<pre>`); `placeTasks` (a task started before the reply hangs under it); `ProjectSubagentEntry` (one: chip + live dot + `taskStatus.running`); `ProjectSubagentDialog` (`clamp(900px,45vw,1080px)` capped at 92vw: at the film's window nearly its width); `agentRunStatus` idle → `statusBackground` |
| 19–24 | Bots and Projects | bars 21–24 | A closer window: the sidebar's head the mark alone (the switches at the far end), search, 「Bot」/"Bots" with 制片, 「项目」/"Projects" with the folder shop and two sessions, each row a Bot's size (agent tile, name, time, status or last line). The folder's row shows its + under the pointer; pressed (20.45), its menu hangs under it: 新开 Claude Code 会话 · 新开 Codex 会话 · 打开项目目录 · 在项目目录打开终端. Then the session's row shows Pin and ⋯, its time giving way; Pin (22.55) moves it up to the pinned band, its tile ringed as running. Pudding and the Reviewer look on and cheer | `Sidebar.svelte` (`brand-row`: `BrandMark`, WorkingFilter `activity`, FocusToggle `target`; `ghead` `sidebar.botsTab` and `project.section` with a "+" character; `project-dir-add` hover-only); `ProjectAddMenu` (picksFolder false, no import on a directory's: the agents, a separator, openDir, openTerminal; under the +, right edges aligned); `SessionRow` (grid, `row-actions` pin + more); `AgentAvatar`; `PinnedRoster` (58×60 tile, `is-run` ring) |
| 24–26.5 | And more | bars 24–25 | Six chips: GBK 文本按中文显示 · 很大的文件打开不再卡死 · 手机上一次发多张图 · 项目会话的花费进了花费页 · 第一次启动就能接着终端里的会话 · 新 App 图标，两张脸都露出来; all three cheer | Each a 0.3.0 section: GBK/large Markdown; very large text file; several pictures remotely; spend in Spend; terminal session from first launch; the app icon |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; Deskfolk 0.3.0, the tagline, 下载 0.3.0 + URL on 28.0, the fine print | — |

No vendor logo is drawn: an agent's mark is a plain tile (the app shows the agent's logo there), and the subagent's
facts leave its model out. What the agents, the Bots and you say, the plan, the commands and their output are made up
for the film; every label that imitates the app is its copy in that language (`strings.js` says where each is from).

Left out on purpose: in the step panel, Roles also says which steps 「一件件事」 takes with it (`alsoStops`); it joins
their names with 「、」 in English too, so the film leaves that line out in both languages. A Bot replying with no job
opened is not drawn: a conversation shows no difference a frame could catch, so the headline says it.

## Build

```
RELEASE_OUT=apps/landing/film-out/release-0.3 apps/landing/scripts/release-0.3/build.sh zh
RELEASE_OUT=apps/landing/film-out/release-0.3 apps/landing/scripts/release-0.3/build.sh en
FILM_DIR=apps/landing/scripts/release-0.3 RELEASE_OUT=apps/landing/film-out/release-0.3 \
  node apps/landing/scripts/release/render.mjs --lang en --stills 6.8,12.3,16.9,22.3 --dir <folder>   # stills
```

Writes `apps/landing/film-out/release-0.3/deskfolk-release-0.3-<lang>{.mp4,-master.mp4,-music-only.mp4,.jpg,-sheet.jpg}`
(~20 s render per language). The mix lands at −15 LUFS, as 0.2.0's. Traps: a child given `visibility: visible` by
`show()` stays on screen under a hidden parent — list such children in the scene's `kids`; a pose that reads where
something is (`getBoundingClientRect`, `offsetHeight`) must come after whatever that frame changes above it, since a
render worker starts at any frame.

## Share covers

`build.sh` ends with them; alone, `FILM_DIR=apps/landing/scripts/release-0.3 RELEASE_OUT=apps/landing/film-out/release-0.3
node apps/landing/scripts/release/cover.mjs [--lang zh|en]` captures `cover.html` at 0.1.0's six platform sizes into
`film-out/release-0.3/covers/<lang>-<ratio>-<w>x<h>.jpg`. The words: the name, 0.3.0 with the film's 「31 项更新」 pill,
the headline (Plain, and project sessions at work in the background), four chips (Plain, background tasks, the
full-screen plan, the sidebar's Bots and Projects) and the platform line; the cast cheers, a little left of the room's
middle so the Reviewer stays inside a wide cover.
