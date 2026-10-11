#!/usr/bin/env bash
# Renders the film and every deliverable cut from it: what the README uses into ../../docs/assets, the large
# cuts for posting elsewhere (HQ film, GIF loop) into out/, which git ignores.
# FFMPEG can point at a specific ffmpeg build (it needs libx264 and libwebp_anim).
set -euo pipefail

cd "$(dirname "$0")/.."
FFMPEG="${FFMPEG:-ffmpeg}"
ASSETS="../../docs/assets"
OUT="out"
mkdir -p "$OUT" "$ASSETS"

# Masters: near-lossless renders everything else is encoded from.
npx remotion render Film "$OUT/film-master.mp4"
npx remotion render HeroLoop "$OUT/hero-master.mp4"
npx remotion still Film "$OUT/film-poster.png" --frame=3720 --image-format=png
npx remotion still Social "$OUT/social-preview.png" --image-format=png

# README video: two-pass x264 aimed under GitHub's 10 MB upload limit.
BITRATE="${FILM_BITRATE:-1100k}"
PASSLOG="$OUT/x264-2pass"
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -an -c:v libx264 -preset slow -tune animation -b:v "$BITRATE" \
  -maxrate 4M -bufsize 8M -pix_fmt yuv420p -pass 1 -passlogfile "$PASSLOG" -f mp4 /dev/null
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -an -c:v libx264 -preset slow -tune animation -b:v "$BITRATE" \
  -maxrate 4M -bufsize 8M -pix_fmt yuv420p -pass 2 -passlogfile "$PASSLOG" -movflags +faststart \
  "$ASSETS/myrmidon-film.mp4"
rm -f "$PASSLOG"*

# Social-posting cut: same film at a higher quality.
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -an -c:v libx264 -preset slow -tune animation -crf 17 \
  -pix_fmt yuv420p -movflags +faststart "out/myrmidon-film-hq.mp4"

# README hero loop: animated WebP, with a GIF fallback.
"$FFMPEG" -y -v error -i "$OUT/hero-master.mp4" -vf "fps=24,scale=1200:-1:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -quality 72 -compression_level 6 -loop 0 "$ASSETS/hero.webp"
"$FFMPEG" -y -v error -i "$OUT/hero-master.mp4" -filter_complex \
  "fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "out/hero.gif"

cp "$OUT/film-poster.png" "$ASSETS/film-poster.png"
cp "$OUT/social-preview.png" "$ASSETS/social-preview.png"
ls -lh "$ASSETS"/myrmidon-film*.mp4 "$ASSETS"/hero.* "$ASSETS/film-poster.png" "$ASSETS/social-preview.png"
