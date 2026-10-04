#!/usr/bin/env python3
"""Score and sound for the Deskfolk launch film (numpy only; the system scipy is broken here).

Usage: python3 mix.py <lang> <silent.mp4> <out.mp4> [--music-only] [--lufs -15] [--music-lufs -17]
Reads <work>/<lang>-cues.json (written by render.mjs): cue names + film times, and every visible keystroke.
Writes <out.mp4> (picture copied untouched, AAC 256k) and <work>/mix-<name>.txt (per-event levels).
<work> is apps/landing/film-out/launch (LAUNCH_OUT overrides); fetch-audio.sh puts the library audio in <work>/assets.

Music: Mixkit "Better Times are Coming" (Alejandro Magaña), 120.0 BPM, first downbeat 0.104 s, bars of 2.0 s.
The film is cut on that grid, so the edit is bar-to-bar splices with short equal-power crossfades:
  film  0.0– 2.0  bar 14  (breakdown, no kick) under the cold open
  film  2.0–11.6  bars 0–4 (groove), then a 0.4 s dead stop before the unbacked claim
  film 12.0–18.0  bars 13–15 (breakdown) under the claim, the bounce and the test run
  film 18.0–20.0  bar 18 (build) under the approval
  film 20.0–26.5  bars 19–22 (one beat into 22): the groove returns as the app runs the checks and chases the stall
  film 26.5–28.5  bar 47, the song's last bar: its last hit sits on beat 4, so it lands at 28.0 with the URL
  film 28.5–      the ring-out
Effects: each is levelled inside its own band against the music (50 ms in-band peak, target dB over
the music), capped so the 2–8 kHz lift stays <= 4 dB and the sample peak <= 6 dB over the local music
peak; repeats of one sound share one gain (the class median).
"""
import json, os, re, subprocess, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get('LAUNCH_OUT') or HERE.parents[1] / 'film-out' / 'launch')
SR = 48000
args = sys.argv[1:]
lang, pic, out = args[0], args[1], args[2]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
MUSIC_ONLY = '--music-only' in args
TARGET_LUFS = float(opt('--lufs', '-15'))
MUSIC_LUFS = float(opt('--music-lufs', '-17'))
meta = json.loads((OUT / f'{lang}-cues.json').read_text())
DUR = float(meta['duration'])
N = int(round(DUR * SR))


def load(p, ch=2):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(p), '-ac', str(ch), '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, ch).copy()


def write(p, x):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'pcm_f32le', str(p)], input=np.ascontiguousarray(x, np.float32).tobytes(), check=True)


def loud(x):
    tmp = OUT / '_lufs.wav'; write(tmp, x)
    e = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(tmp), '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', e)[-1]); tp = float((re.findall(r'Peak:\s+(-?[\d.]+) dBFS', e) or ['nan'])[-1]); lra = float((re.findall(r'LRA:\s+([\d.]+) LU', e) or ['nan'])[-1])
    return I, tp, lra


def band(x, lo, hi):
    """Band-pass by FFT mask with half-octave cosine skirts (mono or stereo, along axis 0)."""
    X = np.fft.rfft(x, axis=0); f = np.fft.rfftfreq(len(x), 1 / SR)
    m = np.ones_like(f)
    if lo > 0:
        a, b = lo / 2 ** 0.5, lo
        m *= np.clip((np.log2(np.maximum(f, 1e-9)) - np.log2(a)) / (np.log2(b) - np.log2(a)), 0, 1)
    if hi < SR / 2:
        a, b = hi, hi * 2 ** 0.5
        m *= 1 - np.clip((np.log2(np.maximum(f, 1e-9)) - np.log2(a)) / (np.log2(b) - np.log2(a)), 0, 1)
    m = 0.5 - 0.5 * np.cos(np.pi * m)
    return np.fft.irfft(X * (m[:, None] if x.ndim == 2 else m), len(x), axis=0)


def pk(y, win=0.05):
    h = int(win * SR); y = y if y.ndim == 1 else y.mean(1)
    if len(y) <= h: return 10 * np.log10((y ** 2).mean() + 1e-12)
    return max(10 * np.log10((y[i:i + h] ** 2).mean() + 1e-12) for i in range(0, len(y) - h, h // 2))


def fade(x, a, b):
    x = x.copy(); na, nb = int(a * SR), int(b * SR)
    if na: x[:na] *= (np.sin(np.linspace(0, np.pi / 2, na)) ** 2)[:, None]
    if nb: x[-nb:] *= (np.cos(np.linspace(0, np.pi / 2, nb)) ** 2)[:, None]
    return x


# ------------------------------------------------------------------ music edit
song = load(OUT / 'assets/music/173.mp3')
B0, BAR = 0.104, 2.0
bar = lambda k: B0 + k * BAR
EDIT = [  # film start, film end, song start
    (0.0, 2.0, bar(14)), (2.0, 11.6, bar(0)), (12.0, 18.0, bar(13)), (18.0, 20.0, bar(18)),
    (20.0, 26.5, bar(19)), (26.5, 28.5, bar(47)), (28.5, DUR, bar(48))
]
XF = 0.012  # crossfade, placed just before each bar line so the downbeat transient lands clean
mus = np.zeros((N, 2), np.float32)
for i, (fa, fb, sa) in enumerate(EDIT):
    pre = XF if fa > 0 else 0
    a = int((sa - pre) * SR); n = int((fb - fa + pre + XF) * SR)
    seg = song[a:a + n]
    if len(seg) < n: seg = np.pad(seg, ((0, n - len(seg)), (0, 0)))
    tail_fade = 0.05 if fb == 11.6 else XF
    seg = fade(seg, pre if pre else 0.005, tail_fade if fb < DUR else 0.0)
    o = int((fa - pre) * SR)
    m = min(N, o + n) - o
    mus[o:o + m] += seg[:m]
# ring-out: the last hit decays on its own; a gentle fade guarantees silence at the last frame
fl = int(1.2 * SR); mus[-fl:] *= (np.cos(np.linspace(0, np.pi / 2, fl)) ** 2)[:, None]
# the breakdown carries the film's claim (12–18 s): lift it 2 dB so it reads as tension, not as a hole
lift = np.ones(N, np.float32); a, b, rr = int(12.0 * SR), int(18.0 * SR), int(0.08 * SR)
lift[a:b] = 10 ** (2 / 20); lift[a:a + rr] = np.linspace(1, 10 ** (2 / 20), rr); lift[b - rr:b] = np.linspace(10 ** (2 / 20), 1, rr)
mus *= lift[:, None]
L0 = loud(mus)[0]; mg = 10 ** ((MUSIC_LUFS - L0) / 20); mus *= mg
mono_m = mus.mean(1)

# ------------------------------------------------------------------ effects
def shift(x, semis):
    if not semis: return x
    r = 2 ** (semis / 12); idx = np.arange(0, len(x) - 1, r)
    return np.stack([np.interp(idx, np.arange(len(x)), x[:, c]) for c in range(2)], 1).astype(np.float32)


def soften(x, hp=180, lp=9500, fo=0.04, maxlen=None):
    x = band(x, hp, lp)
    if maxlen: x = x[:int(maxlen * SR)]
    return fade(x, 0.003, min(fo, len(x) / SR / 3))


C = OUT / 'assets/sfx'
SFX = {  # name: (file, semitone shift to the song's key, max length)
    'whoosh': ('1468.mp3', 0, None), 'swish': ('1485.mp3', 0, None), 'click': ('2568.mp3', 0, None),
    'key': ('2841.mp3', 0, 0.12), 'pop': ('3005.mp3', 0, None), 'tick': ('2925.mp3', 0, 0.5),
    'fail': ('216.mp3', 0, None), 'reject': ('2866.mp3', -13, 0.7), 'pass': ('2867.mp3', -1, 0.9),
    'check': ('2357.mp3', 1, None), 'done': ('2870.mp3', -1, 1.2), 'clock': ('2585.mp3', 0, None), 'tap': ('2364.mp3', 0, 0.45)
}
S = {k: soften(shift(load(C / f), s), maxlen=ml) for k, (f, s, ml) in SFX.items()}
S['swish'] = soften(S['swish'], hp=220, lp=4500)  # the bounce-back swish: no top end over a breakdown that has none
# cue name -> (sound, target dB over the music in its band)
# the beats that carry the film's claim (flag, sent back once, 1 failed, allowed) sit 4.5-5 dB up in their band;
# the four whooshes are deliberately low (+1 dB) so transitions never shout over the story
ROUTE = {'whoosh': ('whoosh', 1.0), 'click': ('click', 4), 'enter': ('click', 4), 'pop': ('pop', 3.5), 'tick': ('tick', 3.5), 'key': ('key', 2),
         'fail': ('fail', 5), 'fail!': ('fail', 9), 'flag': ('fail', 5), 'swish': ('swish', -2), 'reject': ('reject', 3), 'pass': ('pass', 4.5), 'check': ('check', 4.5),
         'done': ('done', 4.5), 'clock': ('clock', 2), 'tap': ('tap', 3)}
events = []
for name, t, note in meta['cues']:
    if name in ('type', 'stop'): continue
    if name == 'clock':
        for j in range(4): events.append(('clock', t + j * 0.16, 'quiet clock'))
        continue
    events.append((name, t, note))
for t in meta['keys']: events.append(('key', t, 'keystroke'))
events.sort(key=lambda e: e[1])

HB = (2000, 8000)
MFLOOR, PKFLOOR, HF_CAP, PKCAP, HFLOOR = -48, -22, 4.0, 6.0, -30
solved = []
for name, t, note in events:
    snd, target = ROUTE[name]; s = S[snd]; m1 = s.mean(1)
    F = np.abs(np.fft.rfft(m1 * np.hanning(len(m1)))) ** 2; f = np.fft.rfftfreq(len(m1), 1 / SR); c = np.cumsum(F) / F.sum()
    lo = max(f[np.searchsorted(c, .2)], 80); hi = min(max(f[np.searchsorted(c, .8)], lo * 2), SR / 2 - 1000)
    i = int(t * SR); W = min(len(m1), int(.4 * SR))
    seg = mono_m[max(0, i - SR // 2):i + W + SR // 2]
    if len(seg) < SR + W: seg = np.pad(seg, (0, SR + W - len(seg)))
    o = SR // 2 if i >= SR // 2 else i
    mpk = max(pk(band(seg, lo, hi)[o:o + W]), MFLOOR); epk = pk(band(m1, lo, hi)[:W])
    g = 10 ** ((mpk + target - epk) / 20)
    # the 2-8 kHz cap is measured against a floor: over the breakdown the music's top end is nearly silent,
    # and "+4 dB over nothing" would leave every effect there inaudible
    hf0 = max(pk(band(seg, *HB)[o:o + W]), HFLOOR)
    def hf_lift(g):
        a = seg.copy(); k = min(W, len(a) - o); a[o:o + k] += g * m1[:k]
        return pk(band(a, *HB)[o:o + W]) - hf0
    while hf_lift(g) > HF_CAP and g > 1e-4: g *= .85
    mloc = max(20 * np.log10(np.abs(seg[o:o + W]).max() + 1e-9), PKFLOOR)
    while 20 * np.log10(g * np.abs(m1).max() + 1e-9) > mloc + PKCAP and g > 1e-4: g *= .9
    solved.append([name, t, note, snd, g, lo, hi, target])
# repeats of one sound share a gain: the class median (keys vary +-2 dB so typing is not a machine gun)
# ... but never so far from its own solved level that it vanishes or pokes out (within -1.5 / +2 dB)
for snd in {e[3] for e in solved}:
    gs = [e[4] for e in solved if e[3] == snd]; med = float(np.median(gs))
    for e in solved:
        if e[3] == snd: e[4] = float(np.clip(med, e[4] * 10 ** (-1.5 / 20), e[4] * 10 ** (2 / 20)))
for j, e in enumerate(solved):
    if e[3] == 'key': e[4] *= 10 ** (((np.sin(j * 12.9898) * 43758.5453) % 1 * 4 - 2) / 20)  # deterministic +-2 dB
    if j and e[1] - solved[j - 1][1] < 0.15 and e[3] == solved[j - 1][3] and e[3] != 'key': e[4] *= 0.6

fx = np.zeros_like(mus); rep = []
for name, t, note, snd, g, lo, hi, target in ([] if MUSIC_ONLY else solved):
    s = S[snd]; i = int(t * SR); j = min(N, i + len(s)); fx[i:j] += g * s[:j - i]
    if snd != 'key':
        W = int(.4 * SR); a = max(0, i - SR // 2); seg = mono_m[a:i + W]; o = i - a
        e = np.zeros_like(seg); k = min(len(s), len(seg) - o); e[o:o + k] = g * s[:k].mean(1)
        inb = pk(band(seg + e, lo, hi)[o:o + W]) - pk(band(seg, lo, hi)[o:o + W])
        rep.append(f'{t:6.2f} {snd:7s} band {int(lo):5d}-{int(hi):5d} Hz  target +{target:.1f}  in-band lift {inb:+5.1f} dB  gain {20*np.log10(g):+6.1f} dB  {note}')

mix = mus + fx
# master: integrated loudness to target, then a soft peak guard so the true peak stays under -1 dBFS
Lm = loud(mix)[0]; mix *= 10 ** ((TARGET_LUFS - Lm) / 20)
lim = 10 ** (-1.8 / 20); pkv = np.abs(mix).max()
if pkv > lim:
    # look-ahead limiter on 5 ms blocks: each block's gain covers its own and the next block's peak,
    # releases over ~120 ms, and is interpolated back to samples
    a = int(.005 * SR); nb = -(-len(mix) // a)
    env = np.pad(np.abs(mix).max(1), (0, nb * a - len(mix))).reshape(nb, a).max(1)
    need = np.minimum(1, lim / np.maximum(env, 1e-9)); need = np.minimum(need, np.append(need[1:], 1))
    gb = np.empty(nb); g = 1.0; rel = 1 - np.exp(-1 / 24)
    for k in range(nb):
        g = need[k] if need[k] < g else g + (need[k] - g) * rel
        gb[k] = g
    gain = np.interp(np.arange(len(mix)), np.arange(nb) * a + a / 2, gb)
    mix *= gain[:, None].astype(np.float32)
mix[:int(.005 * SR)] *= np.linspace(0, 1, int(.005 * SR))[:, None]
wav = OUT / f'_mix-{Path(out).stem}.wav'; write(wav, mix)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', pic, '-i', str(wav), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], check=True)
I, tp, lra = loud(mix)
hdr = f'{lang}: music bed {MUSIC_LUFS} LUFS before master; mix {I:.1f} LUFS, LRA {lra}, true peak {tp} dBFS; {len(rep)} effects + {0 if MUSIC_ONLY else sum(1 for e in solved if e[3]=="key")} keystrokes' + (' (music only)' if MUSIC_ONLY else '')
(OUT / f'mix-{Path(out).stem}.txt').write_text(hdr + '\n' + '\n'.join(rep) + '\n')
print(hdr)
