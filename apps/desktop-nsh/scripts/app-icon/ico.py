"""Packs PNGs into one Windows .ico (Pillow). Run: python3 ico.py OUT.ico SOURCE.png [SIZE ...]

Each size is a downscale of SOURCE (the largest art, 1024 px), embedded as PNG, as Windows has read
icons since Vista. Default sizes are the ones Explorer, the taskbar and the installer ask for.
"""
import sys
from PIL import Image

out, source = sys.argv[1], sys.argv[2]
sizes = [int(v) for v in sys.argv[3:]] or [16, 24, 32, 48, 64, 128, 256]
art = Image.open(source).convert('RGBA')
art.save(out, format='ICO', sizes=[(n, n) for n in sizes])
print('wrote', out)
