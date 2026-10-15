"""The app icon: render.py's Mochi and Pudding on the teal tile, at 1024 with macOS margins.

The tile keeps the geometry the old flat icon had (an 824 body centred on a 1024 canvas, a rounded
square of radius 185): macOS 26 shows that shape as it is instead of wrapping it in a grey plate.

With --bleed it draws the phone's home-screen icon instead: the tile fills the square (the phone masks
it) and the pair keeps inside the central 80% a maskable icon may be cut to.

Run: python3 compose.py MASCOTS.png OUT.png [--bleed]   (needs Pillow)
"""
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

src, out = sys.argv[1], sys.argv[2]
BLEED = '--bleed' in sys.argv
SS = 4  # supersampling for the tile's edge
N, BODY, R = (1024, 1024, 0) if BLEED else (1024, 824, 185)
O = (N - BODY) // 2


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def hexc(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


# The tile: a deep radial teal lit from above, the brand teal at its middle.
mask = Image.new('L', (N * SS, N * SS), 0)
ImageDraw.Draw(mask).rounded_rectangle((O * SS, O * SS, (O + BODY) * SS, (O + BODY) * SS), radius=R * SS, fill=255)
mask = mask.resize((N, N), Image.LANCZOS)

top, mid, low = hexc('#2f9db1'), hexc('#146a7c'), hexc('#0b4350')
grad = Image.new('RGB', (N, N))
px = grad.load()
cx, cy = N / 2, O + BODY * 0.12
for y in range(N):
    for x in range(N):
        d = (((x - cx) / (BODY * 0.95)) ** 2 + ((y - cy) / (BODY * 1.05)) ** 2) ** 0.5
        px[x, y] = lerp(top, mid, d / 0.55) if d < 0.55 else lerp(mid, low, min(1, (d - 0.55) / 0.5))
tile = Image.new('RGBA', (N, N), (0, 0, 0, 0))
tile.paste(grad, (0, 0), mask)

# A soft glow behind the pair, so they sit in light rather than on a flat colour.
glow = Image.new('L', (N, N), 0)
ImageDraw.Draw(glow).ellipse((N * 0.2, N * 0.3, N * 0.8, N * 0.86), fill=38)
glow = glow.filter(ImageFilter.GaussianBlur(90))
glow = ImageChops.multiply(glow, mask)
tile = Image.alpha_composite(tile, Image.merge('RGBA', (*(Image.new('L', (N, N), 255),) * 3, glow)))

# The pair, centred, standing on the lower third.
m = Image.open(src).convert('RGBA')
bbox = m.getchannel('A').point(lambda v: 255 if v > 160 else 0).getbbox()  # the bodies, not the faint shadow
pad = round((bbox[3] - bbox[1]) * 0.06)
bbox = (bbox[0] - pad, bbox[1], bbox[2] + pad, min(m.height, bbox[3] + pad * 3))
m = m.crop(bbox)
w = round(BODY * (0.64 if BLEED else 0.86))
h = round(m.height * w / m.width)
m = m.resize((w, h), Image.LANCZOS)
# The catcher shades the whole floor a little; keep the shadow under their feet and let the rest fade,
# so no edge of the render shows on the tile. Bodies are opaque and stay as they are.
fade = Image.new('L', (w * SS, h * SS), 0)
ImageDraw.Draw(fade).ellipse((w * SS * 0.06, -h * SS * 0.3, w * SS * 0.94, h * SS * 0.86), fill=255)
fade = fade.resize((w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(w * 0.05))
a = m.getchannel('A')
solid = a.point(lambda v: 255 if v > 245 else 0)
m.putalpha(ImageChops.lighter(ImageChops.multiply(a, fade), ImageChops.multiply(a, solid)))
layer = Image.new('RGBA', (N, N), (0, 0, 0, 0))
layer.alpha_composite(m, ((N - w) // 2, O + BODY - h - round(BODY * (0.17 if BLEED else -0.02))))
layer.putalpha(ImageChops.multiply(layer.getchannel('A'), mask))
tile = Image.alpha_composite(tile, layer)

# The rim: a hairline of light along the top edge, fading down the sides.
rim = Image.new('L', (N * SS, N * SS), 0)
ImageDraw.Draw(rim).rounded_rectangle((O * SS, O * SS, (O + BODY) * SS, (O + BODY) * SS), radius=R * SS,
                                      outline=255, width=3 * SS)
rim = rim.resize((N, N), Image.LANCZOS)
fade = Image.linear_gradient('L').resize((N, N)).point(lambda v: max(0, 150 - v * 1.6))
rim = ImageChops.multiply(rim, fade)
tile = Image.alpha_composite(tile, Image.merge('RGBA', (*(Image.new('L', (N, N), 255),) * 3, rim)))

if BLEED:
    tile.convert('RGB').save(out)
    print('wrote', out)
    sys.exit()

# A drop shadow inside the margin, as macOS icons carry.
shadow = mask.filter(ImageFilter.GaussianBlur(14)).point(lambda v: v * 0.32)
canvas = Image.new('RGBA', (N, N), (0, 0, 0, 0))
canvas.paste(Image.new('RGBA', (N, N), (4, 30, 36, 255)), (0, 12), shadow)
canvas = Image.alpha_composite(canvas, tile)
canvas.save(out)
print('wrote', out)
