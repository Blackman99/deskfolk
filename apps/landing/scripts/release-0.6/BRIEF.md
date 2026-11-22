# The 0.6.0 release film — brief

A 30.5 s, 1080p30 film for v0.6.0, zh and en. It keeps the 0.5.0 film's form (`../release-0.5`): the release and its
highlights, the reel's mascots with the app's surfaces redrawn, about 30 s landscape, film only (README and site
untouched). Nothing is captured: every surface is drawn in `film.js`. The release's headline is the same native app on
all three desktops (Linux has packages again, Windows catches up with the Mac), so every surface is the NSH app's
(`apps/desktop-nsh/app/src`, copy in `app/src/m/copy`), framed as each system frames it (`apps/desktop-nsh/host/src`:
`win.rs`, `gtk.rs`, `win_tray.rs`, `local_confirm.rs`), and the phone's page is the same app's web build.

The cast, the sprites and the music are the reel's (`../reel`): sprites from `film-out/reel/sprites`, Mixkit audio from
`film-out/reel/assets`. The renderer and the mixer are the 0.1.0 film's (`../release/render.mjs` and `../release/cover.mjs`
with `FILM_DIR` set to this folder, `../release/mix.py`), unchanged; the scene boundaries stay on 0.2.0's bars (4, 10,
14, 19, 24, 26.5), so the music edit (groove, the breakdown at 10–14, the last bar on 26.5) fits as it is.

The Bots' avatars are the app's own folk layers: `folk.mjs` reads the WebP layers from
`packages/protocol/src/folk-avatar-assets.ts`, and the app's icon art (`apps/desktop-nsh/assets/icons/app-icon.svg`, what
`icon.ico` is made from: the Windows tray's and toast's icon), into `<RELEASE_OUT>/folk.json`, which the renderer serves as
`/work/folk.json`. 0.6.0 has no folks of before, so nothing is read from history (no git). The roster is 0.5.0's (剪辑
pudding, 文案 taro, 美术 sakura, 采购 matcha; en Script, Schedule, Illustrator, Clerk), whose characters 0.5.0 checked.

Every platform word is in one `platforms` entry per language in `strings.js`: the opening's chips (icon, text, `new`
badge, `tail`), the three-desktop scene's headline (`head`), subline (`sub`) and desk labels (`desks`), the Windows
taskbar's clock, the end card's `fine`, and the cover's `cover`, `coverHead` and first two chips (`coverChips`). Change
them there; `film.js` and `cover.html` loop and measure what they find.

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.6.0 | bars 0–1 | The name with 0.5.1; both digits shake, the middle rolls to 6 on the 2.0 downbeat and the last to 0 a beat-fraction after; 「60 项更新」/"60 updates"; one chip per `platforms.chips` entry: 「macOS · 已签名、已公证」, 「Windows」, 「Linux 新 · 预览版」 (en "macOS · signed and notarized", "Windows", "Linux new · preview"). Mochi and Pudding cheer, then make room | 60 `###` sections under `## Unreleased` in both changelogs; README.md:27 badge text "macOS · Windows · Linux (preview)"; docs/linux.md:1 "Linux preview (experimental)" |
| 4–10 | One app, three desktops; Windows | bars 2–4 | Three desks side by side, each the same window (sidebar, 剪辑's direct), each framed as its system frames it: a Mac (traffic lights, the window's glass), Linux (opaque ground, GTK's minimize/maximize/close at the top right), Windows in front (Mica, NSH's 46 × 32 caption buttons over the top right, the taskbar's notification area). Labels 「macOS」「Linux · deb · AppImage」「Windows」. Windows comes forward: Settings › 远程控制, the pairing's third step 「Android Chrome 请求配对。」, the device fingerprint, 「批准这台设备」 pressed (6.3); the system's Windows Hello sheet with the app's sentence, four PIN dots; 「已配对。设备现在可以连上这台电脑。」; settings closed (✕); the caption close pressed (7.85): the window is put away, 剪辑 still at work; the tray icon is lit a moment; a toast 「Deskfolk / 有新回复，打开查看」 (8.4); pressed (9.2), the window is back with 剪辑's reply. Pudding presents | `host/src/win.rs`:197-198 (title bar hidden, Mica backdrop when there is material), `app/src/Main.tsx`:40 (NSH draws the caption buttons over the top right), NSH's `nsh-platform-windows/src/chrome.rs` at the pinned rev 5db12913 (`apps/desktop-nsh/Cargo.toml`:18-22; outside this repo, read from the cargo checkout: 46 × 32, Segoe glyphs at 10, close #C42B1C); `host/src/gtk.rs`:85 (title bar hidden), `host/src/launch.rs`:54-58 (glass only on Mac and Windows with Mica); `ui/shell/Shell.tsx`:140 (the main column at the top off the Mac); `ui/sidebar/Sidebar.tsx`:408 (the brand row 16 in, the mark shown), `m/search/shortcuts.ts`:16-20 and `m/keymap.ts`:44-65 (the search well's hint: ⌘K on a Mac, Ctrl+K elsewhere); `ui/settings/SettingsModal.tsx`:671-672, `SettingsNav.tsx`:131, `RemoteTab.tsx`:240-315 (the steps, `hostPairArrived`, `hostPairApprove`, `hostPairDone`), copy `m/copy/remote.ts`:80-83/190-193, `settings.ts` (tab names, `remoteSection`); `host/src/local_confirm.rs`:86-96, 193 ("Deskfolk wants to {verb}: {display}"), `apps/daemon/src/remote/controller.ts`:336 (the device's name, its user agent's first 80 characters, its fingerprint); `app/src/platform/window-life.ts`:22-26, 66-86 (closing hides the window on Windows; the tray's Quit quits); `host/src/win_tray.rs`:191-208 (the tray icon is `icon.ico`); `apps/daemon/src/notifications.ts`:171-198 (`renderDesktopDeliveryContent`, the default toast: title "Deskfolk", body 「有新回复，打开查看」), passed through as they are by `app/src/platform/app-banners.ts`:258, docs/windows.md (toasts under its name and icon; a press opens the conversation) |
| 10–14 | A project session asks (the breakdown) | bar 13, bar 18 | On the Linux window: a Claude Code project session 「改落地页」 in ~/landing, header 「在工作 · Claude Code · ~/landing」. Your line, the agent's line, then the run's foot 「Claude Code 在等你回答」 and under it one card: help-circle, 「Claude Code 有 3 个问题要问你」, three numbered circles at the header's right end; the question, 「选一个」, two options (radio rows with a description), 「自己写，或补充一句…」 and 「下一个」 (dimmed until a choice). Picked (10.72), 下一个 (11.0): step 1 turns tinted, step 2 filled; again; on the last the button already reads 「提交回答」 and is pressed (12.47): the card goes back among the lines (no shadow, 「Claude Code 问了 3 个问题」, the first question with its choice, the other faded, 「已回答 · 13:08」, the time under it) and the run goes on under it: 思考中, then 正在写 and the reply streaming. The Reviewer leans in and nods; the room dims | `ui/chat/project-chat-asks.tsx`:112-166 (one question has no frame; several are one framed card, max 560, steps 22 pt circles: current filled brand, answered tinted, the rest chip), :160 (下一个 while another waiting one has no answer, else 提交回答), :68-74 (which one shows: the picked one, else the first waiting, else the first); `ui/chat/AskCard.tsx`:64-140 (mode label, option rows, radio, the field, the button dimmed until a choice, 「已回答 · time」); `ui/chat/project-chat-working.tsx`:130-156 (the foot, then the asks, last); `ui/chat/project-chat-lines.tsx`:191-205 (answered, back among the lines with the time under them); copy `m/copy/project.ts`:106-111/219-224, `m/copy/stream.ts`:21-24; `ui/chat/PaneChatBar.tsx`:105-160 (logo tile, title, 在工作, agent line) |
| 14–19 | The phone | bars 19–21 | A phone (no maker's marks) with the page installed: 美术's direct (‹, the folk, 「空闲 · claude-sonnet-4-6」, ⋯; the reply with a file chip `poster-final.png`; the docked composer). A tap on the chip (14.55): the file covers the screen (‹, its name, download; 「批注模式」「批注」; the poster). A back swipe from the left edge (15.4–15.95): the file's page slides away and the conversation it covered shows under it (the film's caption 「左滑返回」). ‹ back to the list (the Tools button, the search pill, the Bots, the bottom bar, +); Tools (16.5): the sheet rises (工作区, 日程图, 花费, 用量, 终端, 分工, 已归档会话); 终端 (17.0): the terminal page opens on the session already running (`teaser`, ~/teaser): an ffmpeg encode whose progress line keeps moving; the two rows of keys under it. Mochi points | CHANGELOG 「手机上又能打开文件了」, 「手机上左滑返回…」, 「手机打开终端，接回已经开着的那条…」, 「手机页面换成了桌面应用自己的」; `ui/chat/ChatHeader.tsx`:231-300 (the narrow header), `ui/chat/Composer.tsx` (docked at ≤ 480), `ui/overlays/ArtifactPreview.tsx`:559-601 (the file's header), `ui/overlays/ArtifactAnnotBar.tsx`:41-119 (an image's pills, 32 high on a phone), `ui/sidebar/Sidebar.tsx`:462-494, `SessionRow.tsx`, `ui/MobileNavigation.tsx`:31-56, `ui/sidebar/CreateFab.tsx`:52-63, `ui/sidebar/ToolsMenu.tsx`:180-235, `ui/BottomSheet.tsx`; `ui/overlays/TerminalPage.tsx`:196-265, `m/overlays/terminals.ts`:182-201 (the keys) |
| 19–24 | Send, and drop | bars 21–24 | On the Mac window, 美术's direct: 「人物也换成冷色光」 typed, ⏎ (20.4): the box empties and the line flies (4× slower, said on screen with the ⏎ key): two layers at the bubble's size, the box's words fading out and the bubble fading in, across on one curve and up on another, so it swings across first and rises into place; it lands (21.75) and 美术 starts thinking. Three files dragged in from the desk (a drag image with its count): the composer shows 「松开即添加为附件」 in a dashed brand frame (22.3); dropped (22.75), they wait in the composer above the words: `storyboard.pdf` 2.4 MB, `budget.xlsx` 86.0 KB, `cut-v3.mp4` 212.4 MB, each with ×. Pudding and the Reviewer cheer | `ui/chat/send-flight.tsx`:51-64 (300 ms across on cubic-bezier(0.23, 1, 0.32, 1), 300 ms up on cubic-bezier(0.199, 0.011, 0.279, 0.910), words out 150 ms, bubble in 180 ms, ease-out, the row takes over at 330 ms), :334-337 (the words start where the box's were), :385-394 (two layers crossfade; nothing scales), :228 (only alone, at the latest line, not on the web, not with reduced motion); `ui/chat/composer-drop.tsx`:53-66, copy `m/copy/composer.ts`:35/86; `ui/chat/ComposerAttachments.tsx`:90-117, `m/chat/attachments.ts`:1-5 (sizes); `ui/chat/Composer.tsx`:376-465 (the row: clip, picker, spacer, mic, ✨, Stop while a turn runs, Send) |
| 24–26.5 | And more | bars 24–25 | Six chips: 项目会话能跑 Grok 了 · 项目会话能新开、也能接着聊 Antigravity · 项目会话能接着你终端里的 Codex 会话 · 终端换成 NSH 自己的 · 文件树里能拖着移动文件了 · 手机页首屏少下一半; all three cheer | Each a section of `## Unreleased`, cut to fit 900 px; en from `CHANGELOG.md` |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; Deskfolk 0.6.0, the tagline, 下载 0.6.0 + URL on 28.0, the fine print (`platforms.fine` · MIT · your own endpoints and agents) | — |

No vendor logo or brand is drawn: no Apple, Windows, Linux or distribution marks, no Start button, no Windows Hello
glyph; an agent's mark is a plain tile (sidebar, tab, header, picker). Platforms are named in words and told apart by
their window chrome. Claude Code, Codex, Antigravity, Grok and NSH are named in words where the changelog names them.
What the Bots and you say, the names, files, paths, pairing code, fingerprints, user agent, terminal output and times
are made up for the film; every label that imitates the app is its copy in that language (`strings.js` says where
each is from). Two system surfaces carry the app's words as the app writes them, in both films: the Windows Hello
sentence is English (`local_confirm.rs` has no other), the toast is Chinese (`apps/daemon/src/notifications.ts` has no
other), as 0.5.0 kept the usage menu's Chinese.

## Where the storyboard draft was wrong (the source won)

1. **The question card has no "1/3".** Several questions are one framed card whose header ends in numbered 22 pt
   circles (current filled, answered tinted, the rest grey), `project-chat-asks.tsx`:124-150; one question alone has no
   frame or steps at all (:112-114). The button is 「下一个」 until every other waiting question has an answer, then
   「提交回答」 ("Send answers", not "Submit answers"), :160, `project.ts`:110-111/223-224. Nothing slides: each
   question is its own card, swapped (:153-164).
2. **The card is under the run's foot, not above the composer.** The run's column is its text, its commands, the
   foot 「… 在等你回答」, then the asks (`project-chat-working.tsx`:130-156); answered, they go back among the lines with
   their time (`project-chat-lines.tsx`:191-205). The composer's placeholder does not change
   (`project-chat-composer.tsx`:223).
3. **The agent is Claude Code.** Codex asks only in plan mode (CHANGELOG 「项目会话里的 Agent 能问你问题…」), so the film
   names Claude Code rather than draw plan mode.
4. **Linux's window controls are GTK's, not hidden and not the app's.** `gtk.rs`:85 hides the title bar and NSH places
   GTK's own controls over the top right (fallback layout minimize, maximize, close); Linux has no material, the ground
   is opaque (`launch.rs`:58).
5. **The tray beat moved to Windows.** The Linux tray is given no icon (`app/src/platform/linux-tray.ts`:45-57), so
   what a panel draws there is not in the source; Windows' tray icon is the app's `icon.ico` (`win_tray.rs`:191-208).
   Closing the window on Windows hides it with no animation of the app's (`window-life.ts`:22-26, 66-86); the film
   fades it in a few frames and lights the tray icon a moment so the eye finds it.
6. **The Windows Hello sentence is longer and English only:** 「Deskfolk wants to pair a device for remote access:
   Android Chrome (Mozilla/5.0 … Chrome) · <the device's 64-hex fingerprint>」 (`local_confirm.rs`:86-96, 193;
   `controller.ts`:336), in both films. It comes up from Settings › 远程控制's third step, 「批准这台设备」
   (`RemoteTab.tsx`:267-299); there is no QR code (:7-8).
7. **The toast says no Bot and no reply.** By default a toast is 「Deskfolk」 / 「有新回复，打开查看」 (Chinese only,
   `apps/daemon/src/notifications.ts`:171-198, which the app shows as it gets them, `app-banners.ts`:258); the Bot's name and an excerpt come only with the reply-excerpt preview.
8. **The flight does not scale or morph.** Two layers at the bubble's size crossfade (words out 150 ms, bubble in
   180 ms) while x and y run on separate 300 ms curves; the words start where the box's were (`send-flight.tsx`:51-64,
   334-394). 0.3 s is nine frames, so the film plays it 4× slower and says so, as 0.5.0 did with the fold. It never runs
   on the phone (`platform.os === "web"`, :228).
9. **Dropping files: the veil covers the card's contents,** a dashed 2 pt brand frame with the paperclip and
   「松开即添加为附件」 / "Drop to attach" (`composer-drop.tsx`:53-66); dropped, the files are chips inside the card above
   the words, each a file tile, name, size and × (`ComposerAttachments.tsx`:90-117). The send comes before the drop:
   staged files stop a flight (`Composer.tsx`:264).
10. **The phone's swipe back is Chrome's picture, not the app's.** The app draws nothing for the gesture (its pages'
    transitions are not ported, `Shell.tsx`:16); what changed is that the page under the swipe is the one you go back
    to (CHANGELOG, `app/src/platform/page-route.ts`:149, 342, 468). The film draws the page sliding away over the one under it.
11. **The terminal's keys are glyphs.** Row one Esc ^C ^D ^V, a clipboard icon, ↑, ⏎; row two Ctrl Tab ⇧Tab, a keyboard
    icon, ← ↓ → (`terminals.ts`:182-201); 「粘贴」 and the keyboard's words are labels for screen readers only. The page
    is opened from Tools › 终端 (on a phone the entry reads 终端, not 新建终端, `ToolsMenu.tsx`:192) and reattaches by
    itself, with no 「可接回」 list.
12. **The phone's list page has no title,** only the Tools button, the search pill and the two filters; the bottom bar's
    first tab reads 「Bot」 / "Bots" (`Sidebar.tsx`:462-494, `MobileNavigation.tsx`, `sidebar.ts`:248/499).
13. **And more** takes the sections' words: 「项目会话能跑 Grok 了」, 「项目会话能新开、也能接着聊 Antigravity」, 「项目会话能接着你终端里的
    Codex 会话」, 「文件树里能拖着移动文件了」.
14. **Windows is still a preview in the docs.** The draft's platform line (README.md:27's badge text) has Windows
    without "preview"; the badge's alt text and docs/windows.md:1 ("Windows preview (experimental)") still say preview.
    The film keeps the draft's words in `platforms`; change them there if Windows should say preview.

## What could not be made honest

- **The system's surfaces are approximations:** the Windows Hello sheet (only its sentence is the app's), the toast's
  layout and the taskbar (no Start button, no other apps), GTK's buttons (the fallback layout; a desktop's own
  `gtk-decoration-layout` decides, GNOME's default shows only close), the Windows 11 corner radius, the Mica and glass
  materials, Chrome's back-swipe picture, the phone's frame and status bar.
- **The taskbar badge** (the count of what waits on you on the taskbar button) is left out: the film draws no taskbar
  buttons.
- **The terminal's font** is not set in the source (`NshTerminal.tsx`); the film uses SF Mono at the app's 13/17.
- **The windows use the Mac's fonts** (SF Pro, PingFang SC) on Windows and Linux too.
- The phone's composer, the file page's pills for a cited image and the model name in the phone's header are read from
  the source, not seen on a phone.

## Looks

Light theme throughout (teal accent). 4–10's desks are drawn at 1.3× the app and shown at 0.6 side by side, then the
Windows desk at full size; 10–14 is the Linux window at 1.2× so the card and the line before it both fit; 14–19 a
412 × 892 pt phone page at 0.88×; 19–24 the Mac window at 1.3×.

## Left out on purpose

- Voice input on Windows and Linux (the mic is in every composer, not recorded with); opening files with their app;
  Ctrl+W; the window's size kept.
- Pairing on Linux (a polkit password prompt, `assets/linux/com.real-bot.desktop.policy`), not drawn.
- Grok, Antigravity and Codex sessions (in the chips only); the task map; dark mode.

## Build

```
RELEASE_OUT=<main checkout>/apps/landing/film-out/release-0.6 REEL_OUT=<main checkout>/apps/landing/film-out/reel \
  apps/landing/scripts/release-0.6/build.sh zh      # then en: mix.py measures through one shared file
node apps/landing/scripts/release-0.6/folk.mjs $RELEASE_OUT/folk.json   # once, before stills
FILM_DIR=apps/landing/scripts/release-0.6 RELEASE_OUT=… REEL_OUT=… \
  node apps/landing/scripts/release/render.mjs --lang en --stills 3.3,5,6.7,8.8,11.5,12.8,15.7,17.8,21.2,22.9 --dir <folder>
```

Writes `deskfolk-release-0.6-<lang>{.mp4,-master.mp4,-music-only.mp4,.jpg,-sheet.jpg}` (poster at 3.3 s, the three
platform chips landed). The renderer's Playwright wants its own Chromium headless shell (`pnpm exec playwright install
chromium-headless-shell` once). At boot the film prints a console error (which `render.mjs` passes on) for any
headline, subline, chip, platform line or fine print wider than its room, and for any settings tab or card title cut
short, so both languages are checked without eyeballing. Traps: a child given `visibility: visible` by `show()` stays
on screen under a hidden parent — scenes leave layout (`display: none`) when off; a pose that reads where something is
must come after whatever that frame changes above it; anything the pointer aims at must exist at every frame of its
pass (the answered card's button gives way to its 「已回答」 line); every image is decoded before `film.ready`; cue names
must be keys of `ROUTE` in `../release/mix.py`.

## Share covers

`build.sh` ends with them; alone, `FILM_DIR=apps/landing/scripts/release-0.6 RELEASE_OUT=… REEL_OUT=… node
apps/landing/scripts/release/cover.mjs [--lang zh|en]` captures `cover.html` at 0.1.0's six platform sizes into
`film-out/release-0.6/covers/<lang>-<ratio>-<w>x<h>.jpg`. The words: the name, 0.6.0 with the film's 「60 项更新」 pill,
the headline (`platforms.coverHead`: one native app on Mac, Windows and Linux), four chips (`platforms.coverChips`
Linux 有 deb 和 AppImage / Windows Hello 配对手机, then `cover.chips` 项目会话提问卡 / 手机页就是桌面应用) and the platform line
(`platforms.cover`); the cast cheers beside or under them.
