# Procedural soundtrack for promo.html: a music bed (120 BPM, D major) plus sound effects laid on the page's cues.
#   python3 audio.py <lang> <work dir>   reads <work>/cues-<lang>.json, writes <work>/mix-<lang>.wav
# Needs only numpy; filters are done in the frequency domain.
import json, os, sys, wave
import numpy as np

LANG = sys.argv[1] if len(sys.argv) > 1 else 'zh'
WORK = sys.argv[2] if len(sys.argv) > 2 else '.'
SR = 48000
meta = json.load(open(os.path.join(WORK, f'cues-{LANG}.json')))
DUR = meta['duration'] + 0.5
N = int(DUR * SR)
rng = np.random.default_rng(7)
music = np.zeros((2, N))
drums = np.zeros((2, N))
sfx = np.zeros((2, N))


def tt(d):
    return np.arange(int(d * SR)) / SR


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def add(buf, t0, sig, gain=1.0, pan=0.0):
    i0 = int(round(t0 * SR))
    if i0 >= N:
        return
    if i0 < 0:
        sig = sig[-i0:]
        i0 = 0
    n = min(len(sig), N - i0)
    a = (np.clip(pan, -1, 1) + 1) * np.pi / 4
    buf[0, i0:i0 + n] += sig[:n] * gain * np.cos(a) * 1.414
    buf[1, i0:i0 + n] += sig[:n] * gain * np.sin(a) * 1.414


def filt(sig, lo=None, hi=None, order=2):
    """Butterworth-shaped magnitude filter in the frequency domain (zero phase)."""
    n = len(sig)
    size = 1 << int(np.ceil(np.log2(n + 1)))
    S = np.fft.rfft(sig, size)
    f = np.fft.rfftfreq(size, 1 / SR)
    H = np.ones_like(f)
    if hi:
        H *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo:
        H *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(S * H, size)[:n]


def env_ar(n, a, r, total=None):
    """attack/release envelope over n samples (seconds)."""
    t = np.arange(n) / SR
    d = n / SR if total is None else total
    e = np.minimum(1, t / max(a, 1e-4))
    e *= np.clip((d - t) / max(r, 1e-4), 0, 1)
    return e


NOISE = rng.standard_normal(SR * 4)
NOISE_HP = filt(NOISE, lo=6000, order=2)
NOISE_BP = filt(NOISE, lo=300, hi=3500, order=2)
NOISE_LP = filt(NOISE, hi=900, order=2)


def noise(kind, d):
    src = {'w': NOISE, 'hp': NOISE_HP, 'bp': NOISE_BP, 'lp': NOISE_LP}[kind]
    n = int(d * SR)
    s = rng.integers(0, len(src) - n - 1)
    x = src[s:s + n]
    return x / (np.std(src) + 1e-9)


# ---------------------------------------------------------------- instruments
def saw_additive(f, t, harmonics, fc):
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        if f * k > 16000:
            break
        w = (1 / k) / np.sqrt(1 + (f * k / fc) ** 4)
        out += w * np.sin(2 * np.pi * f * k * t + k * 0.7)
    return out


def pad(notes, t0, d, gain=0.05, fc=1600):
    t = tt(d + 1.2)
    e = np.minimum(1, t / 0.7) * np.clip((d + 1.2 - t) / 1.2, 0, 1)
    for m in notes:
        f = mtof(m)
        for side, det in ((-0.6, 0.997), (0.6, 1.003)):
            s = saw_additive(f * det, t, 10, fc) * e
            add(music, t0, s, gain, side)


def bass(m, t0, d, gain=0.22):
    t = tt(d)
    f = mtof(m)
    e = np.minimum(1, t / 0.006) * np.exp(-t / 0.35) * np.clip((d - t) / 0.03, 0, 1)
    s = np.sin(2 * np.pi * f * t) + 0.32 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    add(music, t0, np.tanh(1.4 * s * e) * 0.8, gain, 0)


def pluck(m, t0, gain=0.06, pan=0.0, decay=0.32, index=2.2):
    t = tt(decay * 4)
    f = mtof(m)
    s = np.sin(2 * np.pi * f * t + index * np.exp(-t / 0.07) * np.sin(2 * np.pi * f * t))
    s *= np.minimum(1, t / 0.003) * np.exp(-t / decay)
    add(music, t0, s, gain, pan)


def bell(m, t0, gain=0.07, pan=0.0, decay=1.4, buf=None):
    t = tt(decay * 3.5)
    f = mtof(m)
    s = np.sin(2 * np.pi * f * t + 1.6 * np.exp(-t / 0.5) * np.sin(2 * np.pi * f * 3.5 * t))
    s += 0.25 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t / (decay * 0.4))
    s *= np.minimum(1, t / 0.002) * np.exp(-t / decay)
    add(music if buf is None else buf, t0, s, gain, pan)


def kick(t0, gain=0.5):
    t = tt(0.6)
    f = 46 + 120 * np.exp(-t / 0.032)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t / 0.3) + 0.3 * noise('w', 0.6) * np.exp(-t / 0.003)
    add(drums, t0, s, gain, 0)


def clap(t0, gain=0.16):
    t = tt(0.4)
    n = noise('bp', 0.4)
    e = np.exp(-t / 0.09) * (1 + 0.6 * (np.exp(-((t - 0.012) / 0.003) ** 2) + np.exp(-((t - 0.024) / 0.003) ** 2)))
    s = n * e + 0.4 * np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.04)
    add(drums, t0, s, gain, 0.05)


def hat(t0, gain=0.05, open_=False, pan=0.25):
    d = 0.35 if open_ else 0.08
    t = tt(d)
    s = noise('hp', d) * np.exp(-t / (0.12 if open_ else 0.022))
    add(drums, t0, s, gain, pan)


def shaker(t0, gain=0.018):
    t = tt(0.1)
    s = noise('hp', 0.1) * np.minimum(1, t / 0.02) * np.exp(-t / 0.03)
    add(drums, t0, s, gain, -0.3)


# ---------------------------------------------------------------- music
BEAT = 0.5
BAR = 2.0
ORIGIN = 0.5
CH = {
    'D': ([50, 57, 61, 64, 66], 38),
    'Bm': ([47, 54, 57, 62, 66], 35),
    'G': ([43, 50, 54, 59, 66], 31),
    'A': ([45, 52, 57, 61, 64], 33),
    'Bm9': ([47, 54, 61, 62], 35),
}
LOOP = ['D', 'Bm', 'G', 'A']
ARP = [0, 2, 4, 1, 3, 4, 2, 1]


def section_bars(t0, t1):
    k = int(round((t0 - ORIGIN) / BAR))
    while ORIGIN + k * BAR < t1 - 1e-6:
        yield k, ORIGIN + k * BAR
        k += 1


# intro: dark Bm9 pad, heartbeat
pad(CH['Bm9'][0], 0.0, 8.3, gain=0.035, fc=700)
for b in [0.5, 2.5, 4.5, 6.5]:
    t = tt(0.5)
    s = np.sin(2 * np.pi * 61.7 * t) * np.exp(-t / 0.16)
    add(music, b, s, 0.22)
    add(music, b + 0.28, s, 0.12)

# title: bright D with a rising bell motif
pad(CH['D'][0], 8.5, 3.9, gain=0.045, fc=2400)
bass(38, 8.5, 1.9, 0.2)
for i, (m, dt) in enumerate([(74, 0.0), (78, 0.5), (81, 1.0), (88, 1.5)]):
    bell(m, 8.5 + dt, gain=0.06, pan=[-0.3, 0.1, 0.3, 0][i])


def groove(t0, t1, level=1.0, arp=True, bells=False, sixteenth=False):
    for k, b in section_bars(t0, t1):
        name = LOOP[k % 4]
        notes, root = CH[name]
        pad(notes, b, BAR, gain=0.036 * level, fc=1800)
        for j in range(8):  # bass eighths
            bass(root + (12 if j in (3, 7) else 0), b + j * 0.25, 0.23, 0.17 * level)
        for j in range(4):
            bt = b + j * BEAT
            if j in (0, 2):
                kick(bt, 0.46 * level)
            if j in (1, 3):
                clap(bt, 0.13 * level)
            hat(bt + 0.25, 0.045 * level)
            shaker(bt, 0.016 * level)
            shaker(bt + 0.125, 0.012 * level)
            shaker(bt + 0.375, 0.012 * level)
        if k % 2 == 1:
            kick(b + 1.75, 0.3 * level)
        if arp:
            steps = 16 if sixteenth else 8
            for j in range(steps):
                m = notes[ARP[j % 8]] + 24 if notes[ARP[j % 8]] < 55 else notes[ARP[j % 8]] + 12
                pluck(m, b + j * (BAR / steps), gain=0.05 * level, pan=0.35 if j % 2 else -0.35, decay=0.22)
        if bells and k % 2 == 0:
            top, low = [(81, 78), (78, 74), (76, 73), (78, 76)][k // 2 % 4]
            bell(top, b, 0.045 * level, 0.2)
            bell(low, b + 1.0, 0.035 * level, -0.2)


groove(12.5, 22.5, level=0.85, arp=False)
groove(22.5, 43.5, level=1.0)
# quiet: the plan went still
pad(CH['Bm9'][0], 43.5, 3.0, gain=0.03, fc=600)
for b in [44.5]:
    t = tt(0.5)
    s = np.sin(2 * np.pi * 61.7 * t) * np.exp(-t / 0.16)
    add(music, b, s, 0.18)
    add(music, b + 0.28, s, 0.1)
groove(46.5, 58.5, level=1.0)
groove(58.5, 74.5, level=1.0, bells=True)
groove(74.5, 78.5, level=1.05, sixteenth=True, bells=True)
# build: snare roll into the end hit
for i in range(24):
    u = i / 24
    tr = 76.5 + 2.0 * (1 - (1 - u) ** 1.6)
    clap(tr, 0.05 + 0.1 * u)
# end: big D, bell motif, long tail
pad(CH['D'][0] + [69, 73], 78.5, 6.2, gain=0.05, fc=2600)
t = tt(6.5)
add(music, 78.5, np.sin(2 * np.pi * mtof(38) * t) * np.exp(-t / 2.2) * np.minimum(1, t / 0.01), 0.22)
for i, (m, dt) in enumerate([(74, 0.6), (78, 1.1), (81, 1.6), (86, 2.1), (88, 2.6)]):
    bell(m, 78.5 + dt, gain=0.055, pan=[-0.3, 0.1, 0.3, -0.1, 0][i], decay=1.8)

# sidechain pump on the music bus from the kicks
duck = np.ones(N)
for k, b in section_bars(12.5, 78.5):
    if 43.5 <= b < 46.5:
        continue
    for j in (0, 2):
        i0 = int((b + j * BEAT) * SR)
        n = min(int(0.45 * SR), N - i0)
        tt_ = np.arange(n) / SR
        duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], 1 - 0.35 * np.exp(-tt_ / 0.12))
music *= duck


# ---------------------------------------------------------------- sfx
PENTA = [74, 76, 78, 81, 83, 86, 88]


def s_pop(p=0):
    f = mtof(PENTA[int(p) % len(PENTA)])
    t = tt(0.25)
    fr = f * (0.78 + 0.22 * np.minimum(1, t / 0.025))
    s = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.minimum(1, t / 0.002) * np.exp(-t / 0.06)
    return s + 0.15 * noise('hp', 0.25) * np.exp(-t / 0.004)


def s_hop():
    t = tt(0.25)
    f = 300 + 240 * np.minimum(1, t / 0.1)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.08)


def s_whoosh(d=0.6):
    t = tt(d)
    e = np.sin(np.pi * t / d) ** 2
    lo = noise('lp', d)
    hi = noise('bp', d)
    mix = lo * (1 - t / d) + hi * (t / d) * 0.6
    return mix * e * 0.6


def s_scan():
    t = tt(0.55)
    f = 600 * 3 ** (t / 0.55)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * (0.6 + 0.4 * np.sin(2 * np.pi * 28 * t))
    return s * np.sin(np.pi * t / 0.55) * 0.5


def s_stamp(p=0):
    t = tt(0.4)
    f0 = 150 if not p else 240
    f = f0 * (0.5 + 0.5 * np.exp(-t / 0.05))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09)
    s += 0.7 * noise('lp', 0.4) * np.exp(-t / 0.025)
    s += 0.25 * noise('bp', 0.4) * np.exp(-t / 0.008)
    return s * (1 if not p else 0.6)


def s_type():
    t = tt(0.05)
    f = rng.uniform(2500, 4200)
    return (noise('hp', 0.05) * 0.8 + 0.3 * np.sin(2 * np.pi * f * t)) * np.exp(-t / 0.005) * rng.uniform(0.7, 1.1)


def s_blip(p=0):
    t = tt(0.12)
    f = 1175 if p >= 0 else 740
    s = np.sign(np.sin(2 * np.pi * f * t)) * 0.3 + np.sin(2 * np.pi * f * t) * 0.5
    return filt(s, hi=5000) * np.exp(-t / 0.04)


def s_bell2(m1, m2, gap=0.08, decay=0.6):
    out = np.zeros(int(SR * (gap + decay * 3)))
    for i, m in enumerate((m1, m2)):
        t = tt(decay * 3)
        f = mtof(m)
        s = np.sin(2 * np.pi * f * t + 1.2 * np.exp(-t / 0.2) * np.sin(2 * np.pi * f * 2 * t)) * np.exp(-t / decay)
        i0 = int(i * gap * SR)
        out[i0:i0 + len(s)] += s[:len(out) - i0]
    return out


def s_ok(p=0):
    pairs = {-1: (78, 81), 0: (81, 85), 1: (83, 86), 2: (85, 88)}
    return s_bell2(*pairs.get(int(p), (81, 85)))


def s_warn():
    t = tt(0.9)
    out = np.zeros(len(t))
    for i, m in enumerate((76, 73)):
        f = mtof(m)
        s = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(6 * np.pi * f * t)) * np.exp(-t / 0.18)
        i0 = int(i * 0.14 * SR)
        out[i0:] += s[:len(out) - i0]
    return out


def s_chord():
    out = np.zeros(int(SR * 2.5))
    for i, m in enumerate((86, 90, 93, 98)):
        t = tt(2.0)
        f = mtof(m)
        s = np.sin(2 * np.pi * f * t + np.exp(-t / 0.3) * np.sin(2 * np.pi * f * 3 * t)) * np.exp(-t / 0.7)
        i0 = int(i * 0.06 * SR)
        out[i0:i0 + len(s)] += s * 0.7
    return out


def s_tick(soft=0):
    t = tt(0.06)
    s = noise('hp', 0.06) * np.exp(-t / 0.003) + 0.6 * np.sin(2 * np.pi * 2300 * t) * np.exp(-t / 0.012)
    return s * (0.5 if soft else 1)


def s_ring():
    out = np.zeros(int(SR * 2.4))
    for k in range(2):
        t = tt(2.0)
        f = 1760
        s = (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / 0.3)
             + 0.25 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t / 0.1)) * np.exp(-t / 0.7)
        i0 = int(k * 0.17 * SR)
        out[i0:i0 + len(s)] += s
    return out


def s_receive():
    t = tt(0.3)
    thump = np.sin(2 * np.pi * 110 * t) * np.exp(-t / 0.07)
    b = s_bell2(86, 93, gap=0.06, decay=0.5)
    out = np.zeros(max(len(thump), len(b)))
    out[:len(thump)] += thump * 0.6
    out[:len(b)] += b * 0.8
    return out


def s_land():
    t = tt(0.35)
    return np.sin(2 * np.pi * 85 * t) * np.exp(-t / 0.09) + 0.3 * noise('lp', 0.35) * np.exp(-t / 0.02)


def s_roll(d=0.5):
    t = tt(d)
    return noise('lp', d) * (0.6 + 0.4 * np.sin(2 * np.pi * 18 * t)) * np.sin(np.pi * t / d) * 0.7


def s_nudge():
    out = np.zeros(int(SR * 0.4))
    for k in range(2):
        t = tt(0.2)
        s = np.sin(2 * np.pi * 587 * t + 0.8 * np.sin(2 * np.pi * 822 * t)) * np.exp(-t / 0.03)
        i0 = int(k * 0.13 * SR)
        out[i0:i0 + len(s)] += s
    return out


def s_wake():
    out = np.zeros(int(SR * 1.0))
    for k, m in enumerate((86, 90, 93)):
        t = tt(0.7)
        s = np.sin(2 * np.pi * mtof(m) * t) * np.exp(-t / 0.18)
        i0 = int(k * 0.06 * SR)
        out[i0:i0 + len(s)] += s
    return out


def s_hush():
    t = tt(0.9)
    return noise('bp', 0.9) * np.exp(-t / 0.3) * 0.5


def s_riser(d=1.0):
    t = tt(d)
    f = 220 * 8 ** (t / d)
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.25
    return (noise('hp', d) * 0.5 + noise('bp', d) * 0.5 + tone) * (t / d) ** 2.2


def s_impact(big=0):
    d = 3.5 if big else 2.5
    t = tt(d)
    f = 58 * (0.65 + 0.35 * np.exp(-t / 0.2))
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.9 if big else 0.6))
    crash = noise('hp', d) * np.exp(-t / (1.3 if big else 0.9)) * 0.35
    thud = noise('lp', d) * np.exp(-t / 0.05) * 0.6
    return boom + crash + thud


def s_swell(d=1.2):
    t = tt(d + 0.6)
    e = np.where(t < d, (t / d) ** 2, np.exp(-(t - d) / 0.2))
    return noise('hp', d + 0.6) * e * 0.4


def s_split():
    t = tt(0.4)
    return noise('bp', 0.4) * np.sin(np.pi * t / 0.4) ** 2 * 0.5


def s_click():
    out = np.zeros(int(SR * 0.15))
    for k, g in ((0, 1.0), (0.07, 0.6)):
        t = tt(0.03)
        s = (noise('hp', 0.03) + 0.5 * np.sin(2 * np.pi * 3000 * t)) * np.exp(-t / 0.003) * g
        i0 = int(k * SR)
        out[i0:i0 + len(s)] += s
    return out


def s_packet():
    t = tt(0.05)
    return np.sin(2 * np.pi * 1700 * t) * np.exp(-t / 0.012)


def s_draw(d=1.0):
    t = tt(d)
    return noise('bp', d) * np.sin(np.pi * t / d) * (0.5 + 0.5 * np.sin(2 * np.pi * 9 * t)) * 0.4


SFX = {
    'pop': (lambda c: s_pop(c.get('p', 0)), 0.32),
    'card': (lambda c: s_pop(c.get('p', 0)), 0.2),
    'pill': (lambda c: s_pop(c.get('p', 0) + 1), 0.26),
    'node': (lambda c: s_pop(max(0, c.get('p', 0)) % 7), 0.14),
    'hop': (lambda c: s_hop(), 0.3),
    'whoosh': (lambda c: s_whoosh(c.get('d', 0.6)), 0.3),
    'slide': (lambda c: s_whoosh(0.7), 0.18),
    'scan': (lambda c: s_scan(), 0.2),
    'stamp': (lambda c: s_stamp(c.get('p', 0)), 0.55),
    'type': (lambda c: s_type(), 0.16),
    'blip': (lambda c: s_blip(c.get('p', 0)), 0.1),
    'ok': (lambda c: s_ok(c.get('p', 0)), 0.2),
    'warn': (lambda c: s_warn(), 0.2),
    'chord': (lambda c: s_chord(), 0.18),
    'tick': (lambda c: s_tick(c.get('soft', 0)), 0.22),
    'ring': (lambda c: s_ring(), 0.14),
    'receive': (lambda c: s_receive(), 0.24),
    'land': (lambda c: s_land(), 0.4),
    'roll': (lambda c: s_roll(c.get('d', 0.5)), 0.3),
    'nudge': (lambda c: s_nudge(), 0.3),
    'wake': (lambda c: s_wake(), 0.14),
    'hush': (lambda c: s_hush(), 0.14),
    'riser': (lambda c: s_riser(c.get('d', 1.0)), 0.22),
    'impact': (lambda c: s_impact(c.get('big', 0)), 0.55),
    'swell': (lambda c: s_swell(c.get('d', 1.2)), 0.1),
    'split': (lambda c: s_split(), 0.25),
    'click': (lambda c: s_click(), 0.4),
    'packet': (lambda c: s_packet(), 0.07),
    'draw': (lambda c: s_draw(c.get('d', 1.0)), 0.1),
    'dialog': (lambda c: s_pop(1) * 0.8 + 0, 0.34),
}
missing = set()
for c in meta['cues']:
    k = c['k']
    if k not in SFX:
        missing.add(k)
        continue
    fn, g = SFX[k]
    sig = fn(c)
    pan = ((c.get('x', 960) / 1920) * 2 - 1) * 0.55
    add(sfx, c['t'], sig, g, pan)
if missing:
    print('missing sfx:', missing)


# ---------------------------------------------------------------- reverb + master
def reverb(x, rt=1.6, wet=0.25, lp=5000):
    n = int(rt * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt)
        ir = filt(ir, hi=lp)
        ir[: int(0.02 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        size = 1 << int(np.ceil(np.log2(len(x[ch]) + n)))
        y = np.fft.irfft(np.fft.rfft(x[ch], size) * np.fft.rfft(ir, size), size)[: len(x[ch])]
        out[ch] = y
    return x + wet * out


music = reverb(music, rt=1.8, wet=0.35, lp=4500)
drums = reverb(drums, rt=0.9, wet=0.12, lp=6000)
sfx = reverb(sfx, rt=1.1, wet=0.18, lp=6000)
mix = 0.8 * music + 0.75 * drums + 1.0 * sfx
# gentle fade-in, fade-out to silence at the end
fi = np.minimum(1, np.arange(N) / (0.05 * SR))
fo = np.clip((DUR - 0.5 - np.arange(N) / SR) / 1.2, 0, 1)
fo = np.where(np.arange(N) / SR < 84.8, 1, fo)
mix *= fi * fo
peak = np.max(np.abs(mix))
mix = mix / peak * 1.25
mix = np.tanh(mix) / np.tanh(1.25) * 0.89
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open(os.path.join(WORK, f'mix-{LANG}.wav'), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f'wrote mix-{LANG}.wav, {DUR:.1f}s')
