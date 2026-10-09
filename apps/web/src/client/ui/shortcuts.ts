/**
 * Keyboard shortcuts written as `mod+shift+[`: `mod` is ⌘ on a Mac and Ctrl elsewhere (either key works). `ctrl` is
 * the Control key on every platform, for the few shortcuts a Mac also gives Control (⌃⇥ between tabs).
 */

export interface Combo {
  readonly key: string
  readonly mod: boolean
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
}

export function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+')
  const mods = parts.slice(0, -1)
  return {
    key: parts.at(-1) ?? '',
    mod: mods.includes('mod'),
    ctrl: mods.includes('ctrl'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt'),
  }
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
}

/** The key a physical key types without modifiers: KeyN → n, Digit1 → 1, BracketLeft → [. */
function plainKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return CODE_KEYS[code]
}

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> &
  Partial<Pick<KeyboardEvent, 'getModifierState'>>

export function matchCombo(combo: string, e: KeyInput): boolean {
  const c = parseCombo(combo)
  // AltGr reports Ctrl and Alt on Windows, but it types characters (AltGr+7 is "{" on German layouts).
  if (e.getModifierState?.('AltGraph')) return false
  if (c.ctrl ? !e.ctrlKey || e.metaKey : c.mod !== (e.metaKey || e.ctrlKey)) return false
  if (c.alt !== e.altKey) return false
  const key = e.key.toLowerCase()
  // Shift and Option change the character typed ("{", "˜"), so those shortcuts match the physical key too.
  if (c.shift || c.alt) return (!c.shift || e.shiftKey) && (key === c.key || plainKey(e.code) === c.key)
  // Shift makes a letter, digit or named key (Tab) a different shortcut; for symbols it is how some layouts type
  // them ("/").
  if (e.shiftKey && (/^[a-z0-9]$/.test(c.key) || c.key.length > 1)) return false
  return key === c.key
}

const NAMES: Record<string, string> = { escape: 'Esc', enter: 'Enter', tab: 'Tab' }
/** Keys a Mac writes as a symbol, as its menus do. */
const MAC_NAMES: Record<string, string> = { enter: '↩', tab: '⇥' }

/** How a shortcut is written on this platform: ⇧⌘[ on a Mac (Apple's modifier order), Ctrl+Shift+[ elsewhere. */
export function comboLabel(combo: string, mac: boolean): string {
  const c = parseCombo(combo)
  const key = (mac ? MAC_NAMES[c.key] : undefined) ?? NAMES[c.key] ?? c.key.toUpperCase()
  if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`
  return [(c.mod || c.ctrl) && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+')
}

/**
 * Does what a shortcut does, for a menu that offers the same command: whichever handler owns the combo right now
 * (the workspace panel's ⌘J while a chat is open, the app's otherwise) answers it.
 */
export function pressShortcut(combo: string, mac: boolean) {
  const c = parseCombo(combo)
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: c.key,
      metaKey: mac && c.mod,
      ctrlKey: c.ctrl || (!mac && c.mod),
      shiftKey: c.shift,
      altKey: c.alt,
    }),
  )
}
