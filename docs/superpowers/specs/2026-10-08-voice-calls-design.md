# Voice calls — design

Research: docs/research/2026-10-08-voice-calls.md. Choices (2026-10-08): STT **Phonon-2**, TTS **Kitten TTS**, any other
STT/TTS provider and the call model selectable; **in the app first, phone later**; the voice **keeps talking while the
crew works and reports back**.

## Shape

A call is a conversation with a **call agent**: a fast model with a short spoken style and a few tools. It answers
small things itself and hands real work to the crew as an ordinary round in the same chat, so everything the crew
does shows in the chat as usual. Pipeline, as Hermes: speech → text → call agent → text → speech. The audio pipeline
runs on the server, so a phone line later (Twilio Media Streams) is one more audio source into the same pipeline, and
it works the same for swarm, lead/worker and a future org mode: the call agent only starts rounds and reads their
events.

```
mic (browser, 16 kHz PCM) ──ws──▶ turn detector ─▶ STT ─▶ call agent ─▶ TTS ─▶ ws ──▶ speaker
                                                     │ start_task / approve / status
                                                     ▼
                                                   chat rounds (crew)  ── events ──▶ call agent ("done", "needs OK")
```

## Server (packages/runtime/src/voice/)

- **Providers**, each an interface with one method, chosen in Settings:
  - STT `transcribe(pcm16k) → text`: **Phonon-2** (default; `fermion serve --model phonon-2` run and kept alive by
    Myrmidon on a free local port, spoken to over its OpenAI-compatible endpoint); **omp cloud** (the speech model
    omp can call, as channel voice notes do); **OpenAI-compatible endpoint** (base URL, key, model — Groq, OpenAI,
    a local whisper server…).
  - TTS `speak(text) → pcm` streamed sentence by sentence: **Kitten TTS** (default; `kitten-tts-js` in the server,
    model and voice chosen: nano/micro/mini, 8 voices, speed); **omp cloud** (`openai-speech`, `xai-tts`);
    **OpenAI-compatible endpoint** (`/v1/audio/speech`).
  - Missing pieces are set up from Settings with one button each ("Install Phonon-2" runs
    `uv tool install fermion-research` and fetches the model; Kitten's model downloads on first use), with progress
    and a clear error, never silently.
- **Turn taking** (Hermes's numbers as defaults, in config.ts): speech starts when the level stays above a threshold
  for 0.3 s; a turn ends after 0.8 s of silence (shorter than Hermes's 3 s because the reply is short); talking while
  the call agent speaks stops playback at once and starts a new turn (barge-in).
- **Call agent**: the call model (any model in the picker; a fast one suggested), prompt in prompts.ts (spoken, short,
  no markdown, says what it handed off). Tools:
  - `start_task(request)` — sends the request to the chat as a new round (current team settings) and returns at once;
  - `task_status()` — what is running in this chat and how far along;
  - `answer_approval(id, approve, note?)` — decides an approval the crew is waiting on, after the person said so;
  - `end_call()`.
  The call follows the chat's rounds: when one finishes, fails or asks for approval, a short note is added to the
  call agent's context and it speaks it at the next pause ("The crew finished the report: …", "They want to run
  `rm -rf build`, OK?").
- **Transcript**: saved per call (`<home>/calls/<chatId>/<callId>.jsonl`: who said what, when, which rounds it
  started) and shown in the chat as a "Call · 4 min" card that opens the transcript.
- **Endpoint**: `GET /api/voice/call?chat=<id>` upgrades to a WebSocket (same device auth and scopes as the rest;
  chat-scope devices may call). Binary frames are audio, text frames are JSON control (`state`, `transcript`,
  `interrupt`, `hangup`).

## Client

- A call button in the chat toolbar (and ⌘⇧C); a slim call bar while on a call: mute, hang up, a level meter, the live
  transcript, and what the crew is doing. Mic through an AudioWorklet resampled to 16 kHz; playback through Web Audio
  so barge-in can stop it at once.
- **Settings → Voice** (new section): call model; STT provider (+ endpoint fields, install button, status); TTS
  provider, voice and speed, a "Try it" button; turn-taking sensitivity.
- Strings in copy.ts, prompts in prompts.ts, tunables in config.ts/ui-config.ts, colours from tokens; one new icon not
  used elsewhere.

## Dependencies (new — please confirm)

- npm `kitten-tts-js` (Apache-2.0) with `onnxruntime-node` (native, ~tens of MB). Risk: onnxruntime-node under Bun; a
  spike checks it first, falling back to running Kitten in the browser with `onnxruntime-web`.
- Python CLI `fermion-research` (Apache-2.0), installed on demand with `uv tool install`, outside the repo. Model
  downloads from Hugging Face: Phonon-2 164 MB, Kitten nano 25 MB (larger Kitten models optional).

## Not in this step

Phone calls (Twilio) — next step, reusing the pipeline; realtime speech-to-speech models (OpenAI Realtime, Gemini
Live) as another call mode; voice in channels (Discord voice).

## Testing

Unit: turn detector on synthetic audio (speech, pauses, barge-in); providers against fake servers; the call agent's
tools against a fake chat (start a round, hear "done", approve). Integration: a scripted call over the WebSocket with
recorded speech through the real Phonon-2 and Kitten when installed (skipped when not).
