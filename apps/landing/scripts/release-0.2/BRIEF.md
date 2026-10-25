# The 0.2.0 release film — brief

A 30.5 s, 1080p30 film for v0.2.0 (2026-10-25), zh and en. Asked for on 2026-10-25: 「做一个宣传片来描述这次更新的内容」.
It keeps the 0.1.0 film's form (`../release`): the release and its highlights, the reel's mascots with the app's surfaces
redrawn, about 30 s landscape, film only (README and site untouched).

The cast, the sprites and the music are the reel's (`../reel`): sprites from `film-out/reel/sprites`, Mixkit audio from
`film-out/reel/assets`. The renderer and the mixer are the 0.1.0 film's (`../release/render.mjs` with `FILM_DIR` set to this
folder, `../release/mix.py`); the scene boundaries stay on that film's bars, so its music edit (groove, the breakdown at
10–14, the last bar on 26.5) fits unchanged. Move a boundary and the splice in mix.py moves with it.

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.2.0 | bars 0–1 | The name with 0.1.0; its middle digit shakes and rolls over to 2 on the 2.0 downbeat; 「49 项更新」; macOS 已签名、已公证 · Windows 预览版 | 49 sections under 0.2.0 in both changelogs; release notes' platform line |
| 4–10 | Project sessions | bars 2–4 | The window: the Producer's direct, then the 项目 section's folder `shop`, its + (「新开 Claude Code 会话 / 新开 Codex 会话 / 导入终端会话…」); a session opens on 6.0 and takes your line as its name; 「Claude Code 在等你批准」, the card 「这一步要先问你 · Claude Code」 with `file-write <path>`, 允许 on 8.0, the answer with its file | copy/project.ts newWith, importSession, waiting, approvalHead, allow/deny; summary `${FILE_WRITE_KIND} ${abs}` (claude-code/policy.ts); ADR 0095, 0099 |
| 10–14 | Plan mode | bar 13 (breakdown), bar 18 | Shift + Tab; 计划 turns on, the placeholder becomes the plan one; the plan card 「计划等你批准 · Claude Code」, 「批准，开始做 / 接着改」 and its hint; approved on 13.3 | copy/project.ts plan*, composerPlaceholderPlan; ProjectPlanCard.svelte; ADR 0098 |
| 14–19 | The / list, and Codex | bars 19–21 | `/` lists Claude Code's commands and a skill; the Codex session: no 计划, `/` lists `/compact`, `/review [instructions]`, `/new` and the folder's skill; `/review` sent, and under ask first (the mode scene A showed) one card before it, 「Codex 在等你批准」; 地图 pressed while it waits | Command rows in the agents' own English (Codex's three from agents/codex-commands.ts); Codex has no plan mode or account (caps); the review card's summary and note as project-runner-codex.ts writes them, copy/project.ts waiting |
| 19–24 | The task map | bars 21–24 | The app's own MapScene, afternoon (15:30) into night (22:00): sun to moon and stars, lamps lit; the town turns 26° and comes 10% closer; three Bots at work in their folders | `map/story.js`: a made-up Bot conversation (folders 海报/预告/素材…), `lightAt`, `figureTint`; no real session or folder |
| 24–26.5 | And more | bars 24–25 | Six chips from the release notes' other sections; all three cheer | Each is a 0.2.0 section |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; Deskfolk 0.2.0, the tagline, 下载 0.2.0 + URL on 28.0, the fine print | — |

No vendor logo is drawn: an agent's mark is a plain tile (the app shows the agent's logo there), the map's badges take
the custom-endpoint mark, and its Bots run on no named model.

## Build

```
MESSENGER=<a worktree's apps/messenger> apps/landing/scripts/release-0.2/build.sh zh
MESSENGER=<a worktree's apps/messenger> apps/landing/scripts/release-0.2/build.sh en
FILM_DIR=apps/landing/scripts/release-0.2 RELEASE_OUT=apps/landing/film-out/release-0.2 \
  node apps/landing/scripts/release/render.mjs --lang en --stills 7.6,13,16.6 --dir <folder>   # stills
```

Writes `apps/landing/film-out/release-0.2/deskfolk-release-0.2-<lang>{.mp4,-master.mp4,-music-only.mp4,.jpg,-sheet.jpg}`
(~50 s render per language). The map shot is captured first, once per language (~80 s, 150 frames into `map-<lang>/`),
by `map/capture.mjs` from the visual harness's Vite in the messenger checkout given; a dev server running from this
tree shares its Vite cache, so give a worktree's then. Delete `map-<lang>/` to capture again after a map change.
Trap: a child given `visibility: visible` by `show()` stays on screen under a hidden parent — list such children in the
scene's `kids` so they are hidden when the window is off.
