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
