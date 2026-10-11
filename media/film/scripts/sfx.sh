#!/usr/bin/env bash
# Synthesizes the film's sound effects from maths, no samples: `bash scripts/sfx.sh` writes public/sfx/<name>.wav
# (48 kHz mono). Each is an ffmpeg aevalsrc expression, shaped by envelopes and filters. Soundtrack.tsx places them.
set -euo pipefail

cd "$(dirname "$0")/.."
FFMPEG="${FFMPEG:-ffmpeg}"
OUT="public/sfx"
mkdir -p "$OUT"

# make <name> <seconds> <expression> [filters]
make() {
  local name="$1" dur="$2" expr="$3" filters="${4:-anull}"
  "$FFMPEG" -y -v error -f lavfi -i "aevalsrc=exprs='$expr':s=48000:d=$dur" \
    -af "$filters,afade=t=out:st=$(awk "BEGIN { printf \"%.3f\", $dur - 0.02 }"):d=0.02" -ac 1 -c:a pcm_s16le "$OUT/$name.wav"
}

# Keystrokes: a short noisy tick with a little body, in three pitches so a run of them does not machine-gun.
make key1 0.06 '(random(0)*2-1)*exp(-t*240)*0.6+sin(2*PI*190*t)*exp(-t*90)*0.25' 'highpass=f=700,lowpass=f=7000'
make key2 0.06 '(random(0)*2-1)*exp(-t*260)*0.6+sin(2*PI*230*t)*exp(-t*90)*0.25' 'highpass=f=1100,lowpass=f=8000'
make key3 0.06 '(random(0)*2-1)*exp(-t*220)*0.6+sin(2*PI*170*t)*exp(-t*90)*0.25' 'highpass=f=550,lowpass=f=6000'
# A UI click: a bright, very short tap.
make click 0.05 'sin(2*PI*3100*t)*exp(-t*140)*0.5+(random(0)*2-1)*exp(-t*500)*0.35' 'highpass=f=1200'
# A camera move: a soft breath of noise that swells and fades.
make whoosh 0.8 '(random(0)*2-1)*pow(sin(PI*t/0.8),2)*0.55' 'highpass=f=250,lowpass=f=2200,lowpass=f=2200'
# A message landing: two bell partials with a short room.
make chime 1.6 '0.32*sin(2*PI*1046.5*t)*exp(-t*4.5)+0.22*sin(2*PI*1568*t)*exp(-t*5.5)+0.1*sin(2*PI*2093*t)*exp(-t*8)' 'aecho=0.8:0.5:70|140:0.25|0.15'
# Mail between crewmates: a small, high ping.
make ping 0.7 '0.36*sin(2*PI*1318.5*t)*exp(-t*9)+0.16*sin(2*PI*2637*t)*exp(-t*13)' 'aecho=0.8:0.4:50:0.2'
# A check passing: a quick two-step tick.
make tick 0.18 '0.35*sin(2*PI*2349*t)*exp(-t*70)+0.3*sin(2*PI*3136*(t-0.05))*exp(-(t-0.05)*70)*gte(t,0.05)'
# A payment failing: two low, short buzzes.
make error 0.38 '0.28*(sin(2*PI*196*t)+0.4*sin(2*PI*392*t))*(lt(t,0.12)+gte(t,0.2)*lt(t,0.32))' 'lowpass=f=1500'
# A screenshot: a shutter's two clicks.
make shutter 0.16 '(random(0)*2-1)*(exp(-t*300)+exp(-(t-0.07)*300)*gte(t,0.07))*0.6' 'highpass=f=1500,lowpass=f=9000'
# The review stamp: a low thud with a falling pitch and a dull slap.
make thud 0.9 '0.9*sin(2*PI*(52*t+4*(1-exp(-20*t))))*exp(-t*6)+0.35*(random(0)*2-1)*exp(-t*45)' 'lowpass=f=500'
# Rising tension into a big beat: noise and a sweep growing together.
make riser 2.2 '(0.22*(random(0)*2-1)+0.18*sin(2*PI*(180*t+230*t*t)))*pow(t/2.2,2)' 'highpass=f=180,lowpass=f=6000'
# The phone ringing: a soft marimba pair, four times.
make ring 1.44 '0.3*sin(2*PI*1318.5*t)*exp(-mod(t,0.36)*12)*lt(mod(t,0.36),0.18)+0.3*sin(2*PI*1046.5*t)*exp(-(mod(t,0.36)-0.18)*12)*gte(mod(t,0.36),0.18)' 'aecho=0.8:0.4:40:0.2'
# The call connecting: a short rising blip.
make pickup 0.35 '0.32*sin(2*PI*(620*t+520*t*t))*exp(-t*7)'
# The end card landing: a deep hit with a long, warm tail.
make hit 3 '0.9*sin(2*PI*(44*t+7*(1-exp(-8*t))))*exp(-t*2.2)+0.45*(random(0)*2-1)*exp(-t*28)+0.12*sin(2*PI*220*t)*exp(-t*1.4)' 'lowpass=f=2600,aecho=0.8:0.6:90|180:0.25|0.15'
# Dots settling into the wordmark: a sparkle of high bell tones.
make sparkle 1.2 '0.16*sin(2*PI*2637*t)*exp(-t*6)+0.12*sin(2*PI*3136*(t-0.08))*exp(-(t-0.08)*6)*gte(t,0.08)+0.1*sin(2*PI*3951*(t-0.16))*exp(-(t-0.16)*6)*gte(t,0.16)' 'aecho=0.8:0.5:60|120:0.3|0.2'

ls -1 "$OUT"
