# The 0.4.0 release film — brief

A 30.5 s, 1080p30 film for v0.4.0 (2026-11-06), zh and en. It keeps the 0.3.0 film's form (`../release-0.3`): the
release and its highlights, the reel's mascots with the app's surfaces redrawn, about 30 s landscape, film only (README
and site untouched). Nothing is captured: every surface is drawn in `film.js`.

The cast, the sprites and the music are the reel's (`../reel`): sprites from `film-out/reel/sprites`, Mixkit audio from
`film-out/reel/assets`. The renderer and the mixer are the 0.1.0 film's (`../release/render.mjs` and `../release/cover.mjs`
with `FILM_DIR` set to this folder, `../release/mix.py`), unchanged; the scene boundaries stay on 0.2.0's bars (4, 10,
14, 19, 24, 26.5), so the music edit (groove, the breakdown at 10–14, the last bar on 26.5) fits as it is. Move a
boundary and the splice in mix.py moves with it.

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.4.0 | bars 0–1 | The name with 0.3.0; its middle digit shakes and rolls over to 4 on the 2.0 downbeat; 「22 项更新」/"22 updates"; macOS 已签名、已公证 · Windows 预览版 · Linux 预览版 with a 「新」/"new" badge | 22 `###` sections in the 0.4.0 section of both changelogs (the release worktree's rolled section; the film worktree's `## Unreleased` has the same 22); platforms as `apps/desktop/scripts/release-notes.ts` NOTARIZED_NOTE says them in English (Developer ID + notarized; Windows installer unsigned; Linux AppImage and deb an experimental preview), and in zh as the zh changelog's 0.4.0 headline does (已签名并经公证；预览版；新增的 Linux) |
| 4–10 | Ask a Bot to change the look | bars 2–4 | A desk wallpaper with the window on it: the window's glass, the sidebar on it (布丁 open), the pane's tabs, the card with 布丁's direct. You type 「强调色换成紫色，内容区要毛玻璃」 and send (5.2); the turn's line reads 思考中, then 调用 edit_interface. On 6.5 the change applies: the bubble, the line, the header's status, the composer's edge and the notice's ring go purple, the card and its tab let the glass through; 「布丁 改了界面」 slides in at the top right with a grey ⓘ and its countdown ring; under the still-running turn the chip 「界面已改  light --accent: #6d4ae0  撤销」. The reply is written and ends (7.45) with its time line. Pudding presents | ADR 0106 decisions 6–7 and the 2026-11-05 addenda; `prompts/tools/interface.ts` (one `edit_interface` carries `tokens` and `behaviour.content_glass`); `chat/InterfaceChangeChip.svelte` (label, `changes[0]`, Undo); `interfaceChanges()` in `packages/protocol/src/interface.ts` (English keys, light tokens first, sorted); `TranscriptBotGroup.svelte` (no avatar or name on a reply in a direct; the chip under the turn, already while it runs); `turn-activity.ts` (the generic call verb: 调用 / 思考中 · 调用了); `interface/wire.svelte.ts` (the toast in every window); `ToastHost.svelte` (top 48 / right 16, info = grey ⓘ, the ring in `--accent`); `interface/apply.ts` (`--you` follows a look's `--accent`); `styles/content-glass.css` (light frosted keeps 78%, chat and its header paint no ground); `PaneChatBar.svelte`, `ChatTabLabel.svelte`, `Composer.svelte`, `SendButton.svelte` (Stop while the turn runs; empty send in `--accent-tint`) |
| 10–14 | Code colours (the breakdown) | bar 13, bar 18 | The same direct at night, in the dark look (frosted keeps 84%; the strip is the card's head). A reply that is a TS block, its words in GitHub dark on the app's own surface, its head 「TS · 复制代码」. You send 「深色下代码用 Dracula」; 调用 edit_interface; on 11.25 the block repaints in Dracula, background and text too, the notice comes again, and the chip reads `code_theme: {"dark":"dracula"}`. The Reviewer looks closer and nods; the room dims | `INTERFACE_CODE_THEMES` and the code-colours addendum; `MarkdownBody.svelte` (the block on `--code-surface` else `--chip`, `--code-ink` else `--ink`); `code-blocks.ts` (uppercase language, 「复制代码」/"Copy code"); `shiki-highlighter.ts` (github-dark unset); Dracula's own palette (#282a36, #f8f8f2). The Bot set only `tokens.light`, so the dark look keeps the app's teal accent and bubble |
| 14–19 | Steps of your own | bars 19–21 | Roles as a tab of its own, wide: the engines down the left (通用★ shown), its line and the intro over the map, 「收尾自检」 picked. The map glides down 「Bot 的一轮」 to its last card 「＋ 加一个环节」; pressed (15.0), its menu hangs over it (no room under): 「起步模板」, 「收尾前跑测试」 and 「照我的规矩看一遍」 with their hints, then 「＋ 空白环节」. 「收尾前跑测试」 picked (15.9): the panel shows the draft — 「你自己加的环节 · 通用 · 还没存」, its name, the switch 关 (flipped to 开着 on 16.45), 「一轮收尾时」, paths, 命令 `pnpm test`, 600 s — and scrolls down past 「不过时 · 退回接着做」 and the try part to Save (17.6). The step sits after 「监督器接手」, picked: 「收尾前跑测试 你的 / 一轮收尾时 · 不过就退回」; 「不加了」 becomes 「删除这个环节」. Mochi types and points | ADR 0105; `copy/playbooks.ts` `own.*`; `PlaybookMap.svelte` (the add card, a step of your own with 「你的」 and `moment · cardNo`); `playbook-flow.ts` (`hookOfMoment`, add cards on turn / hand-in / accepted / overturned, spine layout ported as is); `PlaybookAddMenu.svelte` (templates of that round only; above the card when it would not fit under); `custom-step-templates.ts` (`tests`: turn_end, `pnpm test`, 600 s, send_back, `on: false`); `RoutingTab.svelte` (a draft is not on the map; after Save the panel's step is the saved one); `CustomStepDetail.svelte` (parts in order; a draft's switch waits for Save; Save then Cancel, or Delete once saved) |
| 19–24 | A Bot's model, from its direct | bars 21–24 | Another direct (剪辑), as the app ships it. The composer's tool row: clip, the picker 「自动 ⌄」, ✨, send. Pressed (19.8), it opens over the field: the endpoints alone (「自动」 ✓ with 「每条消息由应用挑模型」, 「工作端点」 ›, 「本机模型」 ›); pointing at 工作端点 opens its models beside it (20.49), sitting on the field's edge since they would not fit level with the row; pointing at large-2 opens its levels (21.24) level with that model, above the edge; 高 is the pick (22.05). The picker closes; it reads `Custom  large-2 · 高  工作端点`, and the header's second line shows `large-2`. Pudding and the Reviewer look on and cheer | `BotTune.svelte`, `bot-tune.ts` (`endpointTuneTree`: Automatic a pick, endpoint → model → level, widths 240 / 290 / 140; `endpointTuneLabels`: Automatic alone, else mark, model · level, the endpoint's name when more than one lists models); `TunePicker.svelte` (`place()` keeps room for every column inside the window, so the panel moves left over the sidebar; `lineUp()` ported); `ModelSourceMark.svelte` (an endpoint of no known vendor: the word chip `Custom`); `THINKING_LEVELS` (不思考 低 中 高); `PaneChatBar.svelte` (a pinned model in the second line) |
| 24–26.5 | And more | bars 24–25 | Six chips: Linux 预览版：AppImage 和 deb · 提示挪到右上角，带倒计时圈 · 卡在天花板的任务可以「忽略，接着做」 · 输入框里待发的图片能放大看 · 项目列表不再跟着新会话换顺序 · 官网首页成了六章能玩的特性; all three cheer | Each a 0.4.0 section: the Linux preview; notices top right; the ceiling card (`copy/control.ts` ignoreCeiling); a picture in the composer enlarges; projects keep their order; the home page's six features |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; Deskfolk 0.4.0, the tagline, 下载 0.4.0 + URL on 28.0, the fine print (macOS signed and notarized, Windows and Linux previews) | — |

No vendor logo or brand is drawn: an agent's mark is a plain tile, the endpoints (「工作端点」「本机模型」) and models
(large-2, fast-1, …) are made up, and a custom endpoint wears the app's word chip `Custom`. What the Bots and you say,
the code, the paths and the times are made up for the film; every label that imitates the app is its copy in that
language (`strings.js` says where each is from). The chip's middle is English in both languages because the app writes
it so (`interfaceChanges()`).

## Where the storyboard draft was wrong (the source won)

1. The chip is not 「界面已改 · 撤销」: it is the label, the first change as `interfaceChanges()` writes it (English keys
   in both languages, e.g. `light --accent: #6d4ae0`), then 撤销, with no separator (`InterfaceChangeChip.svelte`).
2. The window does not turn after the reply: `edit_interface` applies when the tool runs, and the chip shows under the
   turn while it is still running (`TranscriptBotGroup.svelte`); the reply is written after.
3. The notice 「布丁 改了界面」 does show in the window you asked in: `interface/wire.svelte.ts` raises it for any new
   revision by a Bot (its comment says "from elsewhere"; the code does not check). Drawn with the 0.4.0 notice: top
   right under the tabs, a grey ⓘ, the ring in the accent.
4. A new accent does not repaint the selected sidebar row (it is `--pane` + `--line`), and `--accent-tint` /
   `--accent-border` are fixed teal; only `--selection`, the focus rings and `--you` follow `--accent` (`tokens.css`,
   `apply.ts`). The film's Bot sets the light accent family (accent, hover, tint, border); the chip still shows the
   first, `light --accent`.
5. A code block in the dark look is not on GitHub dark's background: unset, it sits on the app's `--chip` with `--ink`
   text, and only the words are GitHub dark; Dracula brings its own background and text (`MarkdownBody.svelte`,
   `code-theme.ts`). The line you send is the changelog's 「深色下代码用 Dracula」.
6. Roles' card reads 「加一个环节」/"Add a step" (not 「添加一步」), and its menu offers only that round's starting points:
   the turn round has 「收尾前跑测试」 and 「照我的规矩看一遍」, then 「空白环节」 (`templatesFor`). The moment is
   「一轮收尾时」 (not 「回合结束时」); the draft says 「还没存」 (not 「未保存」), in the panel's hint line.
7. A draft is not on the map, and a template starts switched off: Save alone would leave 「已关，不跑」. The film
   switches it to 开着 first (a draft's switch waits for Save), so Save leaves it running: 「一轮收尾时 · 不过就退回」.
8. 「提示」, not 「通知」 (the section and the copy); the ceiling button is 「忽略，接着做」/"Ignore, carry on", not
   「忽略，继续」, and a ticket is 「任务」; on Roles and the cover the app's word is 「环节」, not 「步骤」.

Imprecise rather than wrong: the model columns do open beside their row, but `lineUp()` moves a column back onto the
composer's edge when it would not fit level with its row, so with three endpoints the models sit on the edge and only
the levels float level with large-2; and the picker opens over the sidebar, since `place()` keeps room for all three
columns inside the window.

## Looks

4–10 is a Bot's direct in the app's shipped look until the change, then the user's (purple accent, frosted content).
10–14 is the same profile at night: the Bot set only the light accent, so the dark look keeps the app's own accent and
bubble, while glass content (a behaviour, for both looks) stays frosted. 14–24 are separate features shown as the app
ships (teal; on macOS the window's own glass under the sidebar and between the panes, solid content cards), as
0.3.0's scenes were.

Glass content is subtle by design (a light card keeps 78% of `--pane`). The film draws a saturated wallpaper on the desk
and a thinner system material than the light sidebar usually shows, so the card's tint reads when it turns; the
window's material itself is the film's approximation, not a capture.

## Left out on purpose

- The permission mode is not drawn: a direct shows no mark of it. The change applies at once because the Bot is on
  auto (or allow all); under ask first it would wait on a `ui-edit` card.
- The mic button (only with a speech endpoint set up), hover toolbars, reactions, and the try result and model part of
  a step's panel.
- Windows 11's glass, the phone's sheet versions of the picker and the add menu.
- The other code themes: only Dracula is shown; the list is in the subline's section.
- Linux and the other sections have no picture beyond their chip.

## Build

```
RELEASE_OUT=apps/landing/film-out/release-0.4 apps/landing/scripts/release-0.4/build.sh zh
RELEASE_OUT=apps/landing/film-out/release-0.4 apps/landing/scripts/release-0.4/build.sh en
FILM_DIR=apps/landing/scripts/release-0.4 RELEASE_OUT=apps/landing/film-out/release-0.4 \
  node apps/landing/scripts/release/render.mjs --lang en --stills 5.0,7.6,12.6,15.5,17.9,21.6,22.6,25.0 --dir <folder>   # stills
```

Writes `apps/landing/film-out/release-0.4/deskfolk-release-0.4-<lang>{.mp4,-master.mp4,-music-only.mp4,.jpg,-sheet.jpg}`
(~30 s render per language). The mix lands at −15 LUFS, as 0.3.0's. The renderer's Playwright (1.63) wants its own
Chromium headless shell (`pnpm exec playwright install chromium-headless-shell` once). Traps: a child given
`visibility: visible` by `show()` stays on screen under a hidden parent — list such children in the scene's `kids`; a
pose that reads where something is (`getBoundingClientRect`, `offsetHeight`) must come after whatever that frame
changes above it, and anything the pointer aims at (the add menu, the picker's columns) is laid out every frame of its
scene, shown or not, since a render worker starts at any frame.

## Share covers

`build.sh` ends with them; alone, `FILM_DIR=apps/landing/scripts/release-0.4 RELEASE_OUT=apps/landing/film-out/release-0.4
node apps/landing/scripts/release/cover.mjs [--lang zh|en]` captures `cover.html` at 0.1.0's six platform sizes into
`film-out/release-0.4/covers/<lang>-<ratio>-<w>x<h>.jpg`. The words: the name, 0.4.0 with the film's 「22 项更新」 pill,
the headline (ask a Bot to change the app; steps of your own), four chips (a Bot changes the interface, frosted glass
and code colours, steps of your own, a Bot's model from its direct) and the platform line with Linux; the cast cheers, a
little left of the room's middle so the Reviewer stays inside a wide cover.
