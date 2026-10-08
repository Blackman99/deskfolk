#!/usr/bin/env python3
"""Score and sound for the mascot film (numpy only; the system scipy is broken here).

Music: Mixkit "Better Times are Coming" (Alejandro Magaña), 120.0 BPM, first downbeat 0.104 s, bars of 2.0 s,
the same track and library effects as the launch film (scripts/launch/fetch-audio.sh downloads them).
The film is cut on that grid, so the edit is bar-to-bar splices with short equal-power crossfades:
  film  0.0– 4.0  bars 13–14 (breakdown, no kick): the desk wakes up, the hand-over
  film  4.0–10.0  bars 0–2 (groove): Pudding works
  film 10.0–12.0  bar 15 (breakdown): it stops and asks
  film 12.0–14.0  bar 18 (build): let through on its downbeat
  film 14.0–20.0  bars 19–21 (groove): you leave, it keeps going
  film 20.0–26.5  bars 1–3 and a beat of 4 (groove): back to work done and checked
  film 26.5–28.5  bar 47, the song's last bar: its last hit sits on beat 4, so it lands at 28.0 with the end card
  film 28.5–      the ring-out
Effects are levelled as in the launch film: each inside its own band against the music, capped so the 2–8 kHz
lift stays <= 4 dB and the sample peak <= 6 dB over the local music peak; repeats of one sound share one gain.

Run: python3 mix.py LANG PICTURE.mp4 OUT.mp4 [--music-only]
"""
import json, os, re, subprocess, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import beats

OUT = Path(os.environ.get('MASCOT_OUT') or HERE.parents[1] / 'film-out' / 'mascot')
ASSETS = Path(os.environ.get('MASCOT_ASSETS') or HERE.parents[1] / 'film-out' / 'launch' / 'assets')
SR = 48000
args = sys.argv[1:]
lang, pic, out = args[0], args[1], args[2]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
MUSIC_ONLY = '--music-only' in args
TARGET_LUFS = float(opt('--lufs', '-15'))
MUSIC_LUFS = float(opt('--music-lufs', '-17'))
DUR = beats.DUR
N = int(round(DUR * SR))
OUT.mkdir(parents=True, exist_ok=True)


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
song = load(ASSETS / 'music/173.mp3')
B0, BAR = 0.104, 2.0
bar = lambda k: B0 + k * BAR
EDIT = [  # film start, film end, song start
    (0.0, 4.0, bar(13)), (4.0, 10.0, bar(0)), (10.0, 12.0, bar(15)), (12.0, 14.0, bar(18)),
    (14.0, 20.0, bar(19)), (20.0, 26.5, bar(1)), (26.5, 28.5, bar(47)), (28.5, DUR, bar(48))
]
XF = 0.012  # crossfade, placed just before each bar line so the downbeat transient lands clean
mus = np.zeros((N, 2), np.float32)
for fa, fb, sa in EDIT:
    pre = XF if fa > 0 else 0
    a = int((sa - pre) * SR); n = int((fb - fa + pre + XF) * SR)
    seg = song[a:a + n]
    if len(seg) < n: seg = np.pad(seg, ((0, n - len(seg)), (0, 0)))
    seg = fade(seg, pre if pre else 0.005, XF if fb < DUR else 0.0)
    o = int((fa - pre) * SR)
    m = min(N, o + n) - o
    mus[o:o + m] += seg[:m]
# ring-out: the last hit decays on its own; a gentle fade guarantees silence at the last frame
fl = int(1.2 * SR); mus[-fl:] *= (np.cos(np.linspace(0, np.pi / 2, fl)) ** 2)[:, None]
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


C = ASSETS / 'sfx'
SFX = {  # name: (file, semitone shift to the song's key, max length)
    'whoosh': ('1468.mp3', 0, None), 'swish': ('1485.mp3', 0, None), 'click': ('2568.mp3', 0, None),
    'key': ('2841.mp3', 0, 0.12), 'pop': ('3005.mp3', 0, None), 'tick': ('2925.mp3', 0, 0.5),
    'pass': ('2867.mp3', -1, 0.9), 'check': ('2357.mp3', 1, None), 'done': ('2870.mp3', -1, 1.2),
    'clock': ('2585.mp3', 0, None), 'tap': ('2364.mp3', 0, 0.45)
}
S = {k: soften(shift(load(C / f), s), maxlen=ml) for k, (f, s, ml) in SFX.items()}
S['swish'] = soften(S['swish'], hp=220, lp=4500)
S['tap'] = soften(S['tap'], hp=160, lp=6000)  # a landing, not a click: hops are soft
# cue name -> (sound, target dB over the music in its band)
ROUTE = {'whoosh': ('whoosh', 1.0), 'click': ('click', 4.5), 'pop': ('pop', 3.0), 'tick': ('tick', 3.0), 'key': ('key', 1.5),
         'swish': ('swish', -2), 'pass': ('pass', 4.5), 'check': ('check', 4.0), 'done': ('done', 4.5),
         'clock': ('clock', 2), 'tap': ('tap', 0.5)}
events = []
for t, name in beats.CUES:
    if name == 'clock':
        for j in range(4): events.append(('clock', t + j * 0.16, 'quiet clock'))
        continue
    events.append((name, t, ''))
for a, b in beats.TYPING:
    t, j = a, 0
    while t < b:
        events.append(('key', t, 'keystroke'))
        j += 1
        t += 0.13 + ((j * 0.618) % 1 - 0.5) * 0.04  # a hand, not a metronome
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
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', pic, '-i', str(wav), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-t', f'{DUR}', '-movflags', '+faststart', out], check=True)
I, tp, lra = loud(mix)
hdr = f'{lang}: music bed {MUSIC_LUFS} LUFS before master; mix {I:.1f} LUFS, LRA {lra}, true peak {tp} dBFS; {len(rep)} effects + {0 if MUSIC_ONLY else sum(1 for e in solved if e[3]=="key")} keystrokes' + (' (music only)' if MUSIC_ONLY else '')
(OUT / f'mix-{Path(out).stem}.txt').write_text(hdr + '\n' + '\n'.join(rep) + '\n')
print(hdr)
