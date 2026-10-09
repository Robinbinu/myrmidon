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
/** How much of each tool result read_log shows under its call; read_log(entry) shows one in full. */
export const READ_LOG_RESULT_CHARS = 400
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
/**
 * Toolchain folders in the person's home (relative to it) that sandboxed commands may read, never write: where
 * bun, node version managers, rustup, uv, pyenv and the like install the programs on PATH. Commands get a private
 * HOME, so caches and configs (~/.npm, ~/.cache, ~/Library/Caches, ~/.gitconfig) are their own and not listed;
 * ~/.cargo is listed by its bin folder alone because it also holds the crates.io token.
 */
export const SANDBOX_TOOLCHAINS = [
  '.bun',
  '.cargo/bin',
  '.rustup',
  '.deno',
  '.volta',
  '.nvm',
  '.fnm',
  '.local/share/fnm',
  'Library/Application Support/fnm',
  '.pyenv',
  '.rbenv',
  '.asdf',
  '.local/share/mise',
  '.local/bin',
  '.local/share/uv',
  '.local/share/pnpm',
  'Library/pnpm',
  'go/bin',
  '.sdkman',
  '.dotnet',
  '.ghcup',
  'miniconda3',
  'miniforge3',
  'anaconda3',
] as const
/**
 * Paths in the person's home (relative to it) that hold keys, tokens and sign-ins. They stay hidden from sandboxed
 * agents even inside a folder they may read (a project at ~, or "everything in my home"), and a project or a chat can
 * never grant them; only naming one exactly in Settings → Tools opens it. Myrmidon's own data folder, which holds
 * every chat, is treated the same way except for the chat's own folder.
 */
export const SANDBOX_SECRETS = [
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
  '.bash_history',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
  '.local/share/keyrings',
  '.mozilla',
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
  // .NET's certificate store (private keys), inside a toolchain folder that is otherwise readable.
  '.dotnet/corefx',
  // Sandboxed apps' data, and what app groups share (password managers, mail and chat apps).
  'Library/Containers',
  'Library/Group Containers',
] as const
/**
 * Folders outside the home that sandboxed commands may not read either: other disks, the folder all accounts share,
 * and the per-user temp and cache folders where other apps (and other chats) leave files. Folders a command may
 * read or write inside them (a project in the temp folder) open again.
 */
export const SANDBOX_HIDDEN_ROOTS = ['/Volumes', '/Users/Shared', '/private/var/folders'] as const
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
export const COMPUTER_SCRIPT_KEYS = [/^cmd\+r$/i]
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
 * do not.
 */
export const COMPUTER_SENSITIVE_LABEL =
  /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|donate|transfer|send|post|publish|tweet|reply all|submit|delete|remove|erase|trash|empty trash|uninstall|format|wipe|sign out|log out|confirm|approve|accept)\b/i
export const COMPUTER_SENSITIVE_KEYS = [
  /^(cmd|ctrl)\+(return|enter)$/i,
  /^cmd\+(delete|backspace)$/i,
  /^(shift\+cmd|cmd\+shift)\+delete$/i,
  // Mail's Send.
  /^(shift\+cmd|cmd\+shift)\+d$/i,
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
