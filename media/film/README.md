# Myrmidon launch film

"One chat. A whole crew." A silent, 65-second motion-graphics film made with [Remotion](https://www.remotion.dev)
(React + TypeScript). Every frame is drawn from code: the pixel-eyes mascot, the crew's cursors, the panels and the
type are components here, styled after the app's own tokens (`apps/web/src/client/tokens.css`), mascot
(`apps/web/src/client/ui/pixel.tsx`) and mark (`apps/web/src/client/icon.svg`).

This folder is its own npm project, outside the root Bun workspaces, so the film's dependencies never reach the app.

## Setup

```sh
cd media/film
npm ci
```

Remotion downloads its headless Chrome into `node_modules` on the first render.

## Preview

```sh
npx remotion studio
```

Three compositions:

| Id         | Size        | What it is                                                         |
| ---------- | ----------- | ------------------------------------------------------------------ |
| `Film`     | 1920×1080   | The whole film, 60 fps, 65.5 s                                     |
| `HeroLoop` | 1920×1080   | The README loop: crew triptych → review stamp → end card, ~13.5 s  |
| `Social`   | 1280×640    | The repository's social preview card (a still)                     |

## Render

Everything at once, into `docs/assets/`:

```sh
FFMPEG=/path/to/ffmpeg npm run deliver
```

It renders near-lossless masters into `out/` (ignored by git), then encodes:

| File                                | How                                                            |
| ----------------------------------- | -------------------------------------------------------------- |
| `docs/assets/myrmidon-film.mp4`     | two-pass x264 at `FILM_BITRATE` (default 1100k), under 10 MB   |
| `out/myrmidon-film-hq.mp4`          | x264 CRF 17, for posting on social (not committed)             |
| `docs/assets/hero.webp`             | the `HeroLoop`, 1200 px wide, 24 fps animated WebP             |
| `out/hero.gif`                      | the same loop as a GIF, 10 fps, for places without WebP        |
| `docs/assets/film-poster.png`       | frame 3720 of `Film` (the end card), the video's poster        |
| `docs/assets/social-preview.png`    | the `Social` still                                             |

One output on its own:

```sh
npx remotion render Film out/film-master.mp4
npx remotion render HeroLoop out/hero-master.mp4
npx remotion still Film out/poster.png --frame=3720
npx remotion still Social out/social-preview.png
```

## README stills

The banner and the feature posters are stills in `src/stills/` (registered in `src/stills/index.ts`): `banner`
(2400×800) and `feature-skills`, `feature-channels`, `feature-computer`, `feature-models`, `feature-memory`,
`feature-safety` and `feature-voice` (1600×900). Each id is its file name:

```sh
FFMPEG=/path/to/ffmpeg npm run stills            # all of them, into docs/assets/<id>.webp
npm run stills -- feature-voice --png            # one, as a PNG master in out/stills/ only
```

`WEBP_QUALITY` (default 88) sets the WebP quality.

To check a cut without rendering video, `node scripts/review.mjs Film 0.5 --every 120` writes a still every two seconds
to `out/review/` (or pass frame numbers instead of `--every N`).

## Where things are

- `src/Film.tsx`: the cut, each scene's first frame and length.
- `src/scenes/`: one file per beat (Opening, Ask, Crew, Coord, Trust, Call, Reach, End).
- `src/components/`: the mascot screen and mark (`Led.tsx`), kinetic captions, the phone, the Mac window, cursors.
- `src/theme.ts`: colours, fonts, and the crew (`nova`, `quill`, `iris`).
- `src/anim.ts`: springs, easing and timing helpers.

Names in the film are made up: the person is Alex, the site is `acme.dev`, competitors are Northwind, Contoso and
Fabrikam. Channel and model names appear as plain text chips, never logos.
