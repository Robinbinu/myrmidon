/** UI decisions and tunables: limits, timings and motion physics, kept together so they are easy to adjust. */

/* ------------------------------------------------------------------ motion */

/** The app's default spring, for panels, menus and controls that move into place. */
export const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const
/** A gentler spring for content entering the page. */
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

/* ------------------------------------------------------------------ models */

/**
 * Below this many tokens a model cannot hold an agent's instructions and tools with room left to work: a lead's first
 * request is 9–12k tokens, a helper's up to 26k.
 */
export const AGENT_MIN_WINDOW = 32_000

/* ------------------------------------------------------------------ composer */

/** Files one message can carry. */
export const MAX_FILES = 10
/** The largest attachment a message can carry; the error text in copy.app.fileTooLarge names the same size. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

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
}

/** How often the gateway switcher checks whether the other gateways answer. */
export const GATEWAY_POLL_MS = 30_000
