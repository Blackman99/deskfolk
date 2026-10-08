"""A contact sheet of a film: 16 frames decoded from the encoded mp4, labelled with their time.

Run: python3 sheet.py FILM.mp4 SHEET.jpg
"""
import subprocess, sys
from PIL import Image, ImageDraw

film, out = sys.argv[1], sys.argv[2]
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film],
                           capture_output=True, text=True, check=True).stdout)
W, H, cols = 480, 270, 4
times = [dur * (i + 0.5) / 16 for i in range(16)]
sheet = Image.new('RGB', (cols * W + (cols - 1) * 8, 4 * H + 3 * 8), 'white')
for i, t in enumerate(times):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', film, '-frames:v', '1', '-vf', f'scale={W}:{H}',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    im = Image.frombytes('RGB', (W, H), raw)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 52, 16), fill='white')
    d.text((4, 3), f'{t:5.2f}s', fill='black')
    sheet.paste(im, ((i % cols) * (W + 8), (i // cols) * (H + 8)))
sheet.save(out, quality=88)
