"""A README cover: a film's poster frame at 1600x900 with a play button and the running time, in the style
of the earlier promo's cover. Made for the mascot film (its frame at 27.4 s, the button under the two);
the reel passes its own frame and a spot clear of faces and text.

Run: python3 cover.py FILM.mp4 OUT.jpg [--at SECONDS] [--button X,Y]   (needs Pillow and ffmpeg; X,Y in the 1600x900 cover)
"""
import subprocess, sys
from PIL import Image, ImageDraw, ImageFont

film, out = sys.argv[1], sys.argv[2]
opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
AT = opt('--at', '27.4')
BX, BY = (int(v) for v in opt('--button', '800,745').split(','))
W, H, SS = 1600, 900, 3
raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', AT, '-i', film, '-frames:v', '1', '-vf', f'scale={W}:{H}:flags=lanczos',
                      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
im = Image.frombytes('RGB', (W, H), raw).convert('RGBA')
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film],
                           capture_output=True, text=True, check=True).stdout)

layer = Image.new('RGBA', (W * SS, H * SS), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
cx, cy, r = BX * SS, BY * SS, 64 * SS  # the mascot film: under the mascots, over the bubble's foot
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
