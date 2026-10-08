# Voice calls: talk with your crew

Press **Call** in a chat's toolbar and talk. A fast **call model** answers you out loud; anything that needs real work
(files, commands, research, writing) it hands to the crew as an ordinary round in the chat, so you see it there as
usual. The call goes on while the crew works, and the call model tells you when the work is done, failed, has a
question, or needs your OK. Talk over it at any time to interrupt. Design:
`superpowers/specs/2026-10-08-voice-calls-design.md`; research: `research/2026-10-08-voice-calls.md`.

## Set up (Settings → Voice)

Voice calls are **off** until you turn on **Voice calls** in Settings → Voice; until then nothing is downloaded or
started, and the Call button is hidden. Turned on, the engines you choose are downloaded if they are not here yet and
kept warm (started, with one short run to compile them), so a call answers at once; turned off, they stop and free
their memory. The first call right after turning voice on (or after a start) shows "Preparing voice…" while that
finishes.

Your turns are found by **Silero VAD** (snakers4/silero-vad, MIT): its 16 kHz model, 1.3 MB, downloaded once into
`<home>/voice` and checked against the hash of release v6.2.3. It tells speech from noise, music and tones, so a
door or a fan does not start a turn; without it (or if it fails) Myrmidon falls back to how loud the sound is.

When you pause, **Smart Turn v3.2** (Pipecat, pipecat-ai/smart-turn-v3, BSD-2-Clause; 8.7 MB, downloaded into
`<home>/voice` and checked against its hash) hears whether you have finished your thought: after 0.2 s of quiet a
finished sentence ends your turn, while "I think we should…" keeps listening; it is asked again at 0.8 s, and a turn it
still hears as unfinished ends after 2 s. Your words are transcribed once the turn has ended (a cloud speech-to-text is
not sent the same audio at every pause). On a direct call it must be surer before a short pause ends your turn, since
each turn is a message to the crew. While an approval is put to you, and without the model (or if it fails to load),
a turn ends after 0.8 s of quiet; with the model, speech starts a turn after 0.2 s, without it after 0.3 s, so a
cough does not talk over the call.

Answers are spoken as they are written, as Pipecat does: the call assistant's (and on a direct call the lead's or the
agent's) reply is read a sentence at a time while the rest is still being written, its first clause even sooner. The
call bar shows how long each answer took to start; the server log breaks it down (turn end and transcript, first
words, first sound). On this Mac our own part of a turn is about 0.6 s; the rest is the call model, so a fast one
matters most.

By default speech stays on your Mac:

- **Speech to text: Phonon-2** (Fermion Research, 164 MB model, English). Press **Install**: Myrmidon runs
  `uv tool install fermion-research==0.2.11` (a pinned release, with the Apple-silicon runtime), then downloads the
  model into `<home>/voice/fermion` and warms it at once (about a minute the first time). It needs
  [uv](https://docs.astral.sh/uv/).
- **Text to speech: Kitten TTS** (KittenML; nano 60 MB, micro 45 MB, mini 82 MB). The model size you chose downloads
  when you turn voice calls on (or press **Download**), with its progress shown, from a pinned revision of its Hugging
  Face repo, each file checked against its pinned hash; it is saved in `<home>/voice/kitten`. Nano is fastest, mini
  sounds best. Pick one of its eight voices and a speed, and press **Try it**.

Settings → Voice shows each download's size before it happens (`GET /api/voice` reports them under `sizes`).

Either can be swapped for:

- **Cloud**: the speech models of the providers you signed in to under Settings → Models (an OpenAI, Groq or xAI
  key, or omp's local Whisper models).
- **OpenAI-compatible endpoint**: any service with the OpenAI audio API (Groq, OpenAI, a local whisper, Kokoro or
  Piper server): its address up to `/v1`, the model, and a key if it needs one. Keys are kept in
  `<home>/voice/secrets.json`, readable only by you, not in `settings.json`.

The **call model** is the lead's model unless you choose another; a fast one makes the call feel quicker, since it
only talks and hands work on. **Speech sensitivity** sets how loud speech must be to count: lower it if background
noise interrupts the call, raise it if quiet speech is missed.

## Who you talk to

**Call** opens a menu:

- **Call assistant**: the fast call model. It answers quick things itself, hands real work to the crew as a round in
  the chat, and can **ask** the lead or one agent a question for you (their answer is read out when it comes).
- **The lead**: no model in between. What you say goes into the chat as your message (marked as spoken, so the lead
  answers in a few plain sentences and puts detail in the chat or files), and the lead's replies are read aloud.
- **A crew member** (each one in the chat): the same, written to them directly (@name). When a new round starts with
  them they get the chat so far; in a running round they are already in it.

On a direct call an approval the crew asks for is read out, one at a time. Only a plain "yes" or "no" (the whole of
what you say: "okay, what does it want?" goes to the lead as a message) decides the one you heard, and the call reads
back what was decided ("Allowed: …").

After a call with the call assistant, your next message in the chat carries the call's transcript to the crew (once),
so you can ask the lead "how did the call go". A direct call needs no such hand-over: its words are already the chat's
messages.

## On a call

- The bar under the toolbar shows whether the call is listening, hearing you, thinking or speaking, your mic level,
  the last lines said, **Mute** and **Hang up**.
- "Do X" for real work: the call model starts the crew on it and says so. Ask "how's it going?" any time.
- When the crew wants approval for something (a command, a file change), the call model says what and asks, one at a
  time. It can decide only when the last thing you said was a plain yes or no, and reads back what was decided. What
  the crew reports reaches the call model as a crew update, never as your words.
- Say goodbye (or press Hang up) to end the call. Its transcript is kept with the chat
  (`<home>/calls/<id>.json`) and shown as a card before the first round it started.
- A call from a new chat makes the chat when it starts its first task.

Calls need the microphone, which browsers allow on this machine or over https. Devices paired for chats only can call;
installing engines and keys needs full access.

## Troubleshooting

- **"Phonon-2 is not installed"**: install it in Settings → Voice, or choose another speech-to-text.
- **"Preparing voice…" for a while**: the engines are downloading or compiling once; later starts take seconds.
- **It hears itself / interrupts itself**: use headphones, or lower the sensitivity; Myrmidon relies on the browser's
  echo cancellation.
- **Long pauses before each answer**: choose a faster call model.

## Developing

`MYR_VOICE_E2E=1 bun test packages/runtime/tests/voice-engines.test.ts` runs Kitten and Phonon-2 for real (downloads
Kitten nano and uses an installed Phonon-2).
