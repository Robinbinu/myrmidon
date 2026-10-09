/** The desktop shell's tunables, in one place. */

/** The window on first launch, in points; macOS centers it. */
export const WINDOW_SIZE = { width: 1280, height: 820 } as const

/**
 * Where the traffic lights sit, from the window's top-left corner in points: centered in the client's 52px toolbar row
 * (each button is 14pt tall, three of them span 54pt).
 */
export const WINDOW_BUTTONS = { x: 20, y: 19 } as const

/** Room the sidebar's toolbar leaves for the traffic lights (the client's --titlebar-inset). */
export const TITLEBAR_INSET_PX = 78

/** How long the server may take to start; the first start on a machine loads every model provider. */
export const SERVER_START_TIMEOUT_MS = 90_000
export const SERVER_POLL_MS = 200
/** How long the server gets to stop its running chats on quit before it is killed. */
export const SERVER_STOP_TIMEOUT_MS = 10_000
