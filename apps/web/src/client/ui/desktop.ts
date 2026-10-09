/**
 * What the desktop shell (apps/desktop) gives this page. The shell injects `window.myrmidonDesktop` before the page
 * loads, only into its own window on its own Myrmidon; in a browser it is absent and every caller keeps its web path.
 */

export interface DesktopBridge {
  /** The native folder dialog; undefined when the person cancels. */
  pickFolder(): Promise<string | undefined>
  /** Shows a file or folder in Finder. */
  reveal(path: string): Promise<void>
  notify(title: string, body: string): Promise<void>
  /** The number on the Dock icon; 0 clears it. */
  setBadge(count: number): Promise<void>
  /**
   * An agent controls the person's Mac (computer use), or no longer does: while one does, the shell holds Esc from
   * anywhere and sends DESKTOP_COMPUTER_STOP. Absent from shells older than computer use.
   */
  computerControl?(active: boolean): Promise<void>
}

/** The window event an app-menu item sends, its detail the shortcut it stands for (`mod+n`), as in shortcuts.ts. */
export const DESKTOP_SHORTCUT_EVENT = 'myrmidon:shortcut'
/** The shortcut event's detail when the person pressed Esc while an agent controls their Mac. */
export const DESKTOP_COMPUTER_STOP = 'computer-stop'

declare global {
  interface Window {
    myrmidonDesktop?: DesktopBridge
  }
}

export const desktop = (): DesktopBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.myrmidonDesktop
