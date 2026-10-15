"""The menu bar's template icon: the mark (BrandMark.svelte's 64-unit drawing) in one ink, for macOS
to tint like its own status items. The bubble is solid, the white teammate is cut out of it, and the
mustard one is a solid disc inside a cut ring, as the mark draws it.

Writes raw RGBA (44 x 44, the menu bar's 22pt at 2x) for lib.rs to include.
Run: python3 tray.py OUT.rgba [PREVIEW.png]   (needs Pillow)
"""
import sys
from PIL import Image, ImageDraw

PX, SS = 44, 16
K = PX * SS / 64  # mark units to supersampled pixels; the mark's 64 grid fills the 22pt square


def u(*v):
    return [round(x * K) for x in v]


ink = Image.new('L', (PX * SS, PX * SS), 0)
d = ImageDraw.Draw(ink)
d.rounded_rectangle(u(6, 6, 58, 52), radius=round(16 * K), fill=255)
d.polygon([tuple(u(24.5, 51)), tuple(u(11, 61.5)), tuple(u(8.4, 60.6)), tuple(u(9.6, 48))], fill=255)
d.ellipse(u(25 - 10.5, 29 - 10.5, 25 + 10.5, 29 + 10.5), fill=0)
d.ellipse(u(39.5 - 13.5, 29 - 13.5, 39.5 + 13.5, 29 + 13.5), fill=0)
d.ellipse(u(39.5 - 10.5, 29 - 10.5, 39.5 + 10.5, 29 + 10.5), fill=255)
alpha = ink.resize((PX, PX), Image.LANCZOS)

icon = Image.merge('RGBA', (Image.new('L', (PX, PX), 0),) * 3 + (alpha,))
open(sys.argv[1], 'wb').write(icon.tobytes())
if len(sys.argv) > 2:
    icon.save(sys.argv[2])
print('wrote', sys.argv[1])
