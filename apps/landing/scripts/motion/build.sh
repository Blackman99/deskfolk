#!/bin/zsh
# Build the 86 s motion promo for one language (see docs/development.md); it is no longer published:
#   apps/landing/scripts/motion/build.sh zh|en
# Frames, cues, the mix, the film (deskfolk-promo-<lang>.mp4) and its cover (promo-<lang>.jpg) all go to
# apps/landing/film-out/motion/.
# Needs macOS (the SF fonts), ffmpeg and Python 3 with numpy.
set -e
here=${0:A:h}
landing=${here:h:h}
repo=${landing:h:h}
lang=${1:-zh}
fps=${FPS:-60}
poster_at=${POSTER_AT:-37.3}
work=$landing/film-out/motion
mkdir -p $work

node $here/render.mjs --lang $lang --fps $fps --out $work
python3 $here/audio.py $lang $work
ffmpeg -y -loglevel error -framerate $fps -i $work/frames-$lang/%05d.jpg -i $work/mix-$lang.wav \
  -c:v libx264 -preset slow -crf 21 -tune animation -pix_fmt yuv420p -profile:v high -level 4.2 \
  -c:a aac -b:a 160k -shortest -movflags +faststart $work/deskfolk-promo-$lang.mp4
node $here/render.mjs --lang $lang --out $work --poster $poster_at
ffmpeg -y -loglevel error -i $work/poster-$lang.png -vf scale=1600:900:flags=lanczos -q:v 3 $work/promo-$lang.jpg
ls -la $work/deskfolk-promo-$lang.mp4 $work/promo-$lang.jpg
