#!/bin/zsh
# Build the README's motion promo for one language (see docs/development.md):
#   apps/landing/scripts/motion/build.sh zh|en
# Frames, cues and the mix go to apps/landing/film-out/motion/; the film lands in
# apps/landing/static/media/deskfolk-promo-<lang>.mp4 and its README cover in docs/assets/promo-<lang>.jpg.
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
  -c:a aac -b:a 160k -shortest -movflags +faststart $landing/static/media/deskfolk-promo-$lang.mp4
node $here/render.mjs --lang $lang --out $work --poster $poster_at
ffmpeg -y -loglevel error -i $work/poster-$lang.png -vf scale=1600:900:flags=lanczos -q:v 3 $repo/docs/assets/promo-$lang.jpg
ls -la $landing/static/media/deskfolk-promo-$lang.mp4 $repo/docs/assets/promo-$lang.jpg
