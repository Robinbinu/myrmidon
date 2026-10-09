/**
 * The runtime's tunable limits, timeouts and retry counts, in one place so they can be read and changed together.
 * Some texts state a value too (an error saying "over 64 KB", say); change those with it.
 */

// Agents (agent.ts)

/** The longest one agent turn may run; a safety net only: one turn can include many model calls and large file writes. */
export const TURN_TIMEOUT_MS = 15 * 60_000
/** Retries for a transient model failure (rate limit, overload, timeout) before the person is asked. */
export const MODEL_RETRIES = 2
/** HTTP statuses that make a model failure transient (worth a retry): timeouts, conflicts, rate limits, overloads. */
export const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
/** Turns kept word for word when a new round of the chat starts; older tool output is elided. */
export const KEEP_TURNS = 4

// Context compaction (compaction.ts)

/** The recent part kept word for word: this share of the usable window, at least `KEEP_MIN` tokens. */
export const KEEP_SHARE = 0.25
export const KEEP_MIN = 2_000

// Rounds (colony.ts)

/** Stall nudges a colony gets when every agent sits idle with the work unfinished, before it stops. */
export const QUIET_NUDGES = 2
/** How long an agent waits for the person to sign in before it goes on without. */
export const LOGIN_MS = 15 * 60_000
/** Dev servers one colony may run at once, and how long one gets to start serving. */
export const MAX_SERVERS = 3
export const SERVER_START_MS = 60_000
/** How long a tool call waits for the person's approval before it is denied. */
export const APPROVAL_MS = 15 * 60_000
/** A claimed task whose holder sits idle this long goes back to the pool. */
export const LEASE_MS = 120_000
/** A swarm whose first peer produced no tasks in this long gets a second peer to bootstrap it. */
export const BOOTSTRAP_MS = 60_000
/** The longest a swarm's opening huddle waits for every peer's proposal. */
export const HUDDLE_MS = 90_000
/** Failed final verifications before a round gives up. */
export const MAX_VERIFY_ROUNDS = 3

// Chats (chat.ts)

/**
 * The spend limit per run, in dollars, where the settings file has none (Settings → Crew & budget; 0 means no limit).
 * A settings file that already holds a value keeps it. The Settings hint states it too.
 */
export const DEFAULT_COST_USD = 5
/** The most workers (or swarm peers) a chat's team may have, so one request cannot start an unbounded crowd. */
export const MAX_WORKERS = 8

// Models (models.ts, windows.ts)

/** A model that answered a probe this recently is not probed again, so a chat does not pay a round-trip per message. */
export const PROBE_FRESH_MS = 15 * 60_000
/** How long the model may take to write the entry page's greeting before the rules' line stays. */
export const GREETING_MS = 15_000
/** Gone longer than this, the greeting welcomes the person back. */
export const GREETING_AWAY_MS = 30 * 60_000
/** Team-chat messages an agent keeps for its next turn when nobody wakes it; older ones drop off. */
export const QUIET_KEPT = 30
/** The most text one review field carries; longer content is shown cut and cannot be rewritten in the card. */
export const REVIEW_MAX_CHARS = 200_000
/** How many specialists the person can keep. */
export const MAX_SPECIALISTS = 40
/** A finished round with at least this many tool calls is reviewed for a skill worth keeping (Qwen Code uses 20). */
export const SKILL_REVIEW_CALLS = 20
/** How much of a round the skill reviewer reads, and how long it may take. */
export const SKILL_DIGEST_CHARS = 30_000
export const SKILL_REVIEW_MS = 90_000
/** omp's window for a model it found but knows nothing about; treated as unknown since it is often wrong. */
export const OMP_UNKNOWN = 128_000
/** models.dev's catalog of model context windows, and how often the cached copy is refreshed (a day). */
export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const MODELS_DEV_REFRESH_MS = 24 * 60 * 60_000
/** omp provider ids whose models.dev entry goes by another name. */
export const PROVIDER_ALIASES: Record<string, string> = {
  ark: 'volcengine',
  'openai-codex': 'openai',
  'google-antigravity': 'google',
  'google-gemini-cli': 'google',
}

// Tools (tools.ts)

/** The largest file an agent may publish as an artifact. */
export const MAX_ARTIFACT_BYTES = 512 * 1024
/** Most matches grep returns, and most paths glob lists, so a broad search does not flood the context. */
export const GREP_LIMIT = 100
export const GLOB_LIMIT = 200
/** How much of a fetched page enters the conversation; the rest is saved to a scratch file. */
export const PAGE_EXCERPT = 8_000
/** The most characters a tool result carries into the conversation before it is cut. */
export const MAX_READ_CHARS = 40_000
/** Consecutive failures after which an MCP server's tools are refused for the rest of the round. */
export const MCP_FAILURE_LIMIT = 3

// Browser (browser.ts)

/** The longest page snapshot an agent gets; past it, the agent scrolls or evaluates the part it needs. */
export const SNAPSHOT_CHARS = 12_000
/** Console lines and network requests kept per tab, oldest dropped first, so a chatty page cannot grow without end. */
export const BROWSER_LOG_LIMIT = 200
export const BROWSER_NETWORK_LIMIT = 300
/** The headless browser's window, a common laptop size, so pages lay out as a person would see them. */
export const BROWSER_VIEWPORT = { width: 1280, height: 800 }
/** The longest text a person controlling an agent's tab can paste into it at once. */
export const BROWSER_PASTE_MAX_CHARS = 100_000
/** How long the browser's proxy waits on one address of a host before trying its next one. */
export const BROWSER_CONNECT_MS = 5_000

// Web access (web.ts)

/** Redirect hops one agent fetch follows, each one checked before anything is sent to it. */
export const FETCH_MAX_REDIRECTS = 10

// Reviewer (verifier.ts)

/** The most artifact text the judge reads, so a large delivery still fits the judge's context. */
export const MAX_JUDGE_CHARS = 60_000
/** Cited pages the judge checks, how much of each, and how long fetching one may take. */
export const MAX_SOURCES = 6
export const SOURCE_CHARS = 4_000
export const SOURCE_MS = 15_000
/** The most of a round's project diff the judge reads. */
export const MAX_DIFF_CHARS = 40_000
/** The latest observing tool results the judge sees, and how much of each. */
export const OBSERVED_CALLS = 12
export const OBSERVED_CHARS = 1_500

// Sandbox and hooks (sandbox.ts, hooks.ts)

/** The most output a sandboxed command returns, so a noisy build cannot flood the agent. */
export const SANDBOX_MAX_OUTPUT = 64 * 1024
/** How long a hook may run when it sets no timeout, the most it may set, and how much of its output is kept. */
export const HOOK_TIMEOUT_S = 60
export const HOOK_MAX_TIMEOUT_S = 600
export const HOOK_MAX_OUTPUT = 20_000

// Long-lived children (leash.ts)

/** How long a leashed command's processes get to exit on SIGTERM, once Myrmidon has gone, before they are killed. */
export const LEASH_GRACE_MS = 2_000

// Projects (projects.ts)

/**
 * How freely agents may change a folder added from now on. A folder added before this setting existed has no stored
 * mode and stays autonomous, so nothing changes under the person's feet.
 */
export const NEW_PROJECT_MODE: 'auto' | 'ask' | 'read-only' = 'ask'

// Setup assistant (setup.ts)

/** The smallest context window that can lead a crew; the client's AGENT_MIN_WINDOW (ui-config.ts) is the same. */
export const SETUP_LEAD_MIN_WINDOW = 32_000
/** How long setup waits for a model server on this computer before it counts as not running. */
export const SETUP_PROBE_MS = 800
/**
 * Model servers setup looks for on this computer, at the ports they listen on out of the box, each with the
 * OpenAI-compatible address it is added at and the provider name it gets.
 */
export const SETUP_LOCAL_SERVERS: readonly { id: string; baseUrl: string; provider: string }[] = [
  { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', provider: 'ollama-local' },
  { id: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1', provider: 'lmstudio' },
]
/** Provider keys setup notices in the environment, under the names omp's catalog reads them by (pi-catalog). */
export const SETUP_ENV_KEYS: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
}

// Project context (instructions.ts, git.ts)

/** The most instruction text read from a project, how deep its @imports are followed, and how many folders are searched for nested files. */
export const INSTRUCTIONS_MAX_TEXT = 24 * 1024
export const MAX_IMPORT_DEPTH = 4
export const INSTRUCTIONS_MAX_DIRS = 3000
/** The largest diff patch returned, and which untracked files are shown in full: the first 50, up to 256 KB each. */
export const MAX_PATCH = 512 * 1024
export const MAX_UNTRACKED_SHOWN = 50
export const MAX_UNTRACKED_BYTES = 256 * 1024

// Memory, skills and made tools (memory.ts, skills.ts, made-tools.ts)

/** The longest memory, and the most memories kept, so memory stays a short list of facts. */
export const MEMORY_MAX_TEXT = 400
export const MAX_MEMORIES = 300
/** How much memory a round's prompt carries at most. */
export const RECALL_COUNT = 40
export const RECALL_CHARS = 6_000
/** The most of a skill file an agent reads at once. */
export const SKILL_MAX_FILE_CHARS = 40_000
/** Bundled files listed per skill, so a big skill does not flood the agent. */
export const SKILL_MAX_FILES = 60
/** A learned skill unused this long is marked stale (still usable), and this long is moved to the archive. */
export const SKILL_STALE_DAYS = 30
export const SKILL_ARCHIVE_DAYS = 90
/** How often the server looks for learned skills to retire. */
export const SKILL_CURATE_EVERY_MS = 6 * 60 * 60_000
/** The largest script a made tool may have, to keep tools small. */
export const MADE_TOOL_MAX_SOURCE = 64 * 1024

// Services (mcp.ts, recovery.ts)

/** How long a (re)start waits for MCP servers to list their tools; slower ones are picked up when they finish. */
export const MCP_STARTUP_MS = 10_000
/** A run logged without a pid counts as orphaned once this far past its wall budget. */
export const RECOVERY_GRACE_MS = 60_000

// Chat list (chat-index.ts)

/** The most chats one message search returns, and how much of the matching message shows around the match. */
export const CHAT_SEARCH_LIMIT = 50
export const SNIPPET_BEFORE = 40
export const SNIPPET_AFTER = 100

/**
 * Voice call turn taking (after Hermes): speech above the level for VOICE_START_MS starts a turn, VOICE_END_MS of
 * quiet ends it (shorter than Hermes's 3 s: replies on a call are short), and VOICE_MAX_TURN_MS cuts a turn that runs
 * on. VOICE_PRE_ROLL_MS of audio from before the start is kept so the first syllable is not lost.
 * VOICE_SMART_START_MS (Pipecat's 0.2 s) applies only with the turn model loaded: without it a cough that long
 * would talk over the call.
 */
export const VOICE_START_MS = 300
export const VOICE_SMART_START_MS = 200
export const VOICE_END_MS = 800
/**
 * With Smart Turn (Pipecat's end-of-turn model): a pause this long asks it whether the person has finished, and so
 * does a pause of VOICE_END_MS (a wrong "unfinished" then costs what a turn cost without the model); a turn it still
 * says is unfinished ends after VOICE_SMART_END_MS of quiet. Pipecat's defaults: 0.2 s, and about 3 s.
 */
export const VOICE_PAUSE_MS = 200
export const VOICE_SMART_END_MS = 2_000
export const VOICE_SMART_TURN_THRESHOLD = 0.5
/**
 * On a direct call each turn is a message to the crew, and one thought cut in two is two messages (two answers), so
 * the turn model must be surer before a short pause ends it.
 */
export const VOICE_SMART_TURN_DIRECT_THRESHOLD = 0.8
/** Smart Turn v3.2 for CPU (pipecat-ai/smart-turn-v3, BSD-2-Clause), pinned by revision and hash. */
export const VOICE_SMART_TURN_URL =
  'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx'
export const VOICE_SMART_TURN_SHA256 = '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f'
export const VOICE_SMART_TURN_BYTES = 8_679_182
/** Sentences of a reply read aloud before "the rest is in the chat". */
export const VOICE_SPOKEN_SENTENCES = 6
export const VOICE_MAX_TURN_MS = 30_000
export const VOICE_PRE_ROLL_MS = 300
/** Speech level (RMS of 16-bit samples) for each sensitivity in Settings → Voice; Hermes uses 200. */
export const VOICE_THRESHOLDS = { low: 700, normal: 400, high: 200 } as const
/** How long Phonon-2's server may take to answer after starting; the first start downloads its 164 MB model. */
export const VOICE_PHONON_START_MS = 10 * 60_000
/** The fermion-research release Phonon-2 is installed from, and the size of the model its first start downloads. */
export const VOICE_PHONON_VERSION = '0.2.11'
export const VOICE_PHONON_MODEL_BYTES = 163_515_201
/** The most hotwords Phonon-2 takes in a request (its own limit); a call sends its project's and crew's names. */
export const VOICE_HOTWORDS = 25
/**
 * Kitten TTS 0.8 (KittenML, Apache-2.0): each model pinned to a revision of its Hugging Face repo, and each file to
 * its sha256 (Hugging Face's own LFS ids for the large ones) and size.
 */
export const VOICE_KITTEN_MODELS = {
  nano: {
    repo: 'KittenML/kitten-tts-nano-0.8-fp32',
    revision: '7a1db645b1f3ab9420761d87428e042b9cec3f26',
    files: {
      'config.json': {
        sha256: 'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64',
        bytes: 688,
      },
      'kitten_tts_nano_v0_8.onnx': {
        sha256: '320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e',
        bytes: 56_767_095,
      },
      'voices.npz': {
        sha256: '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f',
        bytes: 3_278_902,
      },
    },
  },
  micro: {
    repo: 'KittenML/kitten-tts-micro-0.8',
    revision: '1ccf72b2c2048fd17efac7de2fab32d10e225084',
    files: {
      'config.json': {
        sha256: '1f0bd2208348f9211cb0da64fcd1536eb28228571cc6b09e767eb6e203a0a532',
        bytes: 473,
      },
      'kitten_tts_micro_v0_8.onnx': {
        sha256: '95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123',
        bytes: 41_384_970,
      },
      'voices.npz': {
        sha256: '112710c1be8ad0e967c190fb0fd95cbe5848ec4791b93209f20b28b7da20dac1',
        bytes: 3_278_902,
      },
    },
  },
  mini: {
    repo: 'KittenML/kitten-tts-mini-0.8',
    revision: 'c02725660cea441db4c383af69f1f26f5cd00947',
    files: {
      'config.json': {
        sha256: '6b160bc9b19e24ecb21e84bc14f8a7da21fdf47ec72d42450bc5cf514b61804a',
        bytes: 470,
      },
      'kitten_tts_mini_v0_8.onnx': {
        sha256: '0f5bbae4fc4800c98dbc544a87ecfa79510de2fb8222db30d12e5bfe9177df91',
        bytes: 78_268_016,
      },
      'voices.npz': {
        sha256: '40ad2638952b77b7b2f30127e2608e169fc69dd256b53bd8aaa3409a33193c42',
        bytes: 3_278_902,
      },
    },
  },
} as const
/** Model calls the call agent may make for one turn (each tool call takes one), and how much of a round's answer it is told. */
export const VOICE_STEPS = 4
export const VOICE_ANSWER_CHARS = 2_000
/**
 * Silero VAD (MIT), the speech detector for call turns: its 16 kHz-only model (1.3 MB, half the general one) from
 * v6.2.3, pinned by hash, downloaded once into <home>/voice.
 * A turn starts above VOICE_VAD_START and, once started, holds until the probability drops VOICE_VAD_HYSTERESIS
 * below that (Silero's own hysteresis).
 */
export const VOICE_VAD_URL =
  'https://github.com/snakers4/silero-vad/raw/v6.2.3/src/silero_vad/data/silero_vad_16k_op15.onnx'
export const VOICE_VAD_SHA256 = '7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49'
export const VOICE_VAD_BYTES = 1_289_603
export const VOICE_VAD_START = { low: 0.7, normal: 0.5, high: 0.35 } as const
export const VOICE_VAD_HYSTERESIS = 0.15
/** Calls this gateway takes at once (each holds a call model and speech engines busy); one per chat at most. */
export const VOICE_MAX_CALLS = 4
/** Days a call's transcript is kept (`<home>/calls`); a chat's go with it when it is deleted. */
export const VOICE_TRANSCRIPT_DAYS = 30
/** How often a running gateway drops transcripts older than that. */
export const VOICE_TRANSCRIPT_PRUNE_MS = 24 * 60 * 60_000
/**
 * Phone calls (Twilio Media Streams): how long a call's one-time ticket (in its TwiML) stands, long enough for a call
 * Myrmidon makes to ring out (Twilio's default ring timeout is 60 s); how long a stream may stay open before its
 * `start` (OpenClaw's 5 s); the largest message a stream may send (OpenClaw's 64 KB; Twilio's are ~20 ms of audio).
 */
export const PHONE_TICKET_MS = 2 * 60_000
export const PHONE_START_MS = 5_000
export const PHONE_MESSAGE_MAX = 64 * 1024
/** How long naming a chat may take, and the rounds after which it is tried (a chat that is only "hi" so far waits). */
export const CHAT_TITLE_MS = 30_000
export const CHAT_TITLE_ROUNDS = 3
/** The smallest context window (tokens) a model that names chats needs; a window omp does not know passes. */
export const CHAT_TITLE_MIN_WINDOW = 16_000
/**
 * Small, fast model tiers, best first, matched against the words of a model id ("gpt-4o-mini", "claude-haiku-4-5"):
 * how chats are named when no available model has a known price.
 */
export const CHAT_TITLE_TIERS = ['haiku', 'flash', 'mini', 'nano', 'lite', 'small', 'fast']
