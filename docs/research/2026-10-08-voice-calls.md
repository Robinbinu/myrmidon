# Voice calls — research (2026-10-08)

Asked: "Voice calls (OpenDots, as a plugin) — a fast voice model that hands work to the lead" (TODO 12). Answers
2026-10-08: STT **Phonon-2**, TTS **Kitten TTS**, any other STT/TTS provider and the call model selectable; **in the
app first, phone later**; during real work the voice **keeps talking and reports back**.

## Prior art

| | Hermes Agent | OpenClaw voice-call plugin |
|---|---|---|
| Shape | STT → agent → TTS (no speech-to-speech), plus a desktop full-duplex OpenAI realtime mode that delegates tool work to Hermes | Turn-based fallback, or full-duplex realtime (OpenAI Realtime, Gemini Live) |
| Where | CLI push-to-talk / continuous, Discord voice channels, Telegram voice notes, desktop app | Phone only: Twilio, Telnyx, Plivo (webhooks, media streams) |
| Hand-off | Same agent | Realtime model calls `openclaw_agent_consult` for reasoning, fresh information or tools |
| Turn taking | RMS threshold 200 held 0.3 s starts a turn; 3 s silence ends it; 15 s with no speech stops; talking over a reply cuts playback | Provider VAD in realtime mode |
| STT | Local faster-whisper, Groq (~0.5 s), OpenAI, Mistral, xAI, ElevenLabs, DeepInfra | Provider streaming transcription |
| TTS | Edge (free, ~1 s), ElevenLabs (~2 s), OpenAI (~1.5 s), NeuTTS (local) | Provider TTS |

Hermes Live Voice (community) keeps the conversation going while tasks run in the background — the model chosen here.

## Engines chosen

- **Phonon-2** (Fermion Research, released 2026-09-28, weights CC-BY-4.0, CLI Apache-2.0): English-only, 164 MB,
  ~5.2% average WER, ~174× real time on an M5 MacBook Air; parakeet-tdt-0.6b-v3 compressed to ~2.1 bits. Runs through
  the Python CLI `fermion-research` on MLX (Apple Silicon): `fermion transcribe`, `fermion listen`, and
  `fermion serve --model phonon-2`, a local OpenAI-compatible transcription endpoint. 16 kHz input. HF
  `FermionResearch/Phonon-2`, GitHub `fermionresearch/phonon`. Core ML runtime announced, not out.
- **Kitten TTS** (KittenML, Apache-2.0): ONNX, nano 25 MB / micro 40 MB / mini 80 MB (`KittenML/kitten-tts-*-0.8`),
  CPU only, 8 voices (Bella, Luna, Rosie, Kiki, Leo, Jasper, Bruno, Hugo), speed control, 24 kHz mono.
  `kitten-tts-js` (npm) runs in Node via `onnxruntime-node` or in the browser via `onnxruntime-web`; eSpeak-NG WASM
  for phonemes is included. `KittenTTS.from_pretrained(id, { cacheDir })`, `tts.generate(text, { voice, speed })` →
  Float32Array PCM with `.toWav()`.

## What Myrmidon already has

- omp `transcribeAudio` (cloud STT, used for channel voice notes) and `synthesizeSpeech` (`openai-speech`, `xai-tts`).
- This machine: arm64, macOS 27, `uv` installed (Python 3.9 system only — `uv tool install` brings its own Python).
- Signed-in providers have no OpenAI/Gemini/Groq/xAI API key, so cloud speech and realtime voice need a new key.

Sources: hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode, docs.openclaw.ai/plugins/voice-call,
notes.nicolasdeville.com/ai/phonon-2, cdn.jsdelivr.net/npm/kitten-tts-js@0.1.2/README.md.
