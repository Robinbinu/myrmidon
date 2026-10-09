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
/** How many titles the sheet deleting several chats names before it says how many more. */
export const DELETE_TITLES_SHOWN = 5

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
/** Stroke widths of the crew map's links, in px: a pair that traded one message, and the busiest pair. */
export const MAP_LINK_WIDTH = { min: 1.25, max: 6 } as const
/** The crew map's arrowheads, in px at a 1px line; they grow by this much per px of line. */
export const MAP_ARROW_PX = { base: 14, perWidth: 3 } as const
/** The latest events whose messages count as live, drawn as moving links on the crew map. */
export const MAP_RECENT_EVENTS = 25

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
/** The new-chat mascot spelling out what the person types in its own screen cells, with a blinking cursor bar. */
export const MASCOT_TYPING = {
  /** This long without typing, its eyes come back (at once when the box is cleared). */
  idleMs: 5_000,
  /** Its screen follows the message box at most this often, so fast typing does not redraw it on every key. */
  throttleMs: 80,
  /** The cursor bar after the letters turns on and off this often (it stays lit with less motion). */
  blinkMs: 530,
  /** The letters take another of the mascot's colours after a random number of words in this range. */
  colorEveryWords: [2, 4],
} as const
/**
 * Windows shorter than this leave the mascot off the new-chat view: its screen (about 300px) would push the message
 * box and the starters below the fold, and they matter more.
 */
export const HERO_MASCOT_MIN_HEIGHT = 760
/** How many of the latest chats the new-chat view lists under its starters. */
export const HERO_RECENT_CHATS = 5

/** The new-chat mascot's dot screen, in cells; its clips and shows are drawn for this grid. */
export const MASCOT_GRID = { cols: 15, rows: 8 } as const
/** The beats the mascot's eye clips are built from, so they share one tempo; each frame lasts one of these. */
export const MASCOT_BEATS = {
  /** The eyes shut for a blink. */
  blink: 120,
  /** One quick step of a movement, such as the eyes sliding a cell. */
  step: 90,
  /** A glance landing somewhere. */
  glance: 260,
  /** Holding a look long enough to read it. */
  hold: 700,
  /** Lingering on an expression: a side-eye, drooping lids, a peek. */
  linger: 1400,
} as const
/** The tricks the new-chat mascot plays while nobody types. */
export const MASCOT_IDLE = {
  /** How often it considers playing one, and the chance it does each time. */
  everyMs: 1000,
  chance: 0.12,
  /** The share of its tricks that are the Pac-Man show rather than something its eyes do. */
  showShare: 0.1,
} as const
/** Shows that take the mascot's whole screen. */
export const MASCOT_SHOWS = {
  /** The scanline sweeping down as the screen opens, per row. */
  bootRowMs: 55,
  /** Confetti when a run finishes: how many bits, how long they fall, a frame, and gravity in cells/s². */
  confetti: { count: 18, ms: 1500, frameMs: 50, gravity: 22 },
  /** Pac-Man eating a row of dots, one cell per step. */
  pacmanStepMs: 120,
  /**
   * The Game of Life while it sleeps: how long asleep before it starts, a generation, the most generations before it
   * starts over (it also does when every cell dies or nothing changes), and how thickly the eyes' cells seed it.
   */
  life: { afterMs: 20_000, stepMs: 380, maxGenerations: 120, seedDensity: 0.35 },
  /** Equaliser bars while a voice call is on: a frame, and how much the mic's level is raised to fill them. */
  equaliser: { frameMs: 70, gain: 8 },
} as const
/** The mascot's drawn reactions. */
export const MASCOT_REACTIONS = {
  /** How long a plain reaction's expression shows before it settles back. */
  ms: 1600,
  /** Star eyes after a run finishes, twinkling at this rate. */
  starsMs: 2400,
  twinkleMs: 220,
  /** Spiral eyes when dizzy: a quarter turn per step. */
  spiralStepMs: 110,
  /** Tears after a run fails, one cell of a tear's fall per step. */
  tearsMs: 3200,
  dropMs: 150,
  /** The sweat drop while it is concerned: one cell down per step, then a pause before the next. */
  sweatStepMs: 170,
  sweatPauseMs: 900,
  /** Flames under its eyes once at least this many crews work at once, flickering at this rate. */
  fireAt: 2,
  fireFlickerMs: 110,
  /** The z's floating up while it sleeps, a cell per step. */
  zzzStepMs: 420,
} as const
/** Touching the mascot's screen. */
export const MASCOT_TOUCH = {
  /** A press held this long without moving starts charging; it fills the screen over `chargeMs`, then pops. */
  holdMs: 380,
  chargeMs: 1500,
  chargeFrameMs: 60,
  /** Moving this far while pressed is a drag: the eyes follow, squashing or stretching a cell per this much speed (px/ms). */
  dragPx: 6,
  stretchSpeed: 0.7,
  /** A click's ripple: one ring outward per step. */
  rippleStepMs: 45,
  /** The pop when a charge is full: the flash, then each ring of its burst. */
  popFlashMs: 70,
  popRingMs: 55,
  /** This many clicks within the window confuse it: its eyes swirl for `confusedMs` and its crew falls down. */
  confusedClicks: 5,
  confusedWindowMs: 2000,
  confusedMs: 3200,
} as const

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

/**
 * The new-chat mascot's crew cursors, which steer themselves (Reynolds' steering behaviours, ui/steering.ts). Distances
 * are px from the mascot's centre, speeds px/s, forces px/s².
 */
export const MASCOT_CREW = {
  /** How many cursors hang around it. */
  count: 3,
  /**
   * Each cursor's personality, drawn from these ranges once per visit: top speed and force, curiosity (how often it
   * flies over to poke), nerve (courage: how far it runs, how readily it freezes, how long it lies dazed) and how much
   * its wandering wobbles.
   */
  personality: {
    maxSpeed: [320, 520],
    maxForce: [1400, 2400],
    curiosity: [0.3, 1],
    nerve: [0.2, 1],
    jitter: [0.6, 1.6],
  },
  /** How hard it pulls toward the velocity it wants, per second (see STEER_GAIN). */
  gain: 6,
  /** Arrival slows down within this distance of where it is going. */
  slowRadius: 140,
  /** The wander circle: how far ahead, how big, and how fast its point drifts (radians/s at a jitter of 1). */
  wander: { distance: 60, radius: 34, jitter: 5 },
  /** Cursors closer than this push each other away. */
  separationRadius: 110,
  /** How strongly each behaviour counts when they are added up. */
  weights: { wander: 3, separation: 1600, avoid: 1800, contain: 2400 },
  /** Room it keeps around the mascot's screen when not poking it, and how far ahead (s) it looks for the screen. */
  faceMargin: 26,
  lookahead: 0.35,
  /**
   * How far inside the canvas's edges it stays, the extra room on the right for its name tag, and how far above the
   * canvas's floor it lands when it falls.
   */
  edge: 24,
  tagRoom: 90,
  floorPad: 56,
  /** How long it stays around one spot while roaming. */
  roamMs: [2800, 7000],
  /** Chance per second it flies over to poke the mascot, at full curiosity; the click and the pause after it. */
  pokePerSecond: 0.12,
  clickMs: 240,
  lingerMs: 650,
  /** Scattering when the mascot is startled: how long it runs (longer with less nerve), and how much faster. */
  scatterMs: 1100,
  scatterBoost: 1.5,
  /** The share of its top speed it gathers at (when the mascot is happy) and sneaks up at (while it sleeps). */
  gatherSpeed: 0.55,
  sneakSpeed: 0.16,
  /** It freezes when the mascot's eyes point within this cosine of it; more nerve narrows the cone by up to `freezeNerve`. */
  freezeCos: 0.88,
  freezeNerve: 0.08,
  /** Falling down: gravity, the share of speed a bounce keeps, sideways friction, and the landing speed it stops at. */
  gravity: 2600,
  restitution: 0.45,
  friction: 0.75,
  restSpeed: 110,
  /** The first knock as it falls: upward and sideways speed, and its spin in degrees/s. */
  knock: { up: [150, 380], side: [60, 240], spin: [360, 900] },
  /** Lying dazed on the floor (shorter with more nerve), then getting up: speed builds over `riseMs` to `riseSpeed`. */
  dazedMs: 1700,
  riseMs: 2400,
  riseSpeed: 0.6,
  /** How quickly the arrow turns to point where it goes (per second), and the speed at which it points fully along it. */
  turnRate: 9,
  fullTurnSpeed: 900,
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

/* ------------------------------------------------------------------ setup assistant */

/**
 * The setup assistant's mascot. It stays one mascot on every screen: big and centred on Welcome and Ready, beside
 * the content on the rest, travelling between the two on `travel`.
 */
export const SETUP_MASCOT = {
  /** Its screen's width, in px, in each place; beside the content in a window narrower than `narrowBelow`, smaller. */
  width: { center: 340, side: 220, narrowSide: 150 },
  narrowBelow: 860,
  /** On a stage shorter than this, it sits smaller in the centre place too. */
  shortBelow: 700,
  shortScale: 0.66,
  /**
   * The screen's content and the mascot are centred together right of the step list: the content at most this wide,
   * this far from the mascot beside it, and at least `edge` from every side.
   */
  contentMax: 640,
  gap: 48,
  edge: 32,
  /** Its dot screen's lettering, in px per dot, and the most letters it shows. */
  dot: 2.4,
  screenChars: 12,
  /** Moving to its place on a new screen: a soft spring, so it is seen to travel. */
  travel: { type: 'spring', stiffness: 170, damping: 22, mass: 0.9 },
  /** How long a reaction's expression shows before it settles back. */
  reactionMs: 1600,
  /** Each beat of waking up on Welcome. */
  wakeBeatMs: 650,
  /** One letter of the greeting typing out on its screen. */
  typeMs: 90,
  /** How often it may play a trick while left alone, and the chance it does each time. */
  trickEveryMs: 4000,
  trickChance: 0.2,
  /** Where crewmates' cursors wait once they have poked it, relative to its centre, in px: under it, clear of the
   * content beside it. */
  crewSpots: [
    { x: -60, y: 120 },
    { x: 40, y: 150 },
    { x: -30, y: 185 },
    { x: 60, y: 215 },
    { x: -70, y: 245 },
    { x: 20, y: 275 },
    { x: -40, y: 305 },
    { x: 50, y: 335 },
  ],
  /** Where a cursor comes from and leaves to: off past its right edge. */
  crewOffstage: { x: 520, y: -260 },
} as const
/** A provider just connected in setup: how often its models are looked for, and how many times, before giving up. */
export const SETUP_MODEL_WAIT = { everyMs: 1500, tries: 8 } as const
/** The pause, once setup is finished, before a starter prompt is sent, so the mascot can settle on the home screen. */
export const SETUP_HANDOFF_MS = 750
/** The microphone test: the analyser's window, and how much its level is raised to reach the mascot's eyes. */
export const MIC_TEST = { fftSize: 512, gain: 5 } as const
/**
 * What uv's install of Phonon-2's runtime (mlx and the rest) adds on disk, which the server does not measure: with the
 * models it does report, voice on this computer comes to about 1.3 GB. Shown before the person chooses it.
 */
export const VOICE_RUNTIME_BYTES = 1_100_000_000
/**
 * Computer use: how often the page asks whether an agent controls the Mac (for the banner and the desktop app's Esc;
 * less often while computer use is off), and how often Settings refreshes the driver's install progress and macOS's grants while it is open.
 */
export const COMPUTER_POLL_MS = 2_000
export const COMPUTER_IDLE_POLL_MS = 15_000
export const COMPUTER_SETTINGS_POLL_MS = 1_500

// Permissions (permissions/)

/** Width of the chat's permission popover in the composer, and of an approval card's remember menu. */
export const PERMISSIONS_POPOVER_PX = 320
export const APPROVAL_MENU_PX = 260
/** Room an approval card's menu needs above its button to open upward; with less it opens downward. */
export const APPROVAL_MENU_ROOM_PX = 340
/** How tall the rules table grows before it scrolls. */
export const RULES_LIST_MAX_PX = 420
