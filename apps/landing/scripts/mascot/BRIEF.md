# Mascot film — brief

A 30.5 s, 1080p30 film in which Deskfolk's two mascots act out the product: **Mochi** (麻薯, the white
teammate in the mark — you) hands a job to **Pudding** (布丁, the mustard one — your Bot), walks away,
and comes back to it done and checked. It ends with both landing on the mark. One render, two
languages: every word is laid over afterwards.

Asked for on 2026-10-08: 16:9, about 30 s, music + effects + zh/en subtitles, this storyboard.

## Storyboard (times on the music's grid: 120 BPM, a bar every 2 s)

| Time | Scene | Picture | Words (zh / en) | Sound |
| --- | --- | --- | --- | --- |
| 0.0–4.0 | Hand-over | The desk in the morning. Mochi types, talks; a teal request bubble pops out and flies to Pudding on the books. Name tags over both. | 一句话，把活交给它 / One sentence hands it the job | breakdown (no kick); pop, whoosh |
| 4.0–10.0 | Work | Pudding hops down to the laptop, takes the bubble, types; three dots over its head. | 它接着干，一步一步来 / It takes it from there, step by step | groove; keystrokes |
| 10.0–14.0 | It asks | Pudding stops, hops and waves; an approval card (two buttons, no words). Mochi nods and lets it through on the 12.0 downbeat. | 要动工作区以外的东西，它先停下来问你 / Before it touches anything outside the workspace, it stops and asks you | breakdown, then the build; pop, click on 12.0 |
| 14.0–20.0 | You leave | Mochi hops off the desk; evening falls, the desk clock spins, Pudding keeps at it. | 交出去，你就可以离开 / Hand it off, then walk away | groove; quiet clock |
| 20.0–26.0 | Back | Next morning Mochi hops back to three handed-in files; each gets a green check; Pudding cheers. | 回来时，活做完了，也查过了 / Come back to work that is done, and checked | groove; pops, checks, pass |
| 26.0–30.5 | The mark | The mark scales up; both hop onto its circles (Mochi left, Pudding right, as in BrandMark). End card on the last hit at 28.0: mark, headline, URL. | 交出去，离开，回来看结果。/ Hand it off. Walk away. Return to results. | the song's last bar; done on 28.0; ring-out |

## Truth checks

- An approval is asked for anything outside the workspace (CONTEXT: 执行前必须批准) — the card scene says exactly that, not "for everything".
- "Checked" means the app ran the checks on the hand-in (做完有定义), not that the Bot said so.
- Mochi stands for you, Pudding for your Bot (BrandMark: Mochi white, Pudding mustard ringed in teal).

## Build

```
apps/landing/scripts/mascot/build.sh zh   # renders the frames once, shared with en
apps/landing/scripts/mascot/build.sh en
```

- `scene.py` (Blender 5.2, EEVEE, 64 samples, ~3 s a frame on an M4 Pro, ~50 min for 916 frames) builds the desk
  from `scene_lib.py`, the two rigs from `rig.py`, the props from `props.py`, and keys `beats.py` into it. It also
  writes `anchors.json`, where each head is on screen while the name tags show. `--still SECONDS --res 40` renders
  one low-res frame for checking a beat.
- `beats.py` is the one timeline: scenes, subtitles, name-tag window and sound cues. `overlay.py` and `mix.py`
  read it too, so a cue and its picture come from one row.
- `overlay.py` lays the words over with Pillow, in the system's PingFang SC / SF (read in place, never copied).
- `mix.py` is the launch film's mixer with this film's bar edit; the music and effects are the launch film's
  Mixkit files (`../launch/fetch-audio.sh`).
- Output in `apps/landing/film-out/mascot/` (gitignored): `deskfolk-mascots-<lang>.mp4`, a music-only cut,
  a poster (`.jpg`, 27.4 s) and a contact sheet. `SHIP=1 build.sh <lang>` also copies the film to
  `apps/landing/static/media/` (the README links to the site's copy) and, for zh, writes the README cover
  `docs/assets/mascots.jpg` with `cover.py` (the poster frame has no words, so both READMEs share it).
- The README opens with this film since 2026-10-08; since 2026-10-10 it is the only film the README and the site link.
