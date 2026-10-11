import type { CompactionMethod } from '@myrmidon/protocol'

/**
 * The runtime's tunable limits, timeouts and retry counts, in one place so they can be read and changed together.
 * Some texts state a value too (an error saying "over 64 KB", say); change those with it.
 */

// Agents (agent.ts)

/** The longest one agent turn may run; a safety net only: one turn can include many model calls and large file writes. */
export const TURN_TIMEOUT_MS = 15 * 60_000
/** Retries for a transient model failure (rate limit, overload, timeout) before the person is asked. */
export const MODEL_RETRIES = 2
/** The most fallback models the person may line up after the lead's model, and after the crew's. */
export const MAX_FALLBACKS = 5
/**
 * How long a model that failed stays out of an agent's fallbacks: past it, the model (the configured one first) is
 * tried again when the one the agent fell back to fails too.
 */
export const FALLBACK_COOLDOWN_MS = 5 * 60_000
/** HTTP statuses that make a model failure transient (worth a retry): timeouts, conflicts, rate limits, overloads. */
export const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
/** Turns kept word for word when a new round of the chat starts; older tool output is elided. */
export const KEEP_TURNS = 4

// Context compaction (compaction.ts)

/** The recent part kept word for word: this share of the usable window, at least `KEEP_MIN` tokens. */
export const KEEP_SHARE = 0.25
export const KEEP_MIN = 2_000
/**
 * How a context over the threshold is made to fit, cheapest first (after omp's `compaction.methodOrder`): each method
 * runs only when the ones before it left the context over the threshold. `shake` elides old bulky tool output, which
 * the round log keeps; `snapcompact` archives the older part as dense text images, without a model call, for models
 * that read images (others skip it); `summary` has a model summarize it, and always fits.
 */
export const COMPACTION_ORDER: readonly CompactionMethod[] = ['shake', 'snapcompact', 'summary']
/**
 * A method settles a pass only if it leaves the context under this share of the threshold, so the next call does not
 * cross it again at once and redo the work (omp's recovery band).
 */
export const COMPACTION_SETTLED = 0.8
/** Tool results shake leaves alone below this size (text and images): small ones often carry the step's outcome. */
export const SHAKE_MIN_TOKENS = 250
/**
 * Shake skips a pass that frees less than this share of the threshold (at most omp's 4k tokens), since every elision
 * also invalidates the provider's cached prompt from that message on.
 */
export const SHAKE_MIN_SHARE = 0.05
/** Tool output shake keeps: skill instructions the agent is following, and read_log, which reads elided output back. */
export const SHAKE_KEPT_TOOLS: readonly string[] = ['use_skill', 'read_log']

// Rounds (colony.ts)

/** Stall nudges a colony gets when every agent sits idle with the work unfinished, before it stops. */
export const QUIET_NUDGES = 2
/** How long an agent waits for the person to sign in before it goes on without. */
export const LOGIN_MS = 15 * 60_000
/** Dev servers one colony may run at once, and how long one gets to start serving. */
export const MAX_SERVERS = 3
export const SERVER_START_MS = 60_000
/** How long reading the ports in use (netstat, lsof) may take before a server starts; it blocks the runtime meanwhile. */
export const PORT_LISTING_MS = 2_000
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
/**
 * Goal mode (`/goal <condition>: <request>`, after omp's goal mode and `/loop --until`): a goal round checks its
 * condition on every final answer and goes on while it fails, so it needs caps of its own. The round's spend and token
 * limits (Settings → Crew & budget) apply as to any round.
 */
export const GOAL = {
  /** Checks before the round gives up on the goal (omp's attempt cap): each failed one costs a full pass of work. */
  maxChecks: 8,
  /**
   * The least time a goal round gets: working until a check passes outlasts one answer's wall. A longer wall set in
   * Settings still applies.
   */
  wallMinutes: 120,
  /** How long one run of the condition's command may take, like a project check. */
  commandMs: 300_000,
} as const

// Prompts (prompt/lint.ts)

/**
 * The most words Myrmidon's own text may take under each heading of an agent's system prompt (data it carries, such as
 * memory, project instructions and roster lines, does not count). The research targets
 * (docs/research/2026-10-09-harness-prompts.md §4.3) are you ~150, finish ~80, safety ~200, method ~300, others
 * ~200, person ~200; these sit above them where a heading stacks parts some agents need: the delivery contract under
 * "How you finish", full access or an ask-first project under "Safety", and project rules (or, for a lead with
 * hands-on tools, the lead's method too) under "How to work", and the count of memories left for recall under the
 * person's instructions.
 */
export const PROMPT_HEADING_WORDS = {
  you: 210,
  finish: 150,
  safety: 350,
  method: 710,
  others: 230,
  person: 210,
  instructions: 100,
  environment: 260,
} as const
/**
 * The most words of the stable part (every heading before the person's own text) per kind of agent, the worst case
 * over the test matrix. §4.4's targets: answer ~350, solo 900-1,100, team lead 700-900, worker 600-800, crewmate
 * 500-700, swarm peer 800-1,000; each consolidated safety section (~250 words) is most of the difference.
 */
export const PROMPT_ROLE_WORDS = {
  answer: 650,
  solo: 1340,
  crewmate: 1040,
  'team-lead': 940,
  'team-lead-hands-on': 1620,
  'team-worker': 1180,
  'swarm-peer': 1070,
  'colony-lead': 1000,
  'colony-worker': 1000,
  'colony-peer': 1000,
} as const

/**
 * The most words the model-family blocks (prompt/families.ts) may add for one model, counted apart from the role's
 * budget since they follow the model the agent runs on; the largest today, Gemini's two, is about 105.
 */
export const PROMPT_FAMILY_WORDS = 130

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
/**
 * After the final answer in a round with a crew, the round stays open until everyone has been quiet this long, so
 * nobody is cut off mid-reply and what was said gets read, as a group chat winds down.
 */
export const SETTLE_QUIET_MS = 3_000
/** ...and closes after this long even if the crew keeps talking; whatever is still unread waits for the next round. */
export const CHAT_SETTLE_MS = 120_000
/** Messages each agent may still send once a chat winds down: one last word, then the chat is closed to it. */
export const WIND_DOWN_MESSAGES = 1
/** Unread messages an agent is shown when it next wakes (from before this round); older ones stay in read_messages. */
export const MISSED_SHOWN = 20
/** Each such message is shown up to this many characters. */
export const MISSED_CHARS = 800
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
/**
 * How long one read of every signed-in account's plan limits is reused. Settings and the composer poll it, and
 * providers rate-limit their usage endpoints (Anthropic's and OpenAI's answer 429 to a burst), so a page left open
 * must not reach them more often than this. omp keeps its own per-account cache underneath.
 */
export const PROVIDER_USAGE_CACHE_MS = 60_000
/**
 * The longest one read of every account's limits may take. omp times out each provider call itself; this bounds the
 * whole read, so one hanging provider cannot hold every poll waiting on it.
 */
export const PROVIDER_USAGE_TIMEOUT_MS = 30_000
/** The used share of a window from which it counts as near its limit (omp's `usage` command turns yellow at 80%). */
export const PROVIDER_USAGE_WARN = 0.8
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
/** How much of a fetched page an agent without file tools gets, since nothing is saved for it to read on. */
export const FETCH_SHOWN_CHARS = 16_000
/** Most tools a find_tools query loads by description alone; the rest that match are named for loading by name. */
export const FIND_TOOLS_LIMIT = 12
/** The most characters a tool result carries into the conversation before it is cut. */
export const MAX_READ_CHARS = 40_000
/**
 * The largest PDF, office document, notebook or image fs_read loads to convert: each is read whole into memory, and
 * a bigger one is better taken apart with the shell.
 */
export const READ_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024
/** Most members an archive may hold for fs_read to open it; the index is built in memory. */
export const READ_ARCHIVE_MAX_ENTRIES = 200_000
/** Most bytes a stream archive (tar.gz and the like) decompresses to in memory before fs_read refuses it. */
export const READ_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024
/** The largest archive member fs_read extracts to read, so a small zip cannot unpack into gigabytes. */
export const READ_ARCHIVE_ENTRY_MAX_BYTES = 16 * 1024 * 1024
/** Most rows an fs_read SQL query returns; a LIMIT and OFFSET in the query page through the rest. */
export const READ_SQL_MAX_ROWS = 200
/**
 * fs_read of a whole source file this many lines long or more (or one past MAX_READ_CHARS) returns its structure
 * first: omp's tree-sitter summary (pi-ast), bodies and long comments folded, which an offset/limit read opens. omp
 * summarizes from 100 lines; a file that fits one read comes back whole here unless it is this long. Prose (Markdown,
 * plain text) always reads whole, as in omp.
 */
export const READ_SUMMARY_MIN_LINES = 400
/** omp's fold settings (read.summarize.*): bodies and comments shorter than these stay; unfold to about this many lines. */
export const READ_SUMMARY_FOLD = {
  minBodyLines: 4,
  minCommentLines: 6,
  unfoldUntilLines: 50,
  unfoldLimitLines: 100,
} as const
/** Files larger than this are never summarized (omp's limit): the parse would cost more than reading a range. */
export const READ_SUMMARY_MAX_BYTES = 2 * 1024 * 1024
/**
 * Model ids (omp's classes, as pi-catalog's classifyModel names them) whose fs_edit replaces exact text instead of
 * hashline edits: omp's own per-model fallback (utils/edit-mode.ts), for models that do worse with line anchors.
 */
export const STR_REPLACE_MODELS: readonly {
  readonly class: string
  readonly family?: string
  readonly revision?: string
}[] = [
  { class: 'kimi' },
  { class: 'mimo' },
  { class: 'minimax' },
  { class: 'deepseek' },
  { class: 'stepfun' },
  { class: '*', family: 'codex-spark' },
  { class: 'glm', family: 'flash', revision: '5.3.0' },
]
/**
 * How the hashline engine applies fs_edit (omp's edit.* defaults): whitespace-only differences matched at this
 * similarity, edits refused on lines no read showed in full, and generated files (protoc, sqlc, swagger…) left alone.
 */
export const HASHLINE_POLICY = {
  allowFuzzy: true,
  fuzzyThreshold: 0.95,
  enforceSeenLines: true,
  blockAutoGenerated: true,
} as const
/** Characters per token when the native tokenizer cannot count (an older addon): the usual rough guess. */
export const CHARS_PER_TOKEN = 4
/** How much of each tool result read_log shows under its call; read_log(entry) shows one in full. */
export const READ_LOG_RESULT_CHARS = 400
/** Consecutive failures after which an MCP server's tools are refused for the rest of the round. */
export const MCP_FAILURE_LIMIT = 3

// Media (media.ts): generate_image and tts

/**
 * The largest picture or sound file generate_image and tts publish: a 1536px PNG or a few minutes of WAV is well past
 * what an agent writes by hand (MAX_ARTIFACT_BYTES), and the person opens these in the chat.
 */
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024
/** Most images one generate_image call makes; each one is billed. */
export const MAX_IMAGES_PER_CALL = 4
/** Most input images one generate_image call edits from (omp's image models take up to a handful). */
export const MAX_IMAGE_INPUTS = 5
/** How long one image request may take before it is given up (omp's generate_image allows three minutes). */
export const IMAGE_TIMEOUT_MS = 3 * 60_000
/** Most characters tts turns into speech in one call: about ten minutes of speech. */
export const TTS_MAX_CHARS = 10_000
/**
 * Silence between the sentences of a tts file. Each sentence is spoken on its own (local Kitten speaks one at a time)
 * and trimmed, so without a pause they would run into each other.
 */
export const TTS_SENTENCE_GAP_MS = 180

// Code intelligence (code-intel.ts): ast_grep, ast_edit, lsp

/** Most structural matches ast_grep returns; `skip` pages on from there. */
export const AST_GREP_LIMIT = 50
/**
 * Most files one ast_edit may change, and most replacements in all: past either it is refused whole, since a codemod
 * that big is better narrowed (and in Ask, every file is a card the person reads).
 */
export const AST_EDIT_MAX_FILES = 40
export const AST_EDIT_MAX_REPLACEMENTS = 400
/** How long one structural search or rewrite may scan before it gives up. */
export const AST_TIMEOUT_MS = 20_000
/** How long one lsp call waits on its language server, starting and indexing included. */
export const LSP_CALL_MS = 60_000
/** How long a file's diagnostics may take to arrive after it is opened or changed. */
export const LSP_DIAGNOSTICS_MS = 10_000
/** A language server nobody asked anything for this long is stopped; the next call starts it again. */
export const LSP_IDLE_MS = 10 * 60_000
/** How long a project-wide type check (tsc, cargo check, go vet, pyright) may run. */
export const LSP_PROJECT_CHECK_MS = 300_000
/** Most references and workspace symbols lsp lists; the rest are counted. */
export const LSP_LIST_LIMIT = 100

/**
 * find (find.ts): omp's cascade, which ranks files by their words, then has a model judge their names, sketches of
 * their passages and finally the passages whole. omp sizes it for a native judge that is cheap per question; here the
 * judge is a prompted chat model (the cheapest the person has), so every budget is smaller than omp's (128
 * candidates, 20 files, 40 passages) to keep one call to a few requests.
 */
export const FIND = {
  /** Files ranked by their words that the judge then ranks by name. */
  candidates: 64,
  /** Files per name-ranking request. */
  nameBatch: 64,
  /** Files read and cut into passages. */
  files: 12,
  /** Passages kept per file read, its best by words. */
  windows: 12,
  /** Bytes per passage, as omp cuts them. */
  windowBytes: 8_192,
  /** Bytes of each passage's sketch, and of sketches sent in one request. */
  sketchBytes: 384,
  sketchStateBytes: 18_000,
  /** Passages verified whole, across all files, and their bytes per request. */
  verified: 16,
  verifyStateBytes: 24 * 1024,
  /** Sketch score under which a passage is not verified, and passage score from which a file is a hit (omp's). */
  cutoff: 0.45,
  threshold: 0.2,
  /** Judge requests in flight at once. */
  parallel: 6,
  /** Hits listed, and line ranges shown per hit. */
  hits: 10,
  ranges: 3,
  /** Most bytes of one file read; the rest of a bigger file is not searched. */
  readBytes: 4 * 1024 * 1024,
  /** Wall-clock budget for one call; a stalled judge fails the call instead of holding the turn. */
  timeoutMs: 60_000,
} as const

/**
 * The github tool (github.ts), which runs the GitHub CLI where the agent's commands run. Bounds on how long one `gh`
 * call and one run_watch may take, and how often run_watch asks: GitHub's API allows 5,000 calls an hour per person.
 */
export const GITHUB = {
  commandMs: 60_000,
  watchMs: 10 * 60_000,
  pollMs: 10_000,
  /** How long the person's GitHub token is kept in memory before gh is asked for it again. */
  tokenMs: 60_000,
  /** Items an issue, pull request or run list shows, by default and at most. */
  listLimit: 20,
  listMax: 100,
} as const

// Code cells (cells.ts): eval

/**
 * The argument that makes a compiled Myrmidon run the JavaScript cell runtime it carries (apps/desktop/src/sidecar.ts),
 * here rather than in cells.ts so the sidecar can pick the worker without loading the server's modules into it.
 */
export const CELL_WORKER_COMMAND = 'cell-worker'

/**
 * How long one cell may run when the agent names no limit, and the most it may name. A cell past it is stopped with
 * its runtime (a JavaScript loop cannot be interrupted any other way), so its state is lost.
 */
export const CELL_TIMEOUT_S = 30
export const CELL_MAX_TIMEOUT_S = 300
/** How long a runtime may take to start in the sandbox (bun or python3, and omp's prelude) before the call fails. */
export const CELL_START_MS = 20_000
/** The most of a cell's output the agent reads back; the rest is counted, not kept. */
export const CELL_OUTPUT_CHARS = 20_000
/** Pictures one cell may hand back (a chart it displayed), and the largest one, in base64 characters. */
export const CELL_IMAGES = 2
export const CELL_IMAGE_CHARS = 2_000_000
/**
 * The longest line a runtime may write without a line break (a frame with a picture is one line): past it the runtime
 * is stopped as runaway rather than held whole in memory.
 */
export const CELL_LINE_MAX = 16 * 1024 * 1024
/** How long a runtime's last output may still arrive after it exits, for the message saying why it stopped. */
export const CELL_EXIT_DRAIN_MS = 500

// Debugger (debugger.ts): debug

/** How long one request to a debug adapter may take (starting, a breakpoint, a stack, an evaluation). */
export const DEBUG_REQUEST_MS = 30_000
/**
 * How long launch, continue and the steps wait for the program to stop or end when the agent names no limit, and the
 * most it may name. Past it the program keeps running and the call says so; pause or output reach it later.
 */
export const DEBUG_WAIT_S = 30
export const DEBUG_MAX_WAIT_S = 300
/** How long ending a session waits for the adapter to stop its program before both are killed. */
export const DEBUG_END_MS = 2_000
/** The program's output kept per session (its tail), and the most of what is new that one call shows. */
export const DEBUG_OUTPUT_CHARS = 64_000
export const DEBUG_OUTPUT_SHOWN = 4_000
/** Stack frames listed by default and at most, and variables listed per scope or expanded value. */
export const DEBUG_FRAMES = 20
export const DEBUG_MAX_FRAMES = 100
export const DEBUG_VARIABLES = 100
/** The longest value shown for one variable or evaluation; the rest is cut. */
export const DEBUG_VALUE_CHARS = 400

// Security scan (security-scan.ts): security_scan

/** Most files one scan reads for secrets, and the largest it reads; past either the rest is counted, not read. */
export const SCAN_MAX_FILES = 20_000
export const SCAN_MAX_FILE_BYTES = 1024 * 1024
/** Findings listed per check; the rest are counted. */
export const SCAN_FINDINGS = 100
/**
 * OSV.dev, the open vulnerability database (Google's, which npm, PyPI, crates.io and Go advisories feed): packages
 * are looked up in batches, then the details of each vulnerability listed (at most `perPackage` per package), up to a
 * limit per scan.
 */
export const OSV = {
  batchUrl: 'https://api.osv.dev/v1/querybatch',
  vulnUrl: 'https://api.osv.dev/v1/vulns/',
  batch: 1000,
  perPackage: 10,
  details: 40,
  timeoutMs: 30_000,
} as const

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

// The person's own browser (person-browser.ts)

/** Tabs open at once in the person's browser; each is a live page in the shared Chrome. */
export const PERSON_BROWSER_MAX_TABS = 12
/** The sharpest the person's view is drawn: device pixels per CSS pixel, for Retina screens, at four times the bytes. */
export const PERSON_BROWSER_MAX_SCALE = 2
/** The largest HTML file the person can open from their computer (Open HTML file…), carried as a data: URL. */
export const PERSON_BROWSER_HTML_MAX_BYTES = 2_000_000
/** The largest favicon kept for a tab; bigger ones show the generic glyph. */
export const PERSON_BROWSER_FAVICON_MAX_BYTES = 32_000
/**
 * How often cookies kept Always are saved while the browser is open, besides on closing a tab and on quitting: a
 * sign-in a page's script makes (fetch, document.cookie) sends no event to save on.
 */
export const PERSON_BROWSER_COOKIE_SAVE_MS = 10_000
/** The longest text one copy out of the page brings back. */
export const PERSON_BROWSER_COPY_MAX_CHARS = 100_000
/** Fixed viewports in CSS pixels; Responsive follows the panel instead. */
export const PERSON_BROWSER_VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
} as const

// Web access (web.ts)

/** Redirect hops one agent fetch follows, each one checked before anything is sent to it. */
export const FETCH_MAX_REDIRECTS = 10
/**
 * The longest one page reader program (yt-dlp, trafilatura, lynx) may run before it is stopped. omp gives the whole
 * read its own budget; this bounds a program that ignores it.
 */
export const READER_PROGRAM_TIMEOUT_MS = 60_000
/** The most of a page handed to trafilatura or lynx on stdin; past it the page is cut, as converters cope with. */
export const READER_PAGE_MAX_BYTES = 10 * 1024 * 1024

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

// Advisor (advisor.ts)

/**
 * The advisor: a second model that reads an agent's latest steps and steers it with a short note when it sees a
 * concrete problem. Every number here bounds what it costs, since it runs beside every agent of the round.
 */
export const ADVISOR = {
  /** Review every Nth step that called tools, per agent (omp's review interval); 1 is every such step. */
  every: 1,
  /** Model calls per round across all agents; past it the round goes on unadvised. */
  callsPerRound: 20,
  /**
   * The share of the round's spend or token limit past which the advisor stops: what is left belongs to the agents
   * finishing the work, not to commentary on it.
   */
  budgetShare: 0.8,
  /** The latest assistant steps the advisor reads (with their tool calls and results). */
  steps: 4,
  /** How much of each piece it reads: the agent's text, one tool call's arguments, one tool result, the goal. */
  textChars: 1_200,
  argsChars: 400,
  resultChars: 800,
  goalChars: 2_000,
  /** The longest note it may send; a note is meant to be read in a glance. */
  noteChars: 400,
  /** Output tokens for its reply: a JSON line with one short note. */
  maxTokens: 400,
  /** A review slower than this is dropped: by then the agent has moved past what it saw. */
  timeoutMs: 60_000,
} as const

// Sandbox and hooks (sandbox.ts, hooks.ts)

/** The most output a sandboxed command returns, so a noisy build cannot flood the agent. */
export const SANDBOX_MAX_OUTPUT = 64 * 1024
/** How long a command stopped for running too long may still take to close its output before the run ends. */
export const SANDBOX_TIMED_OUT_READ_MS = 1_000
/**
 * The argument that makes a compiled Myrmidon run the bash it carries for Windows without Git Bash (embedded-shell.ts,
 * apps/desktop/src/sidecar.ts), here so the sidecar can pick it without loading the server's modules.
 */
export const EMBEDDED_SHELL_COMMAND = 'embedded-shell'
/**
 * Toolchain folders in the person's home (relative to it) that sandboxed commands may read, never write: where
 * bun, node version managers, rustup, uv, pyenv and the like install the programs on PATH. Commands get a private
 * HOME, so caches and configs (~/.npm, ~/.cache, ~/Library/Caches, ~/.gitconfig) are their own and not listed;
 * ~/.cargo is listed by its bin folder alone because it also holds the crates.io token. On Windows, per-user
 * installers, scoop and the node managers put programs under AppData, which is otherwise hidden (sandboxSecrets).
 */
export function sandboxToolchains(platform: NodeJS.Platform = process.platform): readonly string[] {
  const shared = ['.bun', '.cargo/bin', '.rustup', '.deno', '.pyenv', '.local/bin', 'go/bin', '.dotnet']
  const conda = ['miniconda3', 'miniforge3', 'anaconda3']
  if (platform === 'win32')
    return [
      ...shared,
      ...conda,
      'scoop/shims',
      'scoop/apps',
      'AppData/Local/Programs',
      'AppData/Local/Microsoft/WindowsApps',
      'AppData/Local/Volta',
      'AppData/Local/pnpm',
      'AppData/Local/mise',
      'AppData/Local/fnm_multishells',
      'AppData/Roaming/npm',
      'AppData/Roaming/nvm',
      'AppData/Roaming/fnm',
      'AppData/Roaming/uv/python',
      'AppData/Roaming/uv/tools',
    ]
  return [
    ...shared,
    '.volta',
    '.nvm',
    '.fnm',
    '.local/share/fnm',
    ...(platform === 'darwin' ? ['Library/Application Support/fnm'] : []),
    '.rbenv',
    '.asdf',
    '.local/share/mise',
    '.local/share/uv',
    '.local/share/pnpm',
    ...(platform === 'darwin' ? ['Library/pnpm'] : []),
    '.sdkman',
    '.ghcup',
    ...conda,
  ]
}
export const SANDBOX_TOOLCHAINS = sandboxToolchains()
/**
 * Paths in the person's home (relative to it) that hold keys, tokens and sign-ins. They stay hidden from sandboxed
 * agents even inside a folder they may read (a project at ~, or "everything in my home"), and a project can never
 * grant them. Naming one exactly in Settings → Permissions opens it everywhere; in one chat, the person may allow an
 * agent's request_read of one (once or for that chat, with a warning on the card). Myrmidon's own data folder, which
 * holds every chat, stays hidden except for the chat's own folder: no request can open it. The dotfiles are the same
 * on every system (Git Bash and the cloud CLIs keep them in the Windows home too); where apps keep their data differs.
 */
export function sandboxSecrets(platform: NodeJS.Platform = process.platform): readonly string[] {
  const dotfiles = [
    '.ssh',
    '.aws',
    '.azure',
    '.gnupg',
    '.kube',
    '.docker',
    '.config',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.git-credentials',
    '.cargo/credentials',
    '.cargo/credentials.toml',
    '.password-store',
    '.zsh_history',
    '.zsh_sessions',
    '.bash_history',
    '.python_history',
    '.psql_history',
    // Other agents' sign-ins and histories (omp's own and its config, Claude Code, Codex, Gemini CLI).
    '.omp',
    '.claude',
    '.claude.json',
    '.codex',
    '.gemini',
    // Shell startup files, where people export API keys.
    '.zshrc',
    '.zshenv',
    '.zprofile',
    '.zlogin',
    '.bashrc',
    '.bash_profile',
    '.profile',
    '.terraform.d',
    '.terraformrc',
    '.vault-token',
    '.pgpass',
    '.gem/credentials',
    '.m2/settings.xml',
    '.yarnrc.yml',
    '.gradle/gradle.properties',
    '.composer/auth.json',
  ]
  if (platform === 'win32')
    return [
      ...dotfiles,
      // curl's and git's netrc on Windows.
      '_netrc',
      // Like macOS's Application Support: gh's hosts.yml, VS Code's tokens, Firefox, DPAPI's master keys, credentials,
      // PowerShell's history. Toolchains inside it (npm, nvm, uv) open again; npm's global npmrc stays hidden.
      'AppData/Roaming',
      'AppData/Roaming/npm/etc',
      // Browsers' profiles (cookies, saved passwords), Windows' credential stores, Store apps' data.
      'AppData/Local/Google/Chrome/User Data',
      'AppData/Local/Chromium/User Data',
      'AppData/Local/Microsoft/Edge/User Data',
      'AppData/Local/BraveSoftware',
      'AppData/Local/Microsoft/Credentials',
      'AppData/Local/Microsoft/Vault',
      'AppData/Local/Packages',
      // PowerShell's startup profiles, where people set API keys.
      'Documents/PowerShell',
      'Documents/WindowsPowerShell',
    ]
  const unix = [
    ...dotfiles,
    '.local/share/keyrings',
    '.mozilla',
    // .NET's certificate store (private keys), inside a toolchain folder that is otherwise readable.
    '.dotnet/corefx',
  ]
  if (platform === 'darwin')
    return [
      ...unix,
      'Library/Keychains',
      'Library/Cookies',
      'Library/Application Support',
      'Library/Mail',
      'Library/Messages',
      'Library/Safari',
      // Sandboxed apps' data, and what app groups share (password managers, mail and chat apps).
      'Library/Containers',
      'Library/Group Containers',
    ]
  return [
    ...unix,
    // Chrome's and Firefox's certificate and key database, Thunderbird, fish's history.
    '.pki',
    '.thunderbird',
    '.local/share/fish',
    // Flatpak and snap apps' data, like macOS's containers (a snap Chromium's profile is in ~/snap/chromium).
    '.var/app',
    'snap',
  ]
}
export const SANDBOX_SECRETS = sandboxSecrets()
/**
 * System folders of programs that a sandboxed command's PATH keeps besides the toolchains (SANDBOX_TOOLCHAINS). The
 * person's own PATH names their apps and folders, so only these entries of it pass, in its order; those it lacks
 * and this computer has are added after. On Windows they follow from where Windows and Program Files are.
 */
export function sandboxSystemBins(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
    const programs = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
    return [
      `${root}\\System32`,
      root,
      `${root}\\System32\\Wbem`,
      `${root}\\System32\\WindowsPowerShell\\v1.0`,
      `${root}\\System32\\OpenSSH`,
      `${programs}\\PowerShell\\7`,
      `${programs}\\Git\\cmd`,
      `${programs}\\nodejs`,
    ]
  }
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/nix/var/nix/profiles/default/bin',
    '/run/current-system/sw/bin',
    '/snap/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
}
export const SANDBOX_SYSTEM_BINS = sandboxSystemBins()
/**
 * Folders outside the home that sandboxed commands may not read either: other disks, the folder all accounts share,
 * and the per-user temp and cache folders where other apps (and other chats) leave files. On Linux also every
 * account's home, the X server's sockets (the screen, input and the clipboard, which macOS keeps from commands by
 * denying the window server and the pasteboard), and the person's runtime folder, which holds their session's
 * sockets: D-Bus, Wayland's, the keyring's, gpg's and ssh's agents (sandbox.ts adds `XDG_RUNTIME_DIR` when it is
 * elsewhere). Folders a command may read or write inside them (a project in the temp folder, or on a disk in /mnt)
 * open again. Windows has no confinement of its own for these to apply to: there commands run in WSL, under Linux's
 * rules.
 */
export function sandboxHiddenRoots(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): readonly string[] {
  if (platform === 'darwin') return ['/Volumes', '/Users/Shared', '/private/var/folders']
  if (platform === 'linux')
    return [
      '/mnt',
      '/media',
      '/run/media',
      '/home',
      '/tmp/.X11-unix',
      ...(uid === undefined ? [] : [`/run/user/${uid}`]),
    ]
  return []
}
export const SANDBOX_HIDDEN_ROOTS = sandboxHiddenRoots()
/**
 * Files in the macOS per-user temp folder (inside a hidden root) that toolchains read: xcrun's cache, which the
 * /usr/bin shims (python3, git, clang) look up on every run and complain loudly without.
 */
export const SANDBOX_TEMP_READABLE = ['xcrun_db'] as const
/**
 * The name prefix of folders in /tmp that Myrmidon keeps sockets in when the data folder's path is too long for one
 * (`socketPath`): the Cua Driver's socket can be there, so they are hidden like the data folder.
 */
export const SANDBOX_HIDDEN_TMP = 'myr-'
/** The most extra readable folders the person may list, in Settings or for one project, and grant in one chat. */
export const MAX_READ_FOLDERS = 50
/** Imported VS Code themes kept in settings, and the most colours one keeps (Myrmidon reads 34). */
export const MAX_IMPORTED_THEMES = 12
export const MAX_THEME_COLORS = 64
/** Names the person may give the mascot's crew cursors (Settings → You & mascot). */
export const MAX_CREW_NAMES = 8
/** How long a hook may run when it sets no timeout, the most it may set, and how much of its output is kept. */
export const HOOK_TIMEOUT_S = 60
export const HOOK_MAX_TIMEOUT_S = 600
export const HOOK_MAX_OUTPUT = 20_000

// Long-lived children (leash.ts)

/** How long a leashed command's processes get to exit on SIGTERM, once Myrmidon has gone, before they are killed. */
export const LEASH_GRACE_MS = 2_000

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
/**
 * Other tools' rule files (rule-files.ts): how many are read from one project, the largest one read at all (a bigger
 * file is not a rule anyone wrote by hand), how much of a file-scoped rule comes with a matching file before it is cut
 * to a pointer, and how many conditional rules the prompt lists by name.
 */
export const RULES_MAX_FILES = 200
export const RULE_FILE_MAX_BYTES = 256 * 1024
export const RULE_MAX_TEXT = 8 * 1024
export const RULES_MAX_LISTED = 50
/**
 * Stream rules (stream-rules.ts): how many replies one agent turn may have stopped and rewritten before the rest of
 * the turn goes unchecked. Each stop bills the abandoned part of a reply and a second request, and a model that keeps
 * breaking rules after their guidance would otherwise loop.
 */
export const STREAM_RULE_RETRIES = 3
/**
 * Drafting a stream rule from a complaint (`/rule`): attempts before the last candidate is shown unconfirmed (omp's
 * /omfg makes 3), how long each may take, and how much of the reply the drafting model sees: its last outputs, each
 * cut to a length.
 */
export const RULE_DRAFT_ATTEMPTS = 3
export const RULE_DRAFT_MS = 90_000
export const RULE_DRAFT_OUTPUTS = 12
export const RULE_DRAFT_OUTPUT_CHARS = 4_000
/** The largest diff patch returned, and which untracked files are shown in full: the first 50, up to 256 KB each. */
export const MAX_PATCH = 512 * 1024
export const MAX_UNTRACKED_SHOWN = 50
export const MAX_UNTRACKED_BYTES = 256 * 1024
/** The largest project file the app opens to show (projects.ts `readProjectFile`). */
export const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024
/** The file browser: entries one folder lists, matches a name search returns, and files it looks through outside git. */
export const MAX_TREE_ENTRIES = 2000
export const MAX_FIND_RESULTS = 200
export const MAX_FIND_SCAN = 50_000

// Memory, skills and made tools (memory.ts, skills.ts, made-tools.ts)

/** The longest memory, and the most memories kept, so memory stays a short list of facts. */
export const MEMORY_MAX_TEXT = 400
export const MAX_MEMORIES = 300
/**
 * How much memory a round's prompt carries at most: every kept memory while they fit, past that the newest
 * `MEMORY_PROMPT_PREFERENCES` preferences and the memories most relevant to the request; agents `recall` the rest.
 */
export const MEMORY_PROMPT_COUNT = 15
export const MEMORY_PROMPT_PREFERENCES = 6
export const RECALL_CHARS = 6_000
/** The most memories one `recall` call returns, and how much of a query it matches on. */
export const RECALL_TOOL_COUNT = 10
export const RECALL_QUERY_CHARS = 2_000
/** Relevance ranking: how much freshness weighs against matching words, and MMR's relevance-over-diversity balance. */
export const RECALL_RECENCY_WEIGHT = 0.2
export const RECALL_MMR_LAMBDA = 0.7
/** Word overlap (0-1) at which two memories say the same thing, so a suggestion of it is not new. */
export const MEMORY_SAME_SIMILARITY = 0.8
/**
 * The memory reviewer (memory-review.ts): suggestions per round at most, how little the person must have said in a
 * round to be read at all, how much of what they said and of the answer it reads, and how long one call may take.
 */
export const MEMORY_EXTRACT_MAX = 3
export const MEMORY_EXTRACT_MIN_CHARS = 15
export const MEMORY_EXTRACT_PERSON_CHARS = 4_000
export const MEMORY_EXTRACT_ANSWER_CHARS = 1_500
export const MEMORY_REVIEW_MS = 60_000
/**
 * Tidying memories up (reflect): the most kept memories it reads and merges it suggests per pass; after a round, it
 * runs at most this often, and only when two kept memories of one scope overlap at least this much.
 */
export const MEMORY_REFLECT_INPUT = 120
export const MEMORY_REFLECT_MAX = 8
export const MEMORY_REFLECT_EVERY_MS = 24 * 60 * 60_000
export const MEMORY_REFLECT_OVERLAP = 0.4
/**
 * Recall by meaning (memory-vectors.ts), only once the person picks an embedding model: how the match by meaning, by
 * words and freshness weigh (omp's mnemopi weighs vector 0.5, full text 0.3, importance 0.2; freshness stands in for
 * importance), the least cosine a memory sharing no word with the request needs to count as related, the most texts
 * one embedding call sends and how long it may take, and the cosine at which two kept memories of one scope look
 * alike enough to tidy up. Any failure falls back to matching words.
 */
export const RECALL_VECTORS = {
  vector: 0.5,
  words: 0.3,
  freshness: 0.2,
  minCosine: 0.3,
  batch: 64,
  timeoutMs: 15_000,
  overlapCosine: 0.85,
} as const
/** The most of a skill file an agent reads at once. */
export const SKILL_MAX_FILE_CHARS = 40_000
/** Bundled files listed per skill, so a big skill does not flood the agent. */
export const SKILL_MAX_FILES = 60
/** A learned skill unused this long is marked stale (still usable), and this long is moved to the archive. */
export const SKILL_STALE_DAYS = 30
export const SKILL_ARCHIVE_DAYS = 90
/** How often the server looks for learned skills to retire. */
export const SKILL_CURATE_EVERY_MS = 6 * 60 * 60_000
/**
 * The skill scanner (skill-scan.ts), after QwenPaw's limits: the most files of one skill it reads and the largest; past
 * either a file is counted as skipped, not read.
 */
export const SKILL_SCAN_MAX_FILES = 100
export const SKILL_SCAN_MAX_FILE_BYTES = 5 * 1024 * 1024
/** How much of a finding's line it quotes, and the most findings one skill reports. */
export const SKILL_SCAN_EXCERPT_CHARS = 140
export const SKILL_SCAN_MAX_FINDINGS = 200

// Installing plugins and skills (install-sources.ts, marketplaces.ts, skill-installs.ts)

/**
 * How long a fetched plugin or skill waits for the person to confirm it after they saw what it holds; then its staged
 * copy is deleted and they review it again.
 */
export const INSTALL_REVIEW_MS = 15 * 60_000
/** Where npm packages are looked up, unless a marketplace entry names its own registry. */
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org'
/** omp's skills registry (skills.omp.sh): search it and install a skill from Settings → Skills. */
export const SKILLS_REGISTRY_URL = 'https://skills.omp.sh'
/** One registry or catalog request; a download that hangs fails instead of holding the review open. */
export const INSTALL_FETCH_TIMEOUT_MS = 60_000
/** The largest package tarball fetched: skills registry packages are capped at 5 MB, plugins get more room. */
export const INSTALL_MAX_BYTES = 50 * 1024 * 1024
/** The largest script a made tool may have, to keep tools small. */
export const MADE_TOOL_MAX_SOURCE = 64 * 1024

// Computer use (computer/)

/**
 * The Cua Driver release Settings → Computer use installs (trycua/cua, MIT): its macOS universal binary tarball, pinned
 * by sha256 and size so an install is the version Myrmidon was tried with.
 */
export const CUA_DRIVER_VERSION = '0.34.0'
export const CUA_DRIVER_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`
export const CUA_DRIVER_SHA256 = '940dc008e0f7c5d217d14c0f247d1ebab91b1bac965f4a649d19e8c789bdfd81'
export const CUA_DRIVER_BYTES = 47_108_179
/** A Cua Driver the person installed themselves (its own installer), used when Myrmidon has not installed one. */
export const CUA_DRIVER_PATHS = [
  '~/.local/bin/cua-driver',
  '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
  '/usr/local/bin/cua-driver',
  '/opt/homebrew/bin/cua-driver',
]
/**
 * The environment variables a driver the person installed gets: it is not the release Myrmidon pinned, so it does not
 * see Myrmidon's own environment (provider keys, tokens).
 */
export const CUA_DRIVER_FALLBACK_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'] as const
/** How long the driver's daemon may take to open its socket, and one desktop action (an accessibility walk) to answer. */
export const COMPUTER_START_MS = 15_000
export const COMPUTER_CALL_MS = 60_000
/** How long a computer action waits for another agent to let go of the app (or the foreground) before it gives up. */
/**
 * The desktop app's overlay asks for the agents' pointers a few times a second while an agent drives the Mac; when it
 * has not asked for this long it is gone, and the driver draws its own cursor again.
 */
export const COMPUTER_OVERLAY_SEEN_MS = 3_000
export const COMPUTER_LOCK_WAIT_MS = 30_000
/** Accessibility elements listed with a screenshot, and walked per window (Electron apps have tens of thousands). */
export const COMPUTER_ELEMENTS_SHOWN = 120
export const COMPUTER_ELEMENTS_WALKED = 800
/** The longest `wait` action, in seconds. */
export const COMPUTER_MAX_WAIT_S = 30
/**
 * The largest screenshot each model family takes, as its long edge in pixels and its area in megapixels. Claude
 * (current toolset models and Opus 4.7+): 2576 px / about 3.75 MP; earlier Claude: 1568 px / 1.15 MP; OpenAI's
 * computer tool and other models get the earlier Claude size, which keeps text legible at modest cost.
 */
export const COMPUTER_IMAGE_LIMITS = {
  claudeLarge: { longEdge: 2576, megapixels: 3.75 },
  claude: { longEdge: 1568, megapixels: 1.15 },
  default: { longEdge: 1568, megapixels: 1.15 },
} as const
/**
 * Claude models that take Anthropic's computer toolset (`computer_toolset_20260801`, no beta header) on the Claude
 * API and Google Cloud, matched against the model id. Others get the generic `computer` function tool.
 */
export const ANTHROPIC_COMPUTER_TOOLSET = 'computer_toolset_20260801'
export const ANTHROPIC_TOOLSET_MODELS = /claude-(?:(?:fable|mythos|opus|sonnet)-5|opus-4-8|haiku-5-5)/
/** Claude models with the larger screenshot limit (the toolset ones, and Opus 4.7). */
export const ANTHROPIC_LARGE_IMAGE_MODELS = /claude-(?:(?:fable|mythos|opus|sonnet)-5|opus-4-[789]|haiku-5-5)/
/**
 * Apps by how much an agent may do in them (as Claude Code's computer use): browsers and trading apps are view-only
 * (the browser_* tools drive the web), terminals and IDEs click-only unless the person allows full control, the rest
 * full. Matched against the bundle id.
 */
export const COMPUTER_VIEW_ONLY_APPS = [
  /^com\.apple\.Safari/,
  /^com\.google\.Chrome/,
  /^org\.mozilla\.(firefox|nightly)/,
  /^com\.microsoft\.edgemac/,
  /^com\.brave\.Browser/,
  /^company\.thebrowser\./,
  /^com\.operasoftware\./,
  /^com\.vivaldi\./,
  /^org\.chromium\./,
  /^com\.kagi\.kagimacOS/,
  /^org\.torproject\.torbrowser/,
  /^com\.duckduckgo\.macos\.browser/,
  /^app\.zen-browser\./,
  /^org\.mozilla\.librewolf/,
  /^net\.waterfox\./,
  /^com\.tradingview\./,
  /^com\.robinhood\./,
  /^com\.webull\./,
  /^com\.interactivebrokers\./,
  /^com\.etrade\./,
  /^com\.fidelity\./,
  /^com\.schwab\./,
]
/**
 * Apps that run the scripts, workflows or shortcuts typed into them: as good as a shell, so click-only with its
 * warning. Their run key, and a click on Run, ask first.
 */
export const COMPUTER_SCRIPT_APPS = [
  /^com\.apple\.ScriptEditor2$/,
  /^com\.apple\.Automator$/,
  /^com\.apple\.shortcuts$/,
  /^com\.latenightsw\.ScriptDebugger/,
  /^com\.stairways\.keyboardmaestro\./,
  /^org\.hammerspoon\.Hammerspoon$/,
  /^com\.raycast\.macos$/,
]
/** Keys that run in a script app (combos as `computerCombo` writes them): cmd+R with any other modifiers, Return. */
export const COMPUTER_SCRIPT_KEYS = [/^cmd(\+\w+)*\+r$/, /^return$/]
export const COMPUTER_SCRIPT_LABEL = /\brun\b/i
export const COMPUTER_SHELL_APPS = [
  ...COMPUTER_SCRIPT_APPS,
  /^com\.apple\.Terminal$/,
  /^com\.googlecode\.iterm2$/,
  /^dev\.warp\./,
  /^com\.mitchellh\.ghostty$/,
  /^net\.kovidgoyal\.kitty$/,
  /^org\.alacritty$/,
  /^io\.alacritty$/,
  /^com\.github\.wez\.wezterm$/,
  /^co\.zeit\.hyper$/,
  /^com\.microsoft\.VSCode/,
  /^com\.visualstudio\.code\./,
  /^com\.todesktop\.230313mzl4w4u92$/,
  /^dev\.zed\.Zed/,
  /^com\.jetbrains\./,
  /^com\.apple\.dt\.Xcode$/,
  /^com\.sublimetext\./,
  /^com\.panic\.Nova$/,
  /^com\.exafunction\.windsurf$/,
  /^com\.anthropic\.claudefordesktop$/,
]
/** Apps whose control amounts to reading and writing any file, or changing system settings: allowed, with a warning. */
export const COMPUTER_FILE_APPS = [/^com\.apple\.finder$/]
export const COMPUTER_SETTINGS_APPS = [/^com\.apple\.systempreferences$/, /^com\.apple\.Settings$/]
/** Myrmidon itself, which agents never see or drive: its desktop app, and browser windows showing its dashboard. */
export const COMPUTER_OWN_APPS = [/^dev\.myrmidon\.app$/]
export const COMPUTER_OWN_WINDOW_TITLE = /\bMyrmidon\b/
/**
 * What makes a desktop action consequential enough to ask the person first: the label of what it clicks (buy, send,
 * delete…), and keys that send or delete. Agents are told to ask before such steps too; this catches the ones they
 * do not. Key combos are matched as `computerCombo` writes them: modifiers in alphabetical order (cmd, ctrl, fn,
 * option, shift), then the key, so each pattern also allows modifiers besides the ones it names.
 */
export const COMPUTER_SENSITIVE_LABEL =
  /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|donate|transfer|send|post|publish|tweet|reply all|submit|delete|remove|erase|trash|empty trash|uninstall|format|wipe|sign out|log out|confirm|approve|accept)\b/i
export const COMPUTER_SENSITIVE_KEYS = [
  /^(cmd|ctrl)(\+\w+)*\+return$/,
  // Delete, Move to Trash, Empty Trash (with or without its confirmation).
  /^cmd(\+\w+)*\+delete$/,
  // Mail's Send.
  /^cmd(\+\w+)*\+shift\+d$/,
]
/** Apps where Return sends what was typed (a message, a mail): pressing it there asks first. */
export const COMPUTER_SEND_APPS = [
  /^com\.apple\.MobileSMS$/,
  /^com\.apple\.mail$/,
  /^com\.tinyspeck\.slackmacgap$/,
  /^com\.hnc\.Discord$/,
  /^net\.whatsapp\.WhatsApp$/,
  /^ru\.keepcoder\.Telegram$/,
  /^org\.whispersystems\.signal-desktop$/,
  /^com\.microsoft\.teams/,
  /^com\.microsoft\.Outlook$/,
]
/**
 * omp's desktop engine (computer/desktop.ts). Screenshots are capped at omp's coordinate-safe frame: a provider that
 * resizes a larger image would put the model's pointer coordinates off.
 */
export const DESKTOP_CAPTURE = { maxWidth: 1280, maxHeight: 896 } as const
/** How long one desktop script may run by default, and at most, in seconds. */
export const DESKTOP_TIMEOUT_S = 30
export const DESKTOP_MAX_TIMEOUT_S = 120
/** The latest screenshots of a script returned to the model, and how much of its text output. */
export const DESKTOP_IMAGES_SHOWN = 3
export const DESKTOP_OUTPUT_CHARS = 12_000
/** How long launching an app (`open -a`) from a desktop script may take. */
export const DESKTOP_OPEN_MS = 15_000

// Services (mcp.ts, recovery.ts)

/** How long a (re)start waits for MCP servers to list their tools; slower ones are picked up when they finish. */
export const MCP_STARTUP_MS = 10_000
/** A run logged without a pid counts as orphaned once this far past its wall budget. */
export const RECOVERY_GRACE_MS = 60_000

// Chat list (chat-index.ts)

/** The most chats one message search returns, and how much of the matching message shows around the match. */
export const CHAT_SEARCH_LIMIT = 50
/** The person's past messages the composer learns its suggestions from, most recent first. */
/** Above this share of control characters in its first bytes, a file without NUL bytes is read as binary. */
export const READ_BINARY_CONTROL_SHARE = 0.1
export const SUGGEST_CORPUS = 2_000
/** The longest name a chat group may have, as it fits a sidebar heading. */
export const CHAT_GROUP_NAME_MAX = 40
/**
 * The composer's optional next-word model: Pythia-14M (EleutherAI, Apache-2.0; ONNX by Xenova), 8-bit, pinned by
 * revision and hash, downloaded once into `<home>/models/pythia-14m` when the person turns it on. Measured on their own
 * typing it was the smallest that helped, at about 2 ms a call.
 */
export const SUGGEST_MODEL = {
  name: 'pythia-14m',
  base: 'https://huggingface.co/Xenova/pythia-14m/resolve/29ac7d207305198580e1af9f73a141a08a47e871/',
  files: [
    {
      path: 'onnx/model_quantized.onnx',
      sha256: '89b2ab5f634da8e5de810652f443d19e276ba4df918da85a93771f8383f51d29',
      bytes: 14_756_094,
    },
    {
      path: 'tokenizer.json',
      sha256: '3cf430678137c8491ca82fb7092ee49e44ad38857fffe1e4a4a5ed860139a5b8',
      bytes: 2_113_738,
    },
    {
      path: 'tokenizer_config.json',
      sha256: '4d1c4fdcf128d28ffcc56e21a36f7002b5e754624c9c8cbd025df7fa58af8428',
      bytes: 264,
    },
  ],
  /** The model's shape, for its empty key/value cache on a first call. */
  layers: 6,
  heads: 4,
  headSize: 32,
} as const
/** A predicted word is offered only when the model gives its first token at least this probability. */
export const SUGGEST_MODEL_MIN_P = 0.3
/** The end of the draft the model reads, and the most tokens one word may take. */
export const SUGGEST_MODEL_CONTEXT_CHARS = 300
export const SUGGEST_MODEL_MAX_TOKENS = 4
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
/**
 * A voice model download fails once its connection has sent nothing for this long (waiting for the server to answer,
 * or between parts of a file): a stuck connection (seen: IPv6 stuck in SYN_SENT to the CDN) otherwise hangs it.
 */
export const VOICE_DOWNLOAD_IDLE_MS = 30_000
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
 * A call's greeting (voice/greeting.ts): at most VOICE_GREETING_WORDS words, never one of the person's last
 * VOICE_GREETING_RECENT lines. A chat's title is said only when it has at most VOICE_GREETING_TITLE_WORDS words and
 * VOICE_GREETING_TITLE_CHARS characters; a call within VOICE_GREETING_AGAIN_MS of the last one opens with "again".
 */
export const VOICE_GREETING_WORDS = 25
export const VOICE_GREETING_RECENT = 5
export const VOICE_GREETING_TITLE_WORDS = 4
export const VOICE_GREETING_TITLE_CHARS = 32
export const VOICE_GREETING_AGAIN_MS = 15 * 60_000
/**
 * Cloud voice providers (voice/providers.ts). A streaming speech to text is asked for the words of a turn once it ends,
 * and given VOICE_STT_FINISH_MS to send them before the turn falls back to a batch transcription. Speech that streams
 * in is passed on in pieces of at least VOICE_TTS_CHUNK_MS (a provider's body arrives in small parts). A request to a
 * provider fails after VOICE_CLOUD_TIMEOUT_MS; its voice list is asked again after VOICE_VOICES_CACHE_MS.
 */
export const VOICE_STT_FINISH_MS = 3_000
export const VOICE_TTS_CHUNK_MS = 80
export const VOICE_CLOUD_TIMEOUT_MS = 20_000
export const VOICE_VOICES_CACHE_MS = 10 * 60_000
/** Streaming speech to text sends audio in pieces of at least this (AssemblyAI takes 50 ms to 1 s per message). */
export const VOICE_STT_CHUNK_MS = 50
/** How often an open speech-to-text stream is kept alive while the turn is quiet (Deepgram closes after 10 s). */
export const VOICE_STT_KEEPALIVE_MS = 5_000
/**
 * Realtime calls: how long a realtime model has to set its session up, and how long a tool call that must check the
 * person's last words (answer_approval) waits for their transcript, which a realtime model writes beside its answer.
 */
export const VOICE_REALTIME_CONNECT_MS = 15_000
export const VOICE_REALTIME_TRANSCRIPT_MS = 3_000
/** The language cloud speech to text is told to expect, as a BCP-47 tag (each provider takes its own form of it). */
export const VOICE_LANGUAGE = 'en-US'

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

// Secrets kept from model providers (provider-secrets.ts)

/** The shortest credential Myrmidon holds that is hidden wherever its value appears: shorter ones would hide words. */
export const MIN_KNOWN_SECRET = 8
/**
 * How long the credentials Myrmidon holds (vault keys, channel tokens) are read once for every model call: many
 * agents calling at once read them once, and a key added in Settings is hidden at most this much later.
 */
export const KNOWN_SECRETS_FRESH_MS = 2_000
/** A placeholder's tag, in base32 characters: 12 carry 60 bits of a keyed hash, so two secrets never share one. */
export const SECRET_TAG_CHARS = 12
/** Texts kept already hidden for the next model call (each step resends the conversation); past it they start over. */
export const HIDDEN_TEXTS_KEPT = 4_000

// Importing Claude Code and Codex sessions (session-import.ts)

/** The newest sessions the import list shows: two tools' whole histories would be a list nobody scrolls. */
export const IMPORT_LIST_MAX = 300
/**
 * How much of each transcript's start and end listing reads for its title and first message: Claude Code writes them
 * the first prompt near the start and appends titles later; reading every transcript whole would read gigabytes.
 */
export const IMPORT_SCAN_BYTES = 64 * 1024
/** The longest first message a listed session shows. */
export const IMPORT_PREVIEW_CHARS = 200
/**
 * The largest transcript that is imported: converting one holds all of it in memory (a 177 MB transcript took about
 * 850 MB), and past this it is mostly screenshots and tool output that would be clipped anyway.
 */
export const IMPORT_MAX_BYTES = 256 * 1024 * 1024
/**
 * What an imported conversation keeps, newest first: it goes into the new chat's first round as its context (every
 * agent of that round reads it), so it is held to about 15k tokens, and to this many messages for the chat view.
 */
export const IMPORT_HISTORY_CHARS = 60_000
export const IMPORT_MAX_TURNS = 400
/** One message's text, a tool call's arguments and a tool's result, each clipped to this in an import. */
export const IMPORT_TURN_CHARS = 4_000
export const IMPORT_TOOL_ARGS_CHARS = 300
export const IMPORT_TOOL_RESULT_CHARS = 600

// Exporting a chat as one HTML page (chat-export.ts)

/**
 * What an HTML export carries inline. The page has to stand alone (sent on, opened offline, without Myrmidon), so
 * files are embedded rather than linked; past these sizes a file is named but left out, keeping a long chat's page to
 * a few megabytes that a browser opens at once and a person can still send.
 */
export const CHAT_EXPORT = {
  /** A text file (code, notes, JSON) shown in full under its run. */
  textBytes: 64 * 1024,
  /** A picture shown under its run, as a data: URL. */
  imageBytes: 512 * 1024,
  /** Everything embedded in one page together; files after this are named only. */
  totalBytes: 4 * 1024 * 1024,
  /** A crewmate's message (mail, team chat) in the folded crew section. */
  crewChars: 4_000,
  /** One tool step's line: the tool and what it was called on. */
  stepChars: 140,
  /** Tool steps listed per run; the count covers all of them. */
  stepsListed: 200,
} as const

// Sharing a chat live with another person (chat-shares.ts)

/**
 * How long an invite to join a chat live stays open. It works once; sharing is for now, so an unused link lapses
 * rather than waiting in someone's inbox.
 */
export const SHARE_INVITE_MS = 60 * 60_000
/** Invites one chat may have open at once, and people in it besides the person. */
export const SHARE_MAX_INVITES = 10
export const SHARE_MAX_GUESTS = 8
/**
 * Characters in an invite code. From a 31-letter alphabet that is about 59 bits, so guessing one of a few open codes
 * is hopeless even without a cap on wrong tries (a cap would let anyone who can reach the gateway withdraw them all).
 */
export const SHARE_CODE_LENGTH = 12
/** A guest's name, as they typed it: cut to this before anyone sees it. */
export const SHARE_NAME_CHARS = 40

// Remote hosts over SSH (ssh.ts)

export const SSH = {
  /** Hosts the person may add in Settings → Tools. */
  maxHosts: 50,
  /** How long a command runs when the agent names no time, and the longest it may name, in seconds. */
  timeoutS: 60,
  maxTimeoutS: 600,
  /** Connecting (and starting the shared connection) gives up after this, so a dead host cannot hold a step. */
  connectS: 10,
  /** How long the shared connection stays open after its last use (OpenSSH's ControlPersist), in seconds. */
  persistS: 600,
  /** The most of a remote file one read brings back; the agent is told when a file is longer. */
  readBytes: 256 * 1024,
  /** Settings' Test button: the same probe with a short limit. */
  testS: 15,
  /** How long output is still read once ssh has exited, before a pipe something else holds is let go. */
  drainMs: 500,
} as const

// Autoresearch (autoresearch.ts)

/**
 * The experiment loop on an agent's own branch (after omp's autoresearch): bounded by trials and by time, which never
 * runs past the round's own wall.
 */
export const AUTORESEARCH = {
  /** Trials when the agent names no number, and the most it may name. */
  trials: 10,
  maxTrials: 50,
  /** How long the loop may run when the agent names no time, in minutes. */
  minutes: 30,
  /** The longest one run of the measure command may take. */
  measureMs: 10 * 60_000,
  /** Kept back from the round's deadline, so the agent can still finish and answer after the last trial. */
  reserveMs: 2 * 60_000,
  /** What a measure run's output shows the agent, from its end, where results are printed. */
  outputChars: 4_000,
} as const

// Telemetry export over OTLP (telemetry.ts)

export const TELEMETRY = {
  /** What collectors see as the sender (OTel's service.name). */
  serviceName: 'myrmidon',
  /** The vault entry (with the model providers' keys) that holds the person's OTLP headers, e.g. an API key. */
  headersId: 'otlp-headers',
  /** One request to the collector gives up after this. */
  timeoutMs: 10_000,
  /** Spans one round sends at most; a longer round sends its first ones and says how many it left out. */
  maxSpans: 5_000,
} as const
