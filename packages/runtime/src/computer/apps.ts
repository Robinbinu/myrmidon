/**
 * How much an agent may do in an app on the person's desktop, and what approving it amounts to: the tiers and
 * warnings Claude Code's computer use shows, keyed by bundle id (lists in config.ts).
 */
import {
  COMPUTER_FILE_APPS,
  COMPUTER_OWN_APPS,
  COMPUTER_SEND_APPS,
  COMPUTER_SETTINGS_APPS,
  COMPUTER_SHELL_APPS,
  COMPUTER_VIEW_ONLY_APPS,
} from '../config.ts'
import type { DesktopAction } from './actions.ts'

/** `view`: screenshots and reading only; `click`: also click, move and scroll; `full`: also type, press keys and drag. */
export type AppTier = 'view' | 'click' | 'full'
/** What controlling the app amounts to, shown on its approval card. */
export type AppWarning = 'shell' | 'files' | 'settings'

const matches = (list: readonly RegExp[], bundleId: string) => list.some((r) => r.test(bundleId))

/** Myrmidon's own app, which agents never see or drive. */
export const isOwnApp = (bundleId: string) => matches(COMPUTER_OWN_APPS, bundleId)

/** The most an app allows, before the person grants more: browsers and trading apps view, terminals and IDEs click. */
export function appTier(bundleId: string): AppTier {
  if (matches(COMPUTER_VIEW_ONLY_APPS, bundleId)) return 'view'
  if (matches(COMPUTER_SHELL_APPS, bundleId)) return 'click'
  return 'full'
}

export function appWarning(bundleId: string): AppWarning | undefined {
  if (matches(COMPUTER_SHELL_APPS, bundleId)) return 'shell'
  if (matches(COMPUTER_FILE_APPS, bundleId)) return 'files'
  if (matches(COMPUTER_SETTINGS_APPS, bundleId)) return 'settings'
  return undefined
}

/** Whether pressing Return in the app sends something (a message, a mail). */
export const sendsOnReturn = (bundleId: string) => matches(COMPUTER_SEND_APPS, bundleId)

/** Click-only apps may be given full control by the person; view-only ones never (the browser_* tools drive the web). */
export const canRaise = (bundleId: string) => appTier(bundleId) === 'click'

const NEEDS: Record<DesktopAction['kind'], AppTier> = {
  screenshot: 'view',
  elements: 'view',
  zoom: 'view',
  wait: 'view',
  cursor: 'view',
  list_apps: 'view',
  open_app: 'view',
  click: 'click',
  click_element: 'click',
  move: 'click',
  scroll: 'click',
  type: 'full',
  key: 'full',
  drag: 'full',
}

const RANK: Record<AppTier, number> = { view: 0, click: 1, full: 2 }

/** The tier an action needs; a click holding modifier keys is a keyboard action too. */
export function tierFor(action: DesktopAction): AppTier {
  if (action.kind === 'click' && action.modifiers.length) return 'full'
  return NEEDS[action.kind]
}

export const allows = (granted: AppTier, action: DesktopAction) => RANK[granted] >= RANK[tierFor(action)]
