# The 0.1.0 release film — brief

A 30.5 s, 1080p30 film for the first stable release (v0.1.0, 2026-10-19), zh and en. Asked for on 2026-10-19:
「给新版本发布做一个宣传片」; the user chose: the release plus a few highlights, the reel's mascots with redrawn UI,
about 30 s landscape, film only (README and site untouched).

The cast, the sprites and the music are the reel's (`../reel`): sprites from `film-out/reel/sprites`, Mixkit audio
from `film-out/reel/assets`. The timeline helpers are the launch film's (`/launch/lib.js`).

## Storyboard (120 BPM, a bar every 2 s; the song's last hit at 28.0)

| Time | Beat | Music | Picture | Truth check |
| --- | --- | --- | --- | --- |
| 0–4 | 0.1.0 | bars 0–1 | The name with an Alpha pill; Alpha shakes loose and falls on the 2.0 downbeat, 0.1.0 and 「正式版」 land; macOS 已签名、已公证 · Windows 预览版 | Release notes: regular release, macOS signed and notarized, Windows experimental and unsigned |
| 4–10 | The flow | bars 2–4 | A job's flow «0.1.0 之前»: green 「完成」 cards, 「读 Bot 的话 · 还在做」 steps; on 6.0 「现在」: done goes quiet, the readings fold away, the toolbar shows 「环节有异常 1」 and 「显示全部环节」; the red app step and the yellow card pulse | ADR 0094; TraceCard.svelte shapes (line rounded, decision pointed, step slanted, turn with stripe) and colours |
| 10–14 | Focus mode | bar 13 (breakdown), bar 18 | The target beside Deskfolk is pressed on 11.0; time, Bot tag, model tag, command card and the reply's last line fold away; the Bot at work says 「思考中」 | copy/sidebar.ts focusMode; changelog 「专注模式」 |
| 14–19 | Where it is busy | bars 19–21 | Your direct with 制片 is quiet; header and list row say 「在和「审片」私聊 · 思考中」; clicked, the direct opens in its popup; closed, 制片 reports back in your direct | copy/sidebar.ts elsewhere.*; ADR 0091 popup; changelog 「私聊完会回到原来的对话交代结果」 |
| 19–24 | Spend | bars 21–24 | Tiles 金额 / 调用 / 总 token / 缓存命中 / 每日上限 count up, the Token 构成 bar, 用量分布 by Bot with faces, a deleted Bot as its first character, greyed | spend/spend-copy.ts; no vendor logos drawn |
| 24–26.5 | And more | bars 24–25 | Six chips from the release notes' other sections; all three cheer | Each is a 0.1.0 section |
| 26.5–30.5 | The mark | bar 47, ring-out | Mochi and Pudding become the mark; Deskfolk 0.1.0, the tagline, 下载 0.1.0 + URL on 28.0, the fine print | — |

## Build

```
apps/landing/scripts/release/build.sh zh
apps/landing/scripts/release/build.sh en
node apps/landing/scripts/release/render.mjs --lang en --stills 3,8,12.5 --dir <folder>   # stills
```

Writes `apps/landing/film-out/release/deskfolk-release-<lang>{.mp4,-master.mp4,-music-only.mp4,.jpg,-sheet.jpg}` (~16 s render per language).
Trap: a child given `visibility: visible` by `show()` stays on screen under a hidden parent — hide such children when their scene is off.

## Share covers

`node cover.mjs [--lang zh|en]` captures `cover.html` at each platform size into `film-out/release/covers/<lang>-<ratio>-<w>x<h>.jpg`:
16:9 1920×1080 (YouTube, Bilibili, X), 16:10 1920×1200 (Bilibili), 4:3 1440×1080, 1:1 1080×1080 (Weibo, Moments, Instagram),
3:4 1080×1440 (Xiaohongshu, WeChat Channels), 9:16 1080×1920 (Douyin, Shorts, Reels). From 3:2 up the words sit left and the
cast right; narrower covers stack them, centred in the height. Everything is sized in `--u`, 1/1080 of the short side.
