# The reel — brief

A 30.5 s, 1080p30 film for the top of the README and the site's “Watch the film”: the mascots act the story
while the app's own surfaces, redrawn from the real features, show what it does. Asked for on 2026-10-12:
mascots plus animated UI, 30–36 s, replacing the mascot film in both places.

Cast: **Mochi** (white, you), **Pudding** (mustard with the antenna, the Producer) and the **Reviewer**
(mustard with the folk avatar's headphones). The mark's two circles are Mochi and Pudding.

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Picture | Truth check |
| --- | --- | --- | --- |
| 0–2 | Hand it off | Mochi hops in and types the job into the composer (two rows, as a wide window draws it: the text on top, the tools under it; send in the tint until there is text); it lifts out as your bubble | A line to the group goes to its lead |
| 2–6 | Tickets | The bubble flies to Pudding and becomes the job's title; two ticket rows, each with the Producer making and the Reviewer reviewing; the Reviewer hops in; 「引擎：视频」 in the title row | The lead lays the job out in tickets; owner and reviewer on each row (ADR 0086 rail) |
| 6–10 | It asks first | Pudding reaches for the logo outside the dashed workspace and stops at the edge; the approval card waits on you (「等你批准 · 制片」 under the shield, a soft warn ring; 允许一次 / Always allow / 拒绝); you allow once on the 8.0 downbeat and it settles into a plain card, 「已允许」; the logo comes in | A command outside the workspace waits on an approval card |
| 10–13 | Walk away | Evening; Mochi waves and leaves; Grok Imagine rendering, the app looking again at 30 s, 1 min, 2 min; 「等渲染时不占着一轮 · 监督器每 15 秒看一眼」; done, it wakes the Producer | The app polls external jobs on its own clock and wakes the Bot; the supervisor's 15 s tick |
| 13–17 | A stop for now | Mochi says 「先停一下」: the music stops dead, Pudding goes grey under a hold, the app's receipt 「已停下这里的工作」; 「片尾的 logo 再大一点。」 on 16.0: 已解除, the music drops back in, 「照你这句接着做」 | ADR 0081: your next line lifts the stop and the Bot goes on from it |
| 17–23 | Done has a definition | Pudding says 「做完了！」 and hands in dawn_final.mp4 (the file chip a message draws); 「按你的话加的检查 · 你确认过」: 时长 8.0 秒 fails, 退回返工, Pudding slumps; the second hand-in passes 6.00 s and 1080×1920; the Reviewer drops in, reads three frames, two evidence chips, 审查通过 · 带依据 | Checks derived from your words gate only once you confirm them; the app runs them on each hand-in; the Reviewer rules with evidence |
| 23–26.5 | Come back | One window: the tabs as pills on the ground, the open one over the card; 「怎么样了」, the Producer's own answer (the film as a file chip, the reply's last line under it), the kettle film playing, 已完成 with the engine, checks 2/2 and the verdict, the board's 已完成 column; all three cheer | ADR 0070: the Producer answers itself; ADR 0086: chat, artifact and board side by side |
| 26.5–30.5 | The mark | Mochi and Pudding hop onto the mark and become its circles; Deskfolk, the tagline, 下载 Alpha + URL on 28.0, the fine print, 「画面为示意，按真实功能重绘」 | — |

## Build

```
apps/landing/scripts/reel/build.sh zh   # renders the sprites once (Blender 5.2, ~3 min), shared with en
apps/landing/scripts/reel/build.sh en
```

- `sprites.py` renders each move of each mascot on its own (transparent PNG, 720², orthographic, the
  mascot film's daylight), every move from rest to rest; `sprites.json` lists the frames and where the
  feet are. film.js stands a sprite on a ground line by its feet and keeps its shadow on the ground.
- `film.js` poses everything from t; `seek(t)` resolves once the sprite frames it chose have decoded.
  Text is in `strings.js` (both languages). The timeline helpers are the launch film's (`/launch/lib.js`).
- The app's surfaces follow the messenger's own sources: its light tokens (`styles/tokens.css`), its components'
  sizes (Composer, TranscriptApproval, Button, MarkdownBody's file chip, TranscriptBotGroup's reply and last line,
  WorkbenchLeaf's tabs on the ground) and its one icon set (`icons.ts` shapes, one 1.6 px pen). Sizes are the app's
  px × `--k` (2.3) in `film.css`, the coming-back window × `--kw` (1.8); `K`/`KW` in `film.js` say the same, and `ic()`
  strokes an icon at 38.4 / role grid units so the pen scales with the surface. When the app's look changes, redraw
  from those files.
- `render.mjs` serves the page, the sprites and the kettle frames, and pipes 8 workers' frames to ffmpeg
  (about 20 s for 915 frames). `mix.py` is the launch film's mixer with this film's edit.
- Covers: `python3 ../mascot/cover.py <master.mp4> <out.jpg> --at 22.45 --button 570,430`; the README thumb
  on the site is a crop of the same frame (`static/media/reel-thumb.jpg`).
