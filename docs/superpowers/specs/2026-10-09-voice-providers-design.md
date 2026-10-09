# Voice providers and realtime calls — design

Asked (2026-10-09): speech to text and text to speech should not be limited to Phonon-2, Kitten, omp's speech models
and one OpenAI-compatible address. Voice providers are set up in **Settings → Models & providers** next to the model
providers, chosen in **Settings → Voice**, and a call can run on a **realtime** speech-to-speech model instead of the
pipeline. Ported from Pipecat (BSD-2-Clause) and LiveKit Agents (Apache-2.0); every protocol was checked against the
provider's current docs, which differ from Pipecat in several places (noted in each adapter).

## Providers (one adapter interface)

`packages/runtime/src/voice/providers.ts` lists them; each entry says what it does (`stt`, `tts`, `realtime`), its
models, its voices, where its key lives, and makes its adapters. Adding a provider is one entry and one adapter.

| Provider | Speech to text | Text to speech | Realtime |
| --- | --- | --- | --- |
| Deepgram | Nova-3, **stream** (WebSocket, `Finalize`), batch upload | Aura-2, **stream** (HTTP raw PCM) | |
| ElevenLabs | Scribe v2 Realtime, **stream** (WebSocket, manual commit), batch | Flash v2.5…, **stream**, voice list API | |
| Cartesia | Ink Whisper, **stream** (WebSocket, `finalize`), batch | Sonic 3.6, **stream**, voice list API | |
| AssemblyAI | Universal-Streaming v3, **stream** (`ForceEndpoint`), Sync API batch | | |
| OpenAI | gpt-4o(-mini)-transcribe, whisper-1, batch | gpt-4o-mini-tts, tts-1, **stream** (raw PCM) | gpt-realtime-2.1… |
| Gemini | | | Gemini 3.8 Live… |
| Groq | Whisper large v3 (turbo), batch | | |
| Google Cloud | v1 `speech:recognize`, batch (REST streaming does not exist) | `text:synthesize`, batch, voice list API | |
| Azure AI Speech | short-audio REST, batch | SSML → raw PCM, **stream**, voice list API | |
| AWS | Transcribe, **stream** (presigned WebSocket, event-stream frames, SigV4 by hand) | Polly, **stream**, voice list API | |
| Speechmatics | real-time `/v2`, **stream** (`EndOfStream`) | | |
| Rime | | Coda / Mist, **stream** (`audio/L16`), public voice list | |
| Fish Audio | | S2.1 Pro, **stream**, voice list API | |

Kept: Phonon-2 and Kitten TTS on this machine, omp's speech models (`omp`), and any number of the person's own
OpenAI-compatible services (`endpoint:<id>`).

Left out, and why: **PlayHT** shut its API down on 2025-12-31 (its hosts no longer resolve); **AWS Nova Sonic** needs
HTTP/2 full-duplex event streams with chained SigV4 signing, which Bun's fetch cannot carry; **Ultravox** is cheap
(REST + one WebSocket) and is the next realtime adapter to add.

## Credentials

One store: omp's credential vault (`<home>/agent/agent.db`), the one the model providers' keys are in. The runtime
exposes it as `VoiceKeys` (`omp.voiceKeys`: get through omp's cascade, which includes its environment variables; set;
remove). Each provider names its vault id: its own (`deepgram`, `azure-speech`, `aws-voice`…), or the model provider's
whose key its API takes (`openai`, `groq`, Gemini → `google`), so a person who added an OpenAI key for models can talk
through OpenAI at once. A shared key is removed only where it was added (Model providers). Not shared, on purpose:
Azure Speech (a Speech resource key, not an Azure OpenAI one) and Google Cloud (a Cloud API key with the Speech APIs
enabled, not a Gemini key). AWS's key is an access key id and secret kept as one JSON string; regions (Azure, AWS,
Speechmatics) are not secret and live in `settings.voice.regions`. Keys are never logged or sent to the page; errors
carry the provider's status and its own message only.

Keys are read when voice warms (before every call) into a small cache, so a call starts without waiting on the vault
and a key added since is the next call's.

## Settings (`settings.voice`)

```
mode: 'pipeline' | 'realtime'
stt: { provider, model? }                      provider: phonon | omp | <registry id> | endpoint:<id>
tts: { provider, model?, voiceId?, kittenModel, voice, speed }   voice is Kitten's, voiceId a cloud one's
realtime?: { provider?, model?, voice? }
regions?: { [providerId]: region }
endpoints?: [{ id, baseUrl, keyless? }]
```

### Migration (nothing is lost)

- Settings from before (`provider: 'endpoint'`, `baseUrl`, `model`, `endpointVoice`) load as endpoints: one named
  `endpoint` when speech to text and text to speech used the same address, else `endpoint-stt` / `endpoint-tts`; the
  choice names it (`endpoint:endpoint`), model and voice carried over. Phonon / Kitten / omp choices are untouched.
- `voice/secrets.json` (`sttKey`, `ttsKey`) moves into the vault under those endpoints (`voice-endpoint-<id>`) the
  first time the gateway runs, and the file is deleted. Without a model runtime it is left alone.

## Streaming vs batch, and turns

Turn taking stays Myrmidon's (Silero VAD + Smart Turn), so barge-in and end of turn work the same with any provider.
A streaming speech to text opens a WebSocket for each turn when the turn starts (the provider is sent, and bills, only
what was said), shows the words as they come (`partial`), and when the turn ends is asked for the rest (`finish()`:
Deepgram `Finalize`, Cartesia `finalize`, ElevenLabs commit, AssemblyAI `ForceEndpoint`, Speechmatics / AWS end of
stream) with VOICE_STT_FINISH_MS to answer; a stream that fails falls back to a batch request with the whole turn. Batch
providers get the turn as before. Streaming text to speech plays each piece as it arrives (`TextToSpeech.stream`), so
the first sound of a sentence comes before the rest of it is made.

**Failures mid-call**: when a cloud engine fails, the call shows the error in the call bar, says a short line, and goes
on with the engine on this machine when it is here (Phonon-2 installed, Kitten's model downloaded); the failed turn or
sentence is retried with it. Without a local engine the error shows and the next turn tries the provider again.

**Phone calls** go through the same choice. Speech that streams in is resampled to the line's 8 kHz with one
resampler per call (not per piece, which would click at the seams).

## Realtime calls

Settings → Voice → Call mode: **Pipeline** (today's) or **Realtime** with a configured realtime model and voice. A
realtime call is the call assistant with the same tools, crew updates, one-at-a-time approvals and transcript;
`RealtimeCallSession` extends `CallSession` and replaces only how it hears and speaks. Calls straight to the lead or a
crew member stay on the pipeline (they have no call model), as do channel voice notes.

- `RealtimeConnection` (connect, audio, toolResult, notice, interrupt, close; events: speech-started, heard, audio,
  said, tool, done, interrupted, error, closed). Adapters: **OpenAI Realtime** (GA schema, semantic VAD, input
  transcription beside it, `function_call_output` + one `response.create` once every call of an answer has its result,
  barge-in truncates the item where it was cut off) and **Gemini Live** (BidiGenerateContent, 16 kHz in / 24 kHz out,
  tools declared BLOCKING, both transcriptions on).
- Crew updates still reach the model only as `crew_updates` results, never as anyone's words: the model gets a fixed
  notice from Myrmidon (OpenAI: a system item; Gemini: a user turn in Myrmidon's own wording, since Gemini closes the
  socket on a function call it did not make) and calls the tool. Its instructions say what such notices are.
- A yes or no counts as before (the person's whole turn, begun after the approval was heard), and since a realtime
  model's transcript can arrive after its `answer_approval` call, the check waits for it (VOICE_REALTIME_TRANSCRIPT_MS).
- Known limits: Gemini sessions last about ten minutes per connection (session resumption is not implemented: the call
  ends with an error); Gemini reports no start of speech, so a turn begins with its first transcribed words.

## API

- `GET /api/voice` adds `mode`, and `providers` / `endpoints` (each provider's capabilities, models, voices, key
  source — stored, shared, env or missing — region, and whether it can be chosen).
- `PUT /api/voice/providers/:id/key` `{ apiKey }` or `{ accessKeyId, secretAccessKey }`, `DELETE` the same;
  `PUT /api/voice/providers/:id/region`; `GET /api/voice/providers/:id/voices?model=` (cached).
- `POST /api/voice/endpoints` `{ id, baseUrl, apiKey? }`, `DELETE /api/voice/endpoints/:id`.
- `PUT /api/voice/keys` (the old per-direction key) is gone. All of these need full access.

## UI

- **Models & providers → Providers** gets a **Voice providers** part (its own glyph): each provider with STT / TTS /
  Realtime tags, whether it streams, its key state (saved, uses your OpenAI key, from the environment, missing), a
  key form (two fields for AWS), a region field where one is needed, a link to get a key; and the person's own
  OpenAI-compatible speech services (add, remove).
- **Settings → Voice**: Call mode (Pipeline / Realtime). Pipeline: speech to text provider and model, text to speech
  provider, model and voice (fetched from the provider where it has a list), only from the engines on this machine,
  omp and configured providers; providers that miss a key are listed as such, and **Add a voice provider** opens
  Models & providers on its Providers tab, scrolled to Voice providers. Realtime: provider, model and voice.
- Strings in `copy.ts` and `prompts.ts`, tunables in `config.ts` / `ui-config.ts`.

## Tests

Each adapter against a stand-in server (HTTP and WebSocket): request shape, auth header, audio format, partial and
final transcripts, audio chunks; SigV4 against AWS's published example and the event-stream framing; the registry and
choice; key and settings migration; a realtime session over a fake socket with a tool call round trip; the voice
picker and the "Add a voice provider" link (happy-dom).
