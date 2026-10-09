/** UI decisions and tunables: limits, timings and motion physics, kept together so they are easy to adjust. */

/* ------------------------------------------------------------------ motion */

/** The app's default spring, for panels, menus and controls that move into place. */
export const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const
/** A gentler spring for content entering the page. */
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const
/** A bouncy pop for things that arrive with some character: an agent's chip joining the crew. */
export const popSpring = { type: 'spring', stiffness: 520, damping: 17 } as const
/** Eyes following where they look: quick, without the overshoot of a pop. */
export const lookSpring = { type: 'spring', stiffness: 420, damping: 30 } as const
/** A plain fade: a dialog's backdrop, a toast leaving. */
export const fade = { duration: 0.15 } as const
/** A context menu appearing and leaving: quick, as a Mac's do, with no travel. */
export const menuFade = { duration: 0.1 } as const
/** The least room a context menu keeps between itself and the window's edges. */
export const MENU_EDGE_PX = 8
/** How long a toast stays: one with a button long enough to reach for it, an error long enough to read. */
export const TOAST_MS = { info: 3500, error: 7000, action: 15_000 } as const
/** How long a deleted chat can be taken back: it is only hidden until then, and deleted for good after. */
export const UNDO_DELETE_MS = 8000
/** Takes back the latest delete while it can still be undone; not while typing, where it undoes the typing. */
export const UNDO_DELETE_COMBO = 'mod+z'

/* ------------------------------------------------------------------ models */

/**
 * Below this many tokens a model cannot hold an agent's instructions and tools with room left to work: a lead's first
 * request is 9–12k tokens, a helper's up to 26k.
 */
export const AGENT_MIN_WINDOW = 32_000
/** The shortest a model picker's list gets before it opens the other way. */
export const MODEL_LIST_MIN_PX = 160

/* ------------------------------------------------------------------ composer */

/** Files one message can carry. */
export const MAX_FILES = 10
/** The largest attachment a message can carry; the error text in copy.app.fileTooLarge names the same size. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/**
 * When the composer toolbar's chips don't fit at their full width, thinking, reviewer and helpers fold into one Team
 * chip so the model and project keep their names. They unfold only once this much more room than they need is free,
 * so a width at the edge doesn't flip them back and forth.
 */
export const TOOLBAR_FOLD_SLACK_PX = 24

/* ------------------------------------------------------------------ workspace panel */

/**
 * From this window width (Tailwind's xl) the workspace panel docks beside the chat; below it, it covers the chat, so
 * it opens only when asked for, never by itself because a chat has files.
 */
export const WORKSPACE_DOCK_PX = 1280

/* ------------------------------------------------------------------ command menu */

/** How many of each group the command menu (⌘K) lists: with nothing typed, and while typing. */
export const PALETTE_LIMITS = {
  idle: { actions: 8, chats: 5, projects: 3, settings: 0 },
  searching: { actions: 6, chats: 8, projects: 5, settings: 6 },
} as const

/* ------------------------------------------------------------------ sidebar */

/** How long typing in the chat search pauses before the server searches what was said; titles match at once. */
export const MESSAGE_SEARCH_DELAY_MS = 200

/* ------------------------------------------------------------------ scrolling */

/** Within this many pixels of the bottom, a view counts as following its newest content and keeps doing so. */
export const STICK_SLACK_PX = 120
/** A scroll this soon after the reader's wheel, touch or key counts as theirs (reading back), not the browser's. */
export const USER_SCROLL_MS = 600

/* ------------------------------------------------------------------ round screen */

/** Activity items kept in a round's stream; older ones drop off the end. */
export const MAX_ACTIVITY_ITEMS = 500
/** Replay speeds offered for scrubbing through a round. */
export const REPLAY_SPEEDS = [1, 4, 16, 64]

/* ------------------------------------------------------------------ diffs */

/** Above this many line pairs a before/after diff shows as a full replace instead of a line-by-line match. */
export const DIFF_MAX_CELLS = 4_000_000
/** A folder with more changed files than this starts folded in change lists (often caches or build output). */
export const FOLDER_FOLD_AT = 10

/* ------------------------------------------------------------------ agents and the mascot */

/** The colours the mascot can rest in (Settings → You & mascot); its moods still bring their own. */
export const MASCOT_COLORS = {
  amber: '#ffb31a',
  ice: '#7fdcff',
  mint: '#5ee6a8',
  pink: '#ff8fc0',
  violet: '#b69cff',
  white: '#f2f2f2',
} as const
/** How long each thing the mascot's screen rotates through stays up. */
export const MASCOT_SCREEN_MS = 7_000
/** How often the entry page's greeting is asked for again, and how soon after a pending one. */
export const GREETING_REFRESH_MS = 5 * 60_000
export const GREETING_RETRY_MS = 3_000

/** How long an agent sits idle before its face dozes off. */
export const AGENT_DOZE_MS = 15_000

/** Resting the pointer on the mascot's screen this long counts as a pat. */
export const MASCOT_PAT_MS = 700
/** The mascot sleeps after this long without the pointer moving. */
export const MASCOT_DOZE_MS = 45_000
/** The user's own pointer outranks the crew's for this long after it moves. */
export const MASCOT_USER_FOCUS_MS = 2500
/**
 * Windows shorter than this leave the mascot off the new-chat view: its screen (about 180px) would push the message
 * box and the starters below the fold, and they matter more.
 */
export const HERO_MASCOT_MIN_HEIGHT = 640
/** How many of the latest chats the new-chat view lists under its starters. */
export const HERO_RECENT_CHATS = 5

/* ------------------------------------------------------------------ crew cursors */

/*
 * Cursor physics, tuned against React Bits Pro's User Cursor:
 * - the arrow rides a stiff spring, the name tag a softer one, so the tag trails behind;
 * - while moving, the arrow turns its tip toward the direction of travel, weighted by speed, on its own
 *   softer spring, and keeps whatever heading it had when it stops;
 * - the tag swings by how far it lags behind; the arrow pops in on arrival and dips when it clicks.
 */
export const CURSOR = {
  arrowSpring: { stiffness: 380, damping: 32, mass: 0.6 },
  labelSpring: { stiffness: 220, damping: 26, mass: 0.7 },
  turnSpring: { stiffness: 170, damping: 20, mass: 0.8 },
  size: 22,
  /** The tilt a cursor starts with before it has ever moved. */
  startTilt: -14,
  pressScale: 0.92,
  /** Speed (px/s) at which the arrow points fully along its path. */
  fullTurnSpeed: 1400,
  labelTiltMax: 8,
  labelTiltPerPx: 0.11,
  /** The arrow and its name tag popping in; the tag a beat after. */
  arrowPop: { type: 'spring', stiffness: 600, damping: 24 },
  labelPop: { type: 'spring', stiffness: 500, damping: 26, delay: 0.05 },
  /** The ring a click leaves. */
  clickRing: { duration: 0.5, ease: 'easeOut' },
} as const

/* ------------------------------------------------------------------ connection */

/** A crew's event stream reconnects after this long, doubling while the server stays down, up to the most. */
export const STREAM_RETRY_MS = 1500
export const STREAM_RETRY_MAX_MS = 15_000

/** After a 401, how long before another one asks the server again whether this device is still paired. */
export const SIGNED_OUT_RECHECK_MS = 10_000

/** How often the gateway switcher checks whether the other gateways answer. */
export const GATEWAY_POLL_MS = 30_000

/* ------------------------------------------------------------------ settings */

/**
 * Below this window width Settings shows its section list as icons only: next to the app sidebar (260px) the full
 * list (256px) would leave the page too little room.
 */
export const SETTINGS_NAV_COLLAPSE_PX = 1100

/**
 * A two-step remove ignores its second step for this long after the first, so a double-click or a held Enter that
 * arms it cannot also confirm it.
 */
export const CONFIRM_ARM_DELAY_MS = 400

/** How often the page asks the gateway how it is doing (the indicator, badges, request notifications). */
export const STATUS_POLL_MS = 10_000
/** Voice calls: the rate the mic is sent at (what Phonon-2 takes), and samples per frame sent (20 ms). */
export const CALL_RATE = 16_000
export const CALL_FRAME = 320
/** Lines of the live transcript the call bar keeps. */
export const CALL_LINES = 6
/** Call shortcuts: ⌘D mutes as in Google Meet, ⇧⌘H hangs up as in Microsoft Teams. */
export const CALL_MUTE_COMBO = 'mod+d'
export const CALL_HANG_UP_COMBO = 'mod+shift+h'
/** How often Settings → Voice looks again while an engine installs or downloads, to show its progress. */
export const VOICE_POLL_MS = 2000
/** Speech speeds offered in Settings → Voice. */
export const VOICE_SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const
/** Thumbnails of pictures in the message box before sending, in pixels. */
export const ATTACH_THUMB_PX = 64
