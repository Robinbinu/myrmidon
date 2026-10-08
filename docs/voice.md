# Voice calls: talk with your crew

Press **Call** in a chat's toolbar and talk. A fast **call model** answers you out loud; anything that needs real work
(files, commands, research, writing) it hands to the crew as an ordinary round in the chat, so you see it there as
usual. The call goes on while the crew works, and the call model tells you when the work is done, failed, has a
question, or needs your OK. Talk over it at any time to interrupt. Design:
`superpowers/specs/2026-10-08-voice-calls-design.md`; research: `research/2026-10-08-voice-calls.md`.

## Set up (Settings → Voice)

By default speech stays on your Mac:

- **Speech to text: Phonon-2** (Fermion Research, 164 MB, English). Press **Install**: Myrmidon runs
  `uv tool install fermion-research` (with the Apple-silicon runtime). It needs [uv](https://docs.astral.sh/uv/). The
  model downloads the first time a call starts, into `<home>/voice/fermion`; that first start takes a minute.
- **Text to speech: Kitten TTS** (KittenML). Press **Download** for the model size you chose (nano is fastest, mini
  sounds best); it is saved in `<home>/voice/kitten`. Pick one of its eight voices and a speed, and press **Try it**.

Either can be swapped for:

- **Cloud**: the speech models of the providers you signed in to under Settings → Models (an OpenAI, Groq or xAI
  key, or omp's local Whisper models).
- **OpenAI-compatible endpoint**: any service with the OpenAI audio API (Groq, OpenAI, a local whisper, Kokoro or
  Piper server): its address up to `/v1`, the model, and a key if it needs one. Keys are kept in
  `<home>/voice/secrets.json`, readable only by you, not in `settings.json`.

The **call model** is the lead's model unless you choose another; a fast one makes the call feel quicker, since it
only talks and hands work on. **Speech sensitivity** sets how loud speech must be to count: lower it if background
noise interrupts the call, raise it if quiet speech is missed.

## On a call

- The bar under the toolbar shows whether the call is listening, hearing you, thinking or speaking, your mic level,
  the last lines said, **Mute** and **Hang up**.
- "Do X" for real work: the call model starts the crew on it and says so. Ask "how's it going?" any time.
- When the crew wants approval for something (a command, a file change), the call model says what and asks; it
  decides only after you clearly say yes or no.
- Say goodbye (or press Hang up) to end the call. Its transcript is kept with the chat
  (`<home>/calls/<id>.json`) and shown as a card before the first round it started.
- A call from a new chat makes the chat when it starts its first task.

Calls need the microphone, which browsers allow on this machine or over https. Devices paired for chats only can call;
installing engines and keys needs full access.

## Troubleshooting

- **"Phonon-2 is not installed"**: install it in Settings → Voice, or choose another speech-to-text.
- **The first call is slow to answer**: Phonon-2 is downloading its model and compiling its runtime once.
- **It hears itself / interrupts itself**: use headphones, or lower the sensitivity; Myrmidon relies on the browser's
  echo cancellation.
- **Long pauses before each answer**: choose a faster call model.

## Developing

`MYR_VOICE_E2E=1 bun test packages/runtime/tests/voice-engines.test.ts` runs Kitten and Phonon-2 for real (downloads
Kitten nano and uses an installed Phonon-2).
