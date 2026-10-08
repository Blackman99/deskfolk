"""Lays the words over the rendered frames: subtitles, name tags over the two in the first scene, and
the end card the film lands on at the music's last hit.

Run: python3 overlay.py LANG FRAMES_DIR OUT_DIR   (needs Pillow; reads anchors.json from FRAMES_DIR)
The fonts are the system's (PingFang SC, SF), read where macOS keeps them and never copied.
"""
import glob, json, math, os, sys
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import beats
from strings import STRINGS

lang, frames, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
S = STRINGS[lang]
W, H, FPS = 1920, 1080, 30
INK, TEAL, MUSTARD, PAGE = (23, 38, 42), (20, 106, 124), (240, 171, 61), (243, 246, 246)
SS = 3  # supersampling for the drawn shapes

PINGFANG = (glob.glob('/System/Library/AssetsV2/*/*/AssetData/PingFang.ttc') +
            glob.glob('/System/Library/Fonts/PingFang.ttc'))[0]


def font(size, weight='medium'):
    if lang == 'zh':
        return ImageFont.truetype(PINGFANG, size, index={'medium': 7, 'semibold': 11, 'regular': 3}[weight])
    f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
    f.set_variation_by_name({'medium': 'Medium', 'semibold': 'Semibold', 'regular': 'Regular'}[weight])
    return f


def pill(text, size, fg, bg, pad=(30, 14), weight='medium', shadow=False):
    f = font(size, weight)
    x0, _, x1, _ = f.getbbox(text, anchor='lm')
    w, h = x1 - x0 + pad[0] * 2, size + pad[1] * 2
    img = Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), radius=h * SS // 2, fill=bg)
    img = img.resize((w, h), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    d.text((pad[0] - x0, h / 2), text, font=f, fill=fg, anchor='lm')
    if shadow:
        sh = Image.new('RGBA', (w + 24, h + 24), (0, 0, 0, 0))
        m = Image.new('L', (w, h), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=60)
        sh.paste((0, 0, 0, 255), (12, 16), m)
        from PIL import ImageFilter
        sh = sh.filter(ImageFilter.GaussianBlur(8))
        sh.alpha_composite(img, (12, 12))
        return sh
    return img


def bubble_points(k, ox, oy):
    """The mark's bubble outline (BrandMark.svelte, 64-unit viewBox), scaled by k and placed at ox, oy."""
    pts = [(22, 6), (42, 6)]
    def arc(c, r, a0, a1, n=24):
        for i in range(1, n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            pts.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
    arc((42, 22), 16, -90, 0); pts.append((58, 36)); arc((42, 36), 16, 0, 90)
    pts += [(24.5, 52), (11, 61.5)]
    p0, c1, c2, p3 = (11, 61.5), (9.8, 62.5), (8.1, 61.6), (8.3, 60.1)
    for i in range(1, 9):
        t = i / 8
        pts.append(tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
                         for a, b, c, d in zip(p0, c1, c2, p3)))
    pts.append((9.6, 50)); arc((22, 40), 16, math.degrees(math.atan2(10, -12.4)), 180, 12)
    pts.append((6, 22)); arc((22, 22), 16, 180, 270)
    return [(ox + x * k, oy + y * k) for x, y in pts]


def mark(size):
    """The Deskfolk mark, drawn like BrandMark: the bubble, Mochi white, Pudding mustard ringed in teal."""
    k = size * SS / 64
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon(bubble_points(k, 0, 0), fill=TEAL)
    circ = lambda cx, cy, r, **kw: d.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), **kw)
    circ(25, 29, 10.5, fill=(255, 255, 255))
    circ(39.5, 29, 12, fill=TEAL)
    circ(39.5, 29, 9, fill=MUSTARD)
    return img.resize((size, size), Image.LANCZOS)


def end_card():
    card = Image.new('RGBA', (W, H), PAGE + (255,))
    m = mark(250)
    card.alpha_composite(m, ((W - 250) // 2, 250))
    f = font(64 if lang == 'zh' else 60, 'semibold')
    d = ImageDraw.Draw(card)
    for text, f, fill, y in ((S['headline'], f, INK, 560), (S['url'], font(32, 'regular'), TEAL, 668)):
        d.text((W / 2, y), text, font=f, fill=fill, anchor='mt')
    return card


subs = {key: pill(S[key], 44 if lang == 'zh' else 40, (255, 255, 255), INK + (205,)) for _, _, key in beats.SUBS}
tags = {who: pill(S[who], 30 if lang == 'zh' else 28, INK, (255, 255, 255, 240), pad=(20, 10), shadow=True)
        for who in ('mochi', 'pudding')}
card = end_card()
anchors = json.load(open(os.path.join(frames, 'anchors.json')))


def ramp(t, a, b, edge=0.22):
    if t < a or t > b:
        return 0.0
    return max(0.0, min(1.0, (t - a) / edge, (b - t) / edge))


def with_alpha(img, alpha):
    if alpha >= 1:
        return img
    r = img.copy()
    r.putalpha(r.getchannel('A').point(lambda v: int(v * alpha)))
    return r


only = [int(x) for x in os.environ.get('OVERLAY_ONLY', '').split(',') if x]
paths = sorted(p for p in glob.glob(os.path.join(frames, 'f*.png')) if not only or int(os.path.basename(p)[1:-4]) in only)
for path in paths:
    n = int(os.path.basename(path)[1:-4])
    t = (n - 1) / FPS
    im = Image.open(path).convert('RGBA')
    for a, b, key in beats.SUBS:
        al = ramp(t, a, b)
        if al:
            s = with_alpha(subs[key], al)
            im.alpha_composite(s, ((W - s.width) // 2, H - 96 - s.height))
    al = ramp(t, *beats.NAMES, edge=0.3)
    if al and str(n) in anchors:
        for who, name in (('mochi', 'Mochi'), ('pudding', 'Pudding')):
            x, y = anchors[str(n)][name]
            s = with_alpha(tags[who], al)
            im.alpha_composite(s, (int(x * W - s.width / 2), int(y * H - s.height - 6)))
    al = 0.0 if t < beats.END_CARD else min(1.0, (t - beats.END_CARD) / beats.END_FADE)
    if al:
        im = Image.blend(im, card, al)
    im.convert('RGB').save(os.path.join(out, os.path.basename(path)), compress_level=1)
print(f'{lang}: {len(paths)} frames laid over')
