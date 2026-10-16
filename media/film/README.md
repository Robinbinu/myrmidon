# Myrmidon launch film

"One chat. A whole crew." A 73-second motion-graphics film, narrated and scored with synthesized sound, made with [Remotion](https://www.remotion.dev)
(React + TypeScript). One continuous take: a single virtual camera moves over one world, and the objects in one shot
carry the eye into the next. The crew works an overnight incident (checkout conversion down 18%): nova slices the data,
iris reproduces the failure on the Mac, quill debugs and fixes a euro rounding bug, the reviewer passes it, Robin allows
the deploy, and the crew calls back. `SHOTLIST.md` is the beat grid, frame by frame.

Every frame is drawn from code. The panels are simplified, film-scale versions of the app's own screens: the same
tokens (`apps/web/src/client/tokens.css`), Geist type, lucide icons (the version `apps/web` pins), task cards, crew
cursors, composer chips and computer-use glow. Names are made up (Robin, acme.dev); model makers and channels show the
app's own marks (`@lobehub/icons-static-svg` as in `ProviderGlyph.tsx`, and `channel-logos.ts` itself).

This folder is its own Bun project, outside the root Bun workspaces, so the film's dependencies never reach the app.

## Setup

```sh
cd media/film
bun install --frozen-lockfile
```

Remotion downloads its headless Chrome into `node_modules` on the first render.

## Preview

```sh
bunx remotion studio
```

| Id         | Size        | What it is                                                          |
| ---------- | ----------- | ------------------------------------------------------------------- |
| `Film`     | 1920×1080   | The whole film, 60 fps, 73 s, with sound                            |
| `HeroLoop` | 1920×1080   | The README loop: the crew's close-ups, the finished crew, the fold, 15 s |
| `Social`   | 1280×640    | The repository's social preview card (a still)                      |

## Render

Everything at once:

```sh
FFMPEG=/path/to/ffmpeg bun run deliver
```

It bundles once, renders near-lossless masters into `out/` (ignored by git), then encodes:

| File                                | How                                                            |
| ----------------------------------- | -------------------------------------------------------------- |
| `docs/assets/myrmidon-film.mp4`     | two-pass x264 at `FILM_BITRATE` (default 860k) + AAC, under 9.5 MB |
| `docs/assets/hero.webp`             | the `HeroLoop`, 1200 px wide, 24 fps animated WebP             |
| `docs/assets/film-*.webp`           | one README still per beat, 1600 px WebP (frames in `deliver.sh`) |
| `docs/assets/film-poster.png`       | frame 4360 of `Film` (the end card), the video's poster        |
| `docs/assets/social-preview.png`    | the `Social` still                                             |
| `out/myrmidon-film-hq.mp4`          | x264 CRF 17, for posting on social (not committed)             |
| `out/hero.gif`                      | the loop as a GIF, 10 fps, for places without WebP             |

## Sound

The voice-over is Azure Speech's standard neural voices (the free F0 tier covers them): a narrator,
`en-US-AndrewMultilingualNeural`, and Myrmidon on the call, `en-US-AvaMultilingualNeural`. The lines and the frames
they start on are in `src/vo.ts`; the audio is committed in `public/vo/`, with each file's length and speech spans in
`src/vo-manifest.json`. To change a line, edit `src/vo.ts` and run

```sh
FFMPEG=/path/to/ffmpeg VOICE_ENV_FILE=/path/to/.env bun scripts/voice.mjs
```

It reads only `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` (from the environment, or from that file), never prints
them, sends only lines whose voice, text or rate changed, keeps a running character count in `out/vo-chars.json`
under a 15,000-character cap, and stops at the first refusal. `--audition` reads one short line in three voices.

The effects are synthesized from ffmpeg expressions, no samples: `FFMPEG=… bash scripts/sfx.sh` writes
`public/sfx/*.wav`, and `src/Soundtrack.tsx` places every cue (keys, clicks, whooshes, chimes, pings, ticks, the stamp,
the ring, risers and the final hit), stepping effects back under the voice. `deliver.sh` masters the mix to -16 LUFS
with a two-pass loudnorm. The hero loop stays silent.

## README stills

The banner and the feature posters are stills in `src/stills/` (registered in `src/stills/index.ts`): `banner`
(2400×800) and `feature-skills`, `feature-channels`, `feature-computer`, `feature-models`, `feature-memory`,
`feature-safety` and `feature-voice` (1600×900). Each id is its file name:

```sh
FFMPEG=/path/to/ffmpeg bun run stills            # all of them, into docs/assets/<id>.webp
bun run stills -- feature-voice --png            # one, as a PNG master in out/stills/ only
```

`WEBP_QUALITY` (default 88) sets the WebP quality. The posters draw with `components/Ui.tsx`, `Icon.tsx` and
`Stage.tsx`; the film itself draws with the components below.

## Review

```sh
bun scripts/review.mjs Film 0.5 --every 60      # a still every second into out/review/
bun scripts/review.mjs Film 1 2235 2590         # full-size stills of chosen frames
FFMPEG=/path/to/ffmpeg bash scripts/sheet.sh     # contact sheets of out/review/ into out/sheet-*.png
bun scripts/check-overlaps.mjs                  # the overlap check: every 6 frames, every 2 where things fly
```

`check-overlaps.mjs` renders the film with its debug probe on (`src/components/Debug.tsx`), which measures every piece
of text and fails on text over text, text outside its container, a caption over UI, or anything laid over the scene
(mail, cursor tags, flying cards, the bubble, the stamp) resting on text; motion blur is off in that render so flying
things are measured too. Run it after any change to
layout, timing or the camera; it must print "No overlaps".

## Where things are

- `src/timeline.ts`: every beat's frame, the world's layout, the camera's path, the light and the captions.
- `src/design.ts`: the design system: type scale, weights, spacing, radii, borders, shadows, surfaces, safe zones.
- `src/theme.ts`: colours (the app's dark tokens) and the crew.
- `src/Film.tsx`: the layers: backdrop, the camera's world, screen-space shots, captions, lens.
- `src/shots/`: one file per stretch of the take (Scatter, Composer, Ask, App, Crew, Board, Call, Reach, End).
- `src/Soundtrack.tsx`, `src/vo.ts`: the voice-over and the effects, frame by frame.
- `src/components/`: the pieces every shot shares: `Surface` (panels, windows, chips, pills, buttons), `Brand` (model
  makers' and channels' marks), `Text` (type and captions, fitted with `@remotion/layout-utils`), `Crew` (crewmates,
  cursors, task and mail cards), `Chart`, `Phone`, `Wordmark` (the dot-matrix MYRMIDON), `Led` (the mascot screen and
  mark), `World` (camera, backdrop, lens), `Debug`.
- `src/anim.ts`: springs, GSAP-style eases, keyframe tracks and timing helpers.
