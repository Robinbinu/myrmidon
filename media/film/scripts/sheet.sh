#!/usr/bin/env bash
# Contact sheets of the review stills (scripts/review.mjs): `bash scripts/sheet.sh [composition]` tiles
# out/review/<composition>-*.png, labelled with their frame numbers, four across, into out/sheet-1.png, out/sheet-2.png…
set -euo pipefail

cd "$(dirname "$0")/.."
FFMPEG="${FFMPEG:-ffmpeg}"
ID="${1:-Film}"
rm -f out/sheet-*.png
"$FFMPEG" -y -v error -pattern_type glob -i "out/review/$ID-*.png" \
  -vf "scale=480:-1,drawtext=text='%{metadata\:lavf.image2dec.source_basename}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x6" \
  out/sheet-%d.png 2>&1 | grep -v Fontconfig || true
ls out/sheet-*.png
