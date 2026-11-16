# The 0.5.0 release film — brief

A 30.5 s, 1080p30 film for v0.5.0, zh and en. It keeps the 0.4.0 film's form (`../release-0.4`): the release and its
highlights, the reel's mascots with the app's surfaces redrawn, about 30 s landscape, film only (README and site
untouched). Nothing is captured: every surface is drawn in `film.js`. On the Mac this release ships the native app
(`apps/desktop-nsh`, ADR 0107), so every surface is the NSH app's (`apps/desktop-nsh/app/src`, its copy the messenger's
via `app/src/m/copy`), not the Svelte messenger's.

The cast, the sprites and the music are the reel's (`../reel`): sprites from `film-out/reel/sprites`, Mixkit audio from
`film-out/reel/assets`. The renderer and the mixer are the 0.1.0 film's (`../release/render.mjs` and `../release/cover.mjs`
with `FILM_DIR` set to this folder, `../release/mix.py`), unchanged; the scene boundaries stay on 0.2.0's bars (4, 10,
14, 19, 24, 26.5), so the music edit (groove, the breakdown at 10–14, the last bar on 26.5) fits as it is.

The Bots' avatars are the app's own folk layers, not drawings: `folk.mjs` reads the WebP layers from
`packages/protocol/src/folk-avatar-assets.ts` (and, for the folks as 0.4.0 shipped them, the same file at `ab4f18ca~1`
with a read-only `git show`) into `<RELEASE_OUT>/folk.json`, which the renderer serves as `/work/folk.json`. `film.js`
stacks them as `FolkAvatar.tsx` does and plays each character's work from `ui/taskmap/figure-motions.ts` as pure
functions of t.

Every platform word (the opening's chips, the end card's fine print, the cover's headline and platform line) is in one
`platforms` entry per language in `strings.js`: a list of chips (icon, text, `new` badge, `tail`, `quiet`), `fine`,
`cover`, `coverHead`. Change them there; `film.js` and `cover.html` loop and measure what they find.

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.5.0 | bars 0–1 | The name with 0.4.0; its middle digit shakes and rolls over to 5 on the 2.0 downbeat; 「44 项更新」/"44 updates"; one chip per `platforms.chips` entry: 「macOS 原生应用 新 · 已签名、已公证」/"Native on macOS new · signed and notarized" and 「Windows 原生应用 新 · 预览版」/"Native on Windows new · preview" (Windows added after the first build: the user said the Windows build ships too) | 44 `###` sections under `## Unreleased` in both changelogs; macOS 14 is `LSMinimumSystemVersion` 14.0 in `apps/desktop-nsh/scripts/package.ts` (and `dev.ts`); Developer ID signing and `notarytool` in `package.ts` |
| 4–10 | Native windows | bars 2–4 | A desk wallpaper with the native window: the sidebar (brand row with the working filter, focus and collapse buttons; the search well; 剪辑/文案/美术/采购 as folks; 项目 with its folder and a Claude Code session; the foot), and a pane with 剪辑's direct. ⌘B (5.55): the fold, 4× slower, the factor on screen: the edge eases out, the words fade and draw in towards the avatars before it reaches them, the sidebar's avatars hand over to the rail near the end, the rail's icons grow one after another from the top, a little past their size and back; the pane widens with the edge. ⌘B again (7.45) plays it back. Pudding presents | `ui/shell/sidebar-fold.ts` (every number: the edge's `cubic-bezier(0.25, 0, 0.35, 1)`, `sidebarFoldMs` 280–420 ms, `FOLD_TEXT`, `FOLD_SIDEBAR`, `foldRailIcon` with `RAIL_SPAN` 0.16, `RAIL_STAGGER` 0.008, 0.84 → 1.04 → 1), ported as they are; `ui/sidebar/fold-motion.ts` (who takes `text`, `sidebar`, `railIcon`); `Shell.tsx` (the frame holds both while it folds, each at its own width, the rail over the sidebar's left edge); `Sidebar.tsx`, `SessionRow.tsx`, `sidebar-list.tsx`, `SidebarFoot.tsx`, `SidebarRail.tsx` (on a Mac 84 wide, 40 down, no mark; order: expand, search, working filter, the conversations, the foot last) |
| 10–14 | Out of Claude usage (the breakdown) | bar 13, bar 18 | The desk's top edge is the menu bar. 剪辑 (on Claude Agent; the picker 「默认模型 · 默认思考 me@example.com」) is in a turn: 「运行 pnpm check:subs」 with its own seconds, 「2 分 1 秒」 at the end. The pointer opens the menu bar extra (10.55): `Claude · me@example.com　5h 100% · 7d 64%` in a full red ring, `Claude · studio@example.com　5h 23% · 7d 41%` in a grey ring at 41%, 查看全部用量…; the menu fades out under its separator. The turn carries on with no line in the conversation: 「思考中 · 跑完 pnpm check:subs」, then the reply is written and ends (13.45). The Reviewer leans in and nods; the room dims | ADR 0110 (the same turn goes on in a new session on the next plan account; nothing in the conversation, no notification; all out: the line with the reset and 到时自动接着做, said in the subline); `apps/desktop-nsh/host/src/usage_tray.rs` (`usage_entries`, `account_name`, `window_span`, `used_text`, `level_of`, `ring_pixels`: the ring from twelve o'clock, red from 90%, the track at 35%); `host/src/app.rs` `tray()` (the mark as a template image); `transcript-stream.tsx`, copy `chat.activity` (`run` 运行 / 跑完, `after` 思考中 · …), `spanPart`; `Composer.tsx` (a direct's separate Stop); `BotTune.tsx`, `agent-tune-tree.ts` (`agentTuneLabels`: model · level, the account aside) |
| 14–19 | Files in the preview | bars 19–21 | The rail (the sidebar folded), a Claude Code session 「剪预告片」 and beside it the project's preview pane 「teaser项目目录」 with its file tree, `subs.srt` open. The session's line names `teaser.mp4` as a file chip; pressed (14.58), the video is there at once, paused; play (14.95); a press on the timeline seeks to 00:12 (15.35). The camera moves in (and stays in, following the work). 「在此处批注」 (15.75): the dashed mark, the row becomes `00:12` + 「到此为止」, the note box top right: `00:12`, 「这里切得太急，多留半秒」, 「取消」 「存为草稿」 (16.6). The list opens beside the file (1 条批注, 全部/待处理/已处理/草稿, the draft), the video takes the room left, the send bar comes under the preview: 「1 条批注待发送」, 「按批注改一下」 typed in its field, 「发送批注」 (17.48). Your line goes out with the card in its bubble (the path · 00:12, the note, 待处理); the header says 在工作; the list and the mark turn pending. Mochi points | `ArtifactPreview.tsx`, `ArtifactAnnotBar.tsx` (a video's bar: 「批注 (N)」 only), `ArtifactTree.tsx` (168 default, 12 px rows, 8 + 12 a level; the film's tree is 150), `MediaAnnotator.tsx`, `media-fit.ts`, `AnnotationComposer.tsx` (360 wide, 12 from the top right), `AnnotationList.tsx`, `AnnotationSendBar.tsx`, `AnnotationCards.tsx`; `ProjectChat.tsx`, `project-chat-lines.tsx` (your bubble, 88%, radius 16), `MarkdownBody.tsx` (the file chip); copy `stream.annotMedia`, `stream.annotation*`, `project.live`, `project.composerPlaceholder`, `pane.projectFolderOf`; `formatMediaTime` (`mm:ss`) |
| 19–24 | A Bot's avatar is a map character | bars 21–24 | A closer look at the sidebar (the window's top and right are out of the desk): seven Bots, each its 0.4.0 folk (the mustard Pudding with a sprout, antenna, bow or headphones, from its name). One after another (19.7 + 0.13 s each) each becomes its character: 剪辑 Pudding with its antenna, 文案 taro, 美术 sakura, 采购 matcha, 运维 caramel, 资料 sesame, 特效 blueberry. From 20.95 they are at work, 思考中 or 回复中, each its own way (typing, grooving, painting, whisking, hammering, reading and pushing up its glasses, floating with the wand), dots over its head while it thinks, its mouth going while it replies, the status dot pulsing at its corner; 美术's direct
writes its reply. Pudding and the Reviewer cheer | `packages/protocol/src/folk-avatar.ts` (`folkLook`: the name's hash, the character drawn last; `KEEPS_ARMS_DOWN`), `boring-avatars.ts` `hashCode`; `ui/FolkAvatar.tsx` (layers, origins, the raised arm at rest, the blink, the three dots, the mouth; no `WORK_FX` on an avatar); `ui/taskmap/figure-motions.ts` (`WORK`, `WORK_STILL`, `figureSpecs`: at work every antenna sways); `m/folk-motion.ts` (running and replying both work); `SessionAvatar.tsx` (a single folk has no tile or border; the status dot, `DOT` md 9.5/2, top 9/2, pulsing 0.35–1 over a second) |
| 24–26.5 | And more | bars 24–25 | Six chips: 用久了不再每隔几秒卡半秒 · 搜索不再卡死窗口 · 大文件在预览里打开不再卡住窗口 · 窗口小了，分屏也都留在窗口里 · Antigravity 的 Bot 能用 Deskfolk 的工具了 · 私聊里的模型选择器从运行方式开始选; all three cheer | Each a section of `## Unreleased`; the en chips shortened to fit 900 px |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; Deskfolk 0.5.0, the tagline, 下载 0.5.0 + URL on 28.0, the fine print (`platforms.fine` · MIT · your own endpoints and agents) | — |

No vendor logo or brand is drawn: an agent's mark is a plain tile (in the sidebar, the rail, the header, the picker
and inside the menu's rings), the menu bar shows only the app's mark and a clock, and the player's controls are a
plain floating bar. Claude, Claude Code and Antigravity are named in words where the changelog names them. What the
Bots and you say, the names, files, paths, e-mail addresses and times are made up for the film; every label that
imitates the app is its copy in that language (`strings.js` says where each is from). The menu's usage lines are
Chinese in both languages where the app writes them so (`查看全部用量…`), as 0.4.0 kept the chip's English keys.

## Where the storyboard draft was wrong (the source won)

1. **Bot names are not character names.** The draft named the roster after the characters (布丁 with an antenna, 芋泥
   with headphones…); a Bot's character is drawn from its name's hash (`folkLook`), and a Bot named 布丁 is matcha,
   芋泥 matcha, 樱花 caramel. The film names its Bots with names whose hash gives each character — 剪辑 pudding, 文案
   taro, 美术 sakura, 采购 matcha, 运维 caramel, 资料 sesame, 特效 blueberry; en Script, Schedule, Illustrator, Clerk,
   Infra, Engineer, Designer — checked with the real module, and uses that one roster in every scene.
2. **An avatar at work has no work marks.** Painting flecks, sparks, stars, steam and notes are the task map's
   (`WORK_FX`); `FolkAvatar.tsx` plays only the character's moves (`figureSpecs`), three dots over its head while it
   thinks and its mouth while it replies. "Nodding" and "waving the wand" are drawn as those moves: taro sways its head
   and body, blueberry floats and swings the wand's arm.
3. **"Avatars and buttons stay put" while the words go is only partly so.** The whole brand row (the mark and its
   buttons), the group heads with their +, and the project folder's row carry `fold.text` and go with the words; only the
   rows' avatars, the search well with its magnifier and the foot's icons hold, until the whole sidebar fades between
   32% and 3% open (`FOLD_SIDEBAR`).
4. **The fold is 280 ms, not ~0.4 s.** At the default 260 pt sidebar `sidebarFoldMs` gives its floor, 280 ms (420 ms
   only from a ~400 pt sidebar): about eight frames. The film plays it 4× slower and says so on screen (「4 倍慢放」/
   "4× slower").
5. **Nothing on screen shows the switch.** No client reads `agent.account_switched`, and the composer's picker keeps
   the Bot's own account (ADR 0110 leaves it unchanged). What the app does show is the menu bar's usage lines and a turn
   that carries on with no line, so the film draws those; the all-used-up line is said in the subline, not drawn. The
   menu is drawn as it stands (it asks once a minute): no ring filling up live. An account with no plan reported reads
   `Claude · <email>`; the film names no plan.
6. **The batch is not queued in the composer.** It waits in the preview's own send bar (「1 条批注待发送」, an optional
   summary 「再补一句总话（可不填）」, 「发送批注」, 「清空」), and goes out as your line, its cards inside your bubble.
   After 「存为草稿」 the annotation list opens beside the file, and the video shrinks into the room left.
7. **「在此处批注」 is a plain secondary button under the timeline,** no icon; pressed, the row becomes the time and
   「到此为止」 while the note box (top right of the file, 「取消」 「存为草稿」) is written. Times read `00:12`, not `0:12`.
8. **The video opens paused** (`<Video controls paused>`), so the film presses play; for a video the preview's bar holds
   only 「批注」; on a desktop the preview has no header of its own (its name is the tab, 「teaser项目目录」).
9. **A running Bash step reads 「运行 …」**, not 「调用 Bash」 (`run` is Bash's verb); its own time shows from 3 s, in
   short seconds; a direct's Stop is its own round button beside Send.
10. **The and-more chips** take the sections' words: 「窗口小了，分屏也都留在窗口里」, 「Antigravity 的 Bot 能用
    Deskfolk 的工具了」; the model picker's is 「私聊里的模型选择器从运行方式开始选」.

## What could not be made honest

- **The player's controls are the system's.** The app hands the video to AVPlayerView with `controls`; how it draws
  them is not in this repo. The film draws a plain floating bar (play/pause, elapsed, scrubber, remaining).
- **The menu's lower items** read "Show Deskfolk Dev", "New Window", "Quit Deskfolk Dev" at this commit
  (`host/src/app.rs` hard-codes the dev build's name), so the film fades the menu out under its separator rather than
  guess the release's words.
- The window's and the menu's materials are approximations, as in 0.4.0; the clip in the video is made up (the reel's
  Pudding hopping over drawn hills); whether a playing video keeps playing while the note box is open was not checked
  (the film keeps it playing).
- The folks' easing is NSH's `Easing.inOut(Easing.ease)` approximated with a bezier; the dots' easing is linear.

## Looks

4–10 and 10–14 are the app as it ships on a Mac (light, teal; the window's glass under the sidebar and between the
panes, solid content cards). 14–19 has the sidebar folded to its rail, which shows the rail at rest; the camera moves in
on the preview at 15.0 so its 12 pt labels read, follows down to the send bar and over to your line in the session,
and never past the window's own edges. 19–24 is a closer look (the
window at 1.75×, its top and right outside the desk) so the folks' props read.

## Left out on purpose

- The pointer's hover toolbars, the rows' pin and ⋯, tooltips, the rail's tooltips, the menu bar's other items.
- The model picker's new first level (what runs the Bot): only its chip in 24–26.5.
- The all-used-up line and the pick-up at the reset (in the subline only); project sessions switching accounts.
- The phone, Windows and Linux; dark mode.

## Build

```
RELEASE_OUT=apps/landing/film-out/release-0.5 apps/landing/scripts/release-0.5/build.sh zh
RELEASE_OUT=apps/landing/film-out/release-0.5 apps/landing/scripts/release-0.5/build.sh en
node apps/landing/scripts/release-0.5/folk.mjs apps/landing/film-out/release-0.5/folk.json   # once, before stills
FILM_DIR=apps/landing/scripts/release-0.5 RELEASE_OUT=apps/landing/film-out/release-0.5 \
  node apps/landing/scripts/release/render.mjs --lang en --stills 2.6,6.4,11.6,15.9,17.2,18.2,22.5,25.3,29 --dir <folder>
```

Writes `apps/landing/film-out/release-0.5/deskfolk-release-0.5-<lang>{.mp4,-master.mp4,-music-only.mp4,.jpg,-sheet.jpg}`.
The renderer's Playwright wants its own Chromium headless shell (`pnpm exec playwright install chromium-headless-shell`
once); `folk.mjs` needs git. At boot the film prints a console error (which `render.mjs` passes on) for
any headline, subline, chip, platform line or fine print wider than its room, so both languages are checked without
eyeballing. Traps: a child given `visibility: visible` by `show()` stays on screen under a hidden parent — the scenes'
desks now leave layout (`display: none`) when off, which covers every child; a pose that reads where something is
(`getBoundingClientRect`, `offsetWidth`) must come after whatever that frame changes above it; anything the pointer aims
at is laid out every frame of its scene; every folk layer is decoded before `film.ready`, since a render worker starts
at any frame; cue names must be keys of `ROUTE` in `../release/mix.py`.

## Share covers

`build.sh` ends with them; alone, `FILM_DIR=apps/landing/scripts/release-0.5 RELEASE_OUT=apps/landing/film-out/release-0.5
node apps/landing/scripts/release/cover.mjs [--lang zh|en]` captures `cover.html` at 0.1.0's six platform sizes into
`film-out/release-0.5/covers/<lang>-<ratio>-<w>x<h>.jpg`. The words: the name, 0.5.0 with the film's 「44 项更新」 pill,
the headline (`platforms.coverHead`: Deskfolk is a native app now), four chips (原生窗口 / 额度用完换账号接着做 /
预览里放视频、批注项目文件 / Bot 头像是地图角色, `strings.js` `cover.chips`) and the platform line (`platforms.cover`);
the cast cheers, a little left of the room's middle so the Reviewer stays inside a wide cover.
