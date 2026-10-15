/** The desktop shell's tunables, in one place. */

/** The window on first launch, in points. */
export const WINDOW_SIZE = { width: 1280, height: 820 } as const

/**
 * macOS: where the traffic lights sit, from the window's top-left corner in points: centered in the client's 52px
 * toolbar row (each button is 14pt tall, three of them span 54pt). Linux and Windows keep their own title bar
 * (src/platform.ts).
 */
export const WINDOW_BUTTONS = { x: 20, y: 19 } as const

/** macOS: room the sidebar's toolbar leaves for the traffic lights (the client's --titlebar-inset). */
export const TITLEBAR_INSET_PX = 78

/** How long the server may take to start; the first start on a machine loads every model provider. */
export const SERVER_START_TIMEOUT_MS = 90_000
export const SERVER_POLL_MS = 200
/** How much of a failed server's output the error shows: its last lines, where the reason usually is. */
export const SERVER_LOG_TAIL_CHARS = 1_200
/** How long the server gets to stop its running chats on quit before it is killed. */
export const SERVER_STOP_TIMEOUT_MS = 10_000

/**
 * The key that stops computer use from anywhere while an agent controls the Mac, as Electrobun accelerators name it
 * (tried in order). Held as a global shortcut, so the key press is consumed and a page or dialog never sees it.
 */
export const COMPUTER_STOP_KEYS = ['Escape', 'Esc'] as const

/**
 * The environment variable that names the server the app starts; `myrmidon serve` writes it into server.json as
 * `launch` (apps/cli/src/main.ts), so the app knows the server.json is its own server's.
 */
export const LAUNCH_ID_ENV = 'MYRMIDON_LAUNCH_ID'

/** The disk image holds the app with this much room to spare (scripts/make-dmg.ts): a factor and a fixed slack. */
export const DMG_HEADROOM = 1.25
export const DMG_SLACK_MB = 20
