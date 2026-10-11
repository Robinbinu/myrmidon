#!/usr/bin/env bash
# Renders the film and every deliverable cut from it: what the README uses into ../../docs/assets, the large
# cuts for posting elsewhere (HQ film, GIF loop) into out/, which git ignores.
# FFMPEG can point at a specific ffmpeg build (it needs libx264 and libwebp_anim).
set -euo pipefail

cd "$(dirname "$0")/.."
FFMPEG="${FFMPEG:-ffmpeg}"
ASSETS="../../docs/assets"
OUT="out"
BUNDLE="$OUT/bundle"
mkdir -p "$OUT/stills" "$ASSETS"

# One bundle for every render below, so the project is built once.
npx remotion bundle --out-dir="$BUNDLE"

# Masters: near-lossless renders everything else is encoded from.
npx remotion render "$BUNDLE" Film "$OUT/film-master.mp4" --crf=12
npx remotion render "$BUNDLE" HeroLoop "$OUT/hero-master.mp4" --crf=12 --muted
npx remotion still "$BUNDLE" Film "$OUT/film-poster.png" --frame=4360 --image-format=png
npx remotion still "$BUNDLE" Social "$OUT/social-preview.png" --image-format=png

# README stills, one per beat: name and the film frame that tells it best (see SHOTLIST.md).
STILLS=(film-ask:1088 film-crew:2235 film-review:2590 film-trust:2960 film-call:3598 film-reach:3800)
for pair in "${STILLS[@]}"; do
  name="${pair%%:*}"
  frame="${pair##*:}"
  npx remotion still "$BUNDLE" Film "$OUT/stills/$name.png" --frame="$frame" --image-format=png
  "$FFMPEG" -y -v error -i "$OUT/stills/$name.png" -vf "scale=1600:-1:flags=lanczos" -c:v libwebp -quality 88 \
    -compression_level 6 "$ASSETS/$name.webp"
done

# The soundtrack, mastered to -16 LUFS integrated (-1.5 dBTP) with a two-pass loudnorm: measure, then apply linearly.
MEASURED="$("$FFMPEG" -hide_banner -i "$OUT/film-master.mp4" -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json \
  -f null - 2>&1 | sed -n '/^{/,/^}/p')"
field() { echo "$MEASURED" | sed -n "s/.*\"$1\" : \"\\([^\"]*\\)\".*/\\1/p"; }
LOUDNORM="loudnorm=I=-16:TP=-1.5:LRA=11:linear=true:measured_I=$(field input_i):measured_TP=$(field input_tp)"
LOUDNORM="$LOUDNORM:measured_LRA=$(field input_lra):measured_thresh=$(field input_thresh):offset=$(field target_offset)"
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -vn -af "$LOUDNORM" -ar 48000 -ac 2 "$OUT/soundtrack.wav"

# README video: two-pass x264 plus AAC, aimed under 9.5 MB for GitHub's 10 MB upload limit.
BITRATE="${FILM_BITRATE:-860k}"
PASSLOG="$OUT/x264-2pass"
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -an -c:v libx264 -preset slow -tune animation -b:v "$BITRATE" \
  -maxrate 4M -bufsize 8M -pix_fmt yuv420p -pass 1 -passlogfile "$PASSLOG" -f mp4 /dev/null
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -i "$OUT/soundtrack.wav" -map 0:v -map 1:a -c:v libx264 -preset slow \
  -tune animation -b:v "$BITRATE" -maxrate 4M -bufsize 8M -pix_fmt yuv420p -pass 2 -passlogfile "$PASSLOG" \
  -c:a aac -b:a 96k -movflags +faststart "$ASSETS/myrmidon-film.mp4"
rm -f "$PASSLOG"*

# Social-posting cut: same film at a higher quality.
"$FFMPEG" -y -v error -i "$OUT/film-master.mp4" -i "$OUT/soundtrack.wav" -map 0:v -map 1:a -c:v libx264 -preset slow \
  -tune animation -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "$OUT/myrmidon-film-hq.mp4"

# The two README posters that show providers' and channels' marks (see src/stills; `npm run stills` does all eight).
node scripts/stills.mjs feature-models feature-channels

# README hero loop: animated WebP, with a GIF fallback.
"$FFMPEG" -y -v error -i "$OUT/hero-master.mp4" -vf "fps=24,scale=1200:-1:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -quality "${HERO_QUALITY:-62}" -compression_level 6 -loop 0 "$ASSETS/hero.webp"
"$FFMPEG" -y -v error -i "$OUT/hero-master.mp4" -filter_complex \
  "fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$OUT/hero.gif"

cp "$OUT/film-poster.png" "$ASSETS/film-poster.png"
cp "$OUT/social-preview.png" "$ASSETS/social-preview.png"
ls -lh "$ASSETS"/myrmidon-film.mp4 "$ASSETS"/hero.webp "$ASSETS"/film-*.webp "$ASSETS/film-poster.png" \
  "$ASSETS/social-preview.png"
