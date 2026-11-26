# The 0.7.0 release film — brief

A 30.5 s, 1080p30 film for v0.7.0, zh and en. It keeps the 0.6.0 film's form (`../release-0.6`): the release and its
highlights, the reel's mascots with the app's surfaces redrawn, 30.5 s landscape, film + share covers (README and site
untouched). Nothing is captured: every surface is drawn in `film.js`, truth-checked against `apps/desktop-nsh/app/src`.

The cast, sprites and music are the reel's (`../reel`), and the renderer/cover/mixer are `../release/{render.mjs,cover.mjs,mix.py}`
unchanged, keeping the exact 120 BPM bar boundaries (`4, 10, 14, 19, 24, 26.5`, URL hit at `28.0`).

## Storyboard (120 BPM, a bar every 2 s; final hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.7.0 | bars 0–1 | `0.6.0` shakes and rolls to `0.7.0` on the 2.0 downbeat; 「24 项更新」/"24 updates"; three platform chips from `strings.js` `platforms`. Mochi and Pudding cheer | 24 `###` sections in `CHANGELOG.md` and `CHANGELOG.zh.md` under `## 0.7.0` |
| 4–10 | Git & GitHub pane | bars 2–4 | Mac window showing the shared read-only `Git` workbench pane (`ui/git/GitPane.tsx`): persistent breadcrumb `[deskfolk › feat/git-pane · 4 ↑2 ▾]` and segmented tabs (`改动 / 历史 / GitHub`). Starts on **Changes** (file list + diff lines); pointer opens the Repo → Worktree popover (`GitContextPopover.tsx`) showing `main` (Project dir) and `feat/git-pane` (Current, 4 changes, 2 ahead, paired session chip); switches to **History** (lane graph with `HEAD`, `feat/git-pane`, `main`, `v0.6.0` badges + commit detail); switches to **GitHub** (Current branch PR `#128`, Open, Approved, `Checks passed 6/6`, `Closes #114`, `Quote to composer`). Pudding presents | `ui/git/GitPane.tsx`, `GitContextPopover.tsx`, `GitGraphView.tsx`, `GitHubView.tsx`, copy `m/copy/git.ts` |
| 10–14 | Consultants (breakdown) | bars 13, 18 | Mac window in a Claude Code project session; room dims softly. Pointer opens the `参谋` / `Consult` pill beside `计划` / `Plan` (`ConsultPill.tsx`): switch 「每句话先请参谋」/"Ask them on every line" flips ON with 2 consultants (`Codex · gpt-5.4 · high · Work`, `Grok · grok-4 · medium`). Under the turn, the `请教了 2` / `Consulted 2` card (`ProjectSubagentEntry.tsx`) shows both consultant chips working then finishing, followed by the agent's combined conclusion. The Reviewer inspects and nods | `ui/chat/ConsultPill.tsx`, `ProjectSubagentEntry.tsx`, copy `m/copy/project.ts` |
| 14–19 | Phone upgrades | bars 19–21 | Portrait phone (`412 × 892` at `0.88×`): project session header has the `62%` context ring button at the top right (`ProjectContextTop.tsx`); tap opens the `上下文占用` / `Context usage` bottom sheet (large ring, Used / Context window / Left / Model). Then the tidy composer row with `+`, Plan chip and Consult chip (`ComposerPlus.tsx`): tap `+` opens the `更多` / `More` sheet (Attach, Plan mode switch, Consultants, Model). Then `Mac 屏幕` / `Mac screen`: tap `主屏 ▾` / `Main screen ▾` (`copy/screen.ts`) and pick `屏幕 2` / `Screen 2`, filling the phone width cleanly. Mochi points | `ui/chat/ProjectContextTop.tsx`, `ComposerPlus.tsx`, `m/copy/composer.ts`, `m/copy/screen.ts` |
| 19–24 | Active strip, context & Antigravity | bars 21–24 | Mac window showing the sidebar's new top `进行中 2` / `Active 2` mirror strip (`LiveStrip.tsx`) keeping live sessions anchored above collapsible sections; project session composer shows desktop context ring `68%` (`ProjectContextPill.tsx`) with hover tooltip and a persisted draft; switches to the `用量` / `Usage` tab showing Antigravity's `Google AI Ultra` tier badge, quota rings, auto-pickup note, and Gemini 4 / Claude 5.5 spend estimate note. Pudding and the Reviewer cheer | `ui/sidebar/LiveStrip.tsx`, `ui/chat/ProjectContextPill.tsx`, `m/chat/composer-drafts.ts`, `m/copy/sidebar.ts` |
| 24–26.5 | And more | bars 24–25 | Six chips: phone PDFs open & load on demand · Antigravity picks up when quota resets · Spend estimates Gemini 4 & Claude 5.5 · Stopping a Bot no longer pauses routines · Composer drafts persist per conversation · UI polish across desktop and mobile. All three cheer | Matching sections in `CHANGELOG.md` / `CHANGELOG.zh.md` |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; `Deskfolk 0.7.0`, tagline, `下载 0.7.0` / `Download 0.7.0` + URL on 28.0, fine print | Same end card structure as 0.6.0 |

## Build

```
RELEASE_OUT=<main checkout>/apps/landing/film-out/release-0.7 REEL_OUT=<main checkout>/apps/landing/film-out/reel \
  apps/landing/scripts/release-0.7/build.sh zh
RELEASE_OUT=<main checkout>/apps/landing/film-out/release-0.7 REEL_OUT=<main checkout>/apps/landing/film-out/reel \
  apps/landing/scripts/release-0.7/build.sh en
```
