# Myrmidon launch film, v2: shot list

1920×1080, 60 fps, 4380 frames (73 s), with a voice-over and synthesized sound (see **Sound** below). One world, one camera: beats 1–6 are moves of the same virtual camera
(`src/timeline.ts` → `CAMERA`) over one continuous set; beats 7–9 play in screen space after that world falls away.
Every cut is carried by an object from the last shot into the next. Frame numbers are `BEAT` in `src/timeline.ts`;
change them there and here together.

**Story.** Late evening, Robin's checkout conversion drops 18%. Robin texts the crew from a phone. The lead plans; nova
(analyst · Claude) slices the data, iris (tester · Gemini) reproduces the failure on the Mac, quill (engineer · GPT)
debugs a euro rounding bug, fixes it and proves it with a regression test. The reviewer passes it, Robin allows the
deploy, and the crew calls back. Names are made up: Robin, acme.dev; no company logos, only plain-text model and
channel names.

**Safe zones.** Captions live only in the top band (y 54–150, title-safe 5% sides) in screen space, outside the camera,
fitted to the safe width with `@remotion/layout-utils`. While a caption is up, every framing keeps UI below y 170.
`scripts/check-overlaps.mjs` proves it every 6 frames, and every 2 through everything that flies.

**Grammar.** Moves ease in and out (`power3.inOut` for the camera, `expo.out` for arrivals, the app's own
`[0.45, 0, 0.2, 1]` for cursors). Things that land spring with a little overshoot. Fast flights carry motion blur
(`@remotion/motion-blur`). The panel the camera is not looking at drops out of focus. Nothing holds still: the
camera breathes, glows breathe, carets blink, cursors turn toward where they are going and their name tags trail.

| Beat | Frames | Seconds | Caption (≤ 7 words) |
| ---- | ------ | ------- | ------------------- |
| 1 Scatter | 0–420 | 0.0–7.0 | Ten tools. Ten tabs. Zero teamwork. |
| 2 Question | 395–800 | 6.6–13.3 | *(typed in the composer)* What if one chat did all of it? |
| 3 Ask | 780–1250 | 13.0–20.8 | Ask from your phone. |
| 4 Crew | 1250–2245 | 20.8–37.4 | A lead plans the work. · And hires a crew. · Slice the data. Find the break. · Reproduce it, on your Mac. · Debug it. Fix it. Prove it. |
| 5 Review | 2245–2645 | 37.4–44.1 | They check each other's work. |
| 6 Trust | 2645–3045 | 44.1–50.8 | Sandboxed. Logged. Yours. |
| 7 Call | 3030–3650 | 50.5–60.8 | Then it calls you back. |
| 8 Reach | 3610–4030 | 60.2–67.2 | Reach it from 30 apps. · Any model. Subscriptions you already have. |
| 9 End | 4000–4380 | 66.7–73.0 | One chat. A whole crew. |

## Beat 1 · Scatter (0–420): tension

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 1A | 0–60 | Black, camera at 0.9, rolled −1.6°, tilted 4°, creeping in | One amber caret blinks dead centre. | Cards arrive around it. |
| 1B | 40–300 | Push to 1.0, roll and tilt settle | Ten tool cards (one card chrome) spring in from depth, far ones small and out of focus. Each is busy failing: spinners, badges counting up, statuses turning red. Caption 110–290. | Jitter rises. |
| 1C | 300–420 | Wind-up pull to 0.965, then a hard push to 1.06 | The cards lean away (the wind-up), then are thrown on curved paths into the centre with motion blur, shrinking. | **Match cut by shape:** the composer grows out of the last card's rectangle; the lone caret slides into it. |

## Beat 2 · Question (395–800): the turn

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 2A | 395–560 | Centred, settling to 1.0, slow push | The composer (the app's: model chip with plan battery, Crew, project, Auto) lands with overshoot and an amber ring pulse; "What if one chat did all of it?" types in at 22 cps. | Send pulses. |
| 2B | 560–700 | Push continues | Send: the sentence lifts and breaks into amber dots that fly into the dot-matrix **MYRMIDON** wordmark (lit amber dots on a faint unlit grid). | Wordmark breathes. |
| 2C | 700–800 | Pull back starts at 760 | The app window draws itself around the composer; the wordmark shrinks into the sidebar's header. | **Shared element:** composer docks, wordmark becomes the app's mark. |

## Beat 3 · Ask (780–1250)

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 3A | 780–960 | Wide 0.66 on app + phone | The new-chat screen greets "Evening, Robin." under the mascot. Robin's phone rises beside the app; the mascot's eyes turn to it. The phone shows Myrmidon's alert: conversion −18% since 21:40, its chart dropping. Caption 850–955. | Push in. |
| 3B | 960–1110 | Phone close-up, 1.0 → 1.04 | Robin types "Checkout conversions dropped 18% overnight. Find out why, fix it, and call me." (40 cps), sends; the bubble pops into the thread. | Bubble lifts. |
| 3C | 1110–1250 | Camera follows the bubble back to the app | **Shared element:** the bubble flies off the phone on an arc (motion blur), amber turning to the app's bubble grey, and lands as Robin's message; the mascot's eyes follow it. | The lead answers. |

## Beat 4 · Crew (1250–2245): the centrepiece

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 4A | 1250–1400 | Chat, 0.95 → 0.98 | The lead's mark thinks, replies, and a PLAN · LEAD card streams in with three task cards. Caption 1268–1390. | Cards dip (wind-up). |
| 4B | 1400–1540 | Pull to the triptych | **Shared element:** the three task cards fly out of the plan and become the headers of three agent panels, which unfold down from them. The app falls back out of focus. Caption 1436–1536. | Focus pulls left. |
| 4C | 1540–1760 | nova close-up 1.15 | nova's notebook: a SQL cell types and runs (1.2M rows), the segment table counts in, mobile · EUR collapses 3.4% → 0.6%, a Python cell plots the cliff at the 21:40 deploy, the insight lights. Caption 1590–1688. | **Mail lane:** the caption clears and "nova → iris: It's EUR on mobile, since 21:40." passes along the band above the panels (1714–1800) toward iris; iris's card shows the mail badge. |
| 4D | 1760–1960 | Pan to iris 1.15 | iris drives the Mac (the app's amber computer-use glow): a phone-sized checkout in Safari, taps "Pay €49.99", "Payment failed: amount mismatch", screenshot flash, the evidence thumbnail flies into the step list. Caption 1800–1898. | **Mail lane:** iris → quill (1920–1972), then nova → quill (1972–2024). |
| 4E | 1960–2160 | Pan to quill 1.15 | quill's worktree `quill/fix-eur-rounding`: paused on a breakpoint in `checkout/currency.ts`, `amount = 4998.999999999999`, `toCents → 4998`; the diff swaps `Math.floor` for `Math.round`; `bun test` → 412 passed. Caption 2026–2145. | Pull back. |
| 4F | 2160–2245 | Wide 0.97, held | All three panels finished side by side: the chart and insight, the failed payment and its screenshot, the fix and the green suite. | Fold. |

## Beat 5 · Review (2245–2645)

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 5A | 2245–2425 | Tilt down to the board (power3.inOut) | **Shared element:** each panel folds into its task card, and the cards swing out and slide into the board's IN REVIEW lane, each along its own row. The Mail column fills with the crew's messages. Caption 2400–2505. | Reviewer arrives. |
| 5B | 2425–2645 | Board, 1.0 → 1.03, shake on impact | The reviewer's lime cursor ticks each card; they slide to DONE; the reviewer's verdict slams into the empty lane at 2555 ("Reviewed · score 0.97", root cause confirmed, regression test added, 412 passed) with a ring and camera shake. | Verdict lifts. |

## Beat 6 · Trust (2645–3045): held breath

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 6A | 2645–2745 | Slow push 1.03 → 1.09; the board dims and drops out of focus; the audit log scrolls behind | **Shared element:** the verdict slides to the centre, straightens and grows into the approval card ("Deploy hotfix to production?", quill wants to deploy `quill/fix-eur-rounding`, 3 files changed · 412 tests passed · reviewed 0.97). "Sandboxed." "Logged." "Yours." land 90 frames apart, as the narrator says them. | — |
| 6B | 2745–3015 | Push continues | Robin's cursor curves in, hovers Allow once, presses: "Allowed by Robin · logged as event #2047", and the matching log line lights. | — |
| 6C | 3015–3080 | Camera recedes to 0.74, the world fades and blurs | **Transition:** the screen falls away into depth as the phone rises from below, ringing. | Phone. |

## Beat 7 · Call (3030–3650): the emotional beat

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 7A | 3030–3133 | The same phone, tilt settling flat | Myrmidon calling: the mascot's screen with pulse rings; Accept pressed at 3133. Caption 3077–3255. | Connects. |
| 7B | 3133–3610 | Slow push 0.86 → 0.92 | In call: timer, a waveform that moves with the voice, and three lines written as Myrmidon says them (timed from the voice file): "Found it: a rounding bug in euro checkout." "Fixed, tested and deployed." "Conversions are back." The same conversion chart climbs back to 3.4%; the eyes turn happy. Beside the phone: the conversion card (right, from the first sentence) and the deploy recap (left, from "Fixed"), both gone before the waveform leaves. | Waveform lifts. |
| 7C | 3610–3690 | — | **Shared element:** the phone drops away; the waveform's bars stay, stretch, and become the orbit's chips. | Orbit. |

## Beat 8 · Reach (3610–4030)

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 8A | 3650–3870 | Wide orbit, back chips small and out of focus | Twelve chips, each with its app's mark, orbit the mark. Caption 3702–3858. | Chips flip. |
| 8B | 3870–4000 | Same | The chips flip one after another to model makers' marks and names, the last to "Your subscriptions". Caption 3886–4010. | Spiral in. |
| 8C | 4000–4115 | — | **Shared element:** the chips spiral to the centre, their labels fading, and burst into amber dots that fly to the wordmark's lit dots. | End card. |

## Beat 9 · End (4000–4380): confident hold

| Shot | Frames | Framing · camera | Hero · motion | Out |
| ---- | ------ | ---------------- | ------------- | --- |
| 9A | 4000–4380 | Locked off, imperceptible push 1.0 → 1.015 | MYRMIDON lights dot by dot on its grid and the pixel-eyes mark lands beside it (it wakes, blinks and winks), then "One chat. A whole crew.", "Free and open source · Runs on your Mac", the repo pill and ★ Star (it pops at 4260); a light sweeps the wordmark at 4310. Composed from ~4190: a 3.2 s hold. | — |

## Deliverable frames

| Still | Frame | Why |
| ----- | ----- | --- |
| `film-ask.webp` | 1088 | Robin's ask typed under the dropping chart |
| `film-crew.webp` | 2235 | All three panels finished, side by side |
| `film-review.webp` | 2590 | The verdict on the board, the crew's mail beside it |
| `film-trust.webp` | 2960 | Allowed by Robin, logged |
| `film-call.webp` | 3598 | The call, transcript complete, chart recovered |
| `film-reach.webp` | 3800 | The orbit of channels |
| `film-poster.png` | 4360 | The end card |
| `hero.webp` | 1520–2420 | The three close-ups, the finished crew, the fold onto the board (15 s, silent) |

## Sound

**Voice.** A narrator (Azure `en-US-AndrewMultilingualNeural`) speaks twelve short lines, one per beat, and
Myrmidon speaks on the call (`en-US-AvaMultilingualNeural`): the lines and their frames are `src/vo.ts`, the audio is
`public/vo/`, and `src/vo-manifest.json` records each file's length and where in it speech falls, which the call's
transcript and waveform follow.

| Frame | Voice | Line |
| ----- | ----- | ---- |
| 50 | narrator | Ten AI tools. Ten tabs. None of them talk to each other. |
| 452 | narrator | What if one chat did all of it? |
| 812 | narrator | It is late. Checkout is breaking. Text it from anywhere. |
| 1262 | narrator | A lead plans the work, and brings in a crew. |
| 1566 | narrator | One digs through the data. |
| 1790 | narrator | One reproduces the failure, on your Mac. |
| 1992 | narrator | One finds the bug, fixes it, and proves it. |
| 2398 | narrator | Then they check each other's work. |
| 2696 | narrator | Sandboxed. Logged. Yours. |
| 3163 | Myrmidon | Found it: a rounding bug in euro checkout. Fixed, tested and deployed. Conversions are back. |
| 3705 | narrator | Reach it from thirty apps, on any model, with the plans you already pay for. |
| 4105 | narrator | Myrmidon. One chat. A whole crew. |

**Effects.** Synthesized by `scripts/sfx.sh` (ffmpeg expressions, no samples) and placed in `src/Soundtrack.tsx`:
keystrokes under every typed line, clicks on every press, whooshes on the camera's big moves and flights, a chime when
the message lands and when the work is allowed, pings for the crew's mail, ticks for passing checks, a buzz for the
failed payment, a shutter for the screenshot, risers into the throw, the stamp and the end card, the stamp's thud, the
phone's ring and pickup, a sparkle as the dots settle, and a deep hit as the mark lands. Effects step back under the
voice; the master is normalized to -16 LUFS by `deliver.sh`. No music bed: none could be checked by ear here.
