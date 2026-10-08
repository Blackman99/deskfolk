"""The README cover for the mascot film: its poster frame at 1600x900 with a play button under the two
and the running time, in the style of the earlier promo's cover.

Run: python3 cover.py FILM.mp4 OUT.jpg   (needs Pillow and ffmpeg)
"""
import subprocess, sys
from PIL import Image, ImageDraw, ImageFont

film, out = sys.argv[1], sys.argv[2]
W, H, SS = 1600, 900, 3
raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '27.4', '-i', film, '-frames:v', '1', '-vf', f'scale={W}:{H}:flags=lanczos',
                      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
im = Image.frombytes('RGB', (W, H), raw).convert('RGBA')
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film],
                           capture_output=True, text=True, check=True).stdout)

layer = Image.new('RGBA', (W * SS, H * SS), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
cx, cy, r = 800 * SS, 745 * SS, 64 * SS  # under the mascots, over the bubble's foot
d.ellipse((cx - r + 8 * SS, cy - r + 12 * SS, cx + r + 8 * SS, cy + r + 12 * SS), fill=(0, 0, 0, 50))
d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(247, 250, 250, 245))
t = r * 0.42
d.polygon([(cx - t * 0.75, cy - t), (cx - t * 0.75, cy + t), (cx + t * 1.05, cy)], fill=(20, 72, 84, 255))
bx0, by0, bx1, by1 = (W - 150) * SS, (H - 86) * SS, (W - 44) * SS, (H - 34) * SS
d.rounded_rectangle((bx0, by0, bx1, by1), radius=10 * SS, fill=(14, 40, 46, 225))
layer = layer.resize((W, H), Image.LANCZOS)
im.alpha_composite(layer)
f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 30)
f.set_variation_by_name('Semibold')
d = ImageDraw.Draw(im)
d.text(((W - 97), (H - 60)), f'{int(dur // 60)}:{round(dur % 60):02d}', font=f, fill=(255, 255, 255), anchor='mm')
im.convert('RGB').save(out, quality=88)
