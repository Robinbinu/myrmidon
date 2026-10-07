/** Keyboard shortcuts written as `mod+shift+[`: `mod` is ⌘ on a Mac and Ctrl elsewhere (either key works). */

export interface Combo {
  readonly key: string
  readonly mod: boolean
  readonly shift: boolean
  readonly alt: boolean
}

export function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+')
  const mods = parts.slice(0, -1)
  return {
    key: parts.at(-1) ?? '',
    mod: mods.includes('mod'),
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

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

export function matchCombo(combo: string, e: KeyInput): boolean {
  const c = parseCombo(combo)
  if (c.mod !== (e.metaKey || e.ctrlKey) || c.alt !== e.altKey) return false
  const key = e.key.toLowerCase()
  // Shift and Option change the character typed ("{", "˜"), so those shortcuts match the physical key too.
  if (c.shift || c.alt) return (!c.shift || e.shiftKey) && (key === c.key || plainKey(e.code) === c.key)
  // Shift makes a letter or digit a different shortcut; for symbols it is how some layouts type them ("/").
  if (e.shiftKey && /^[a-z0-9]$/.test(c.key)) return false
  return key === c.key
}

const NAMES: Record<string, string> = { escape: 'Esc' }

/** How a shortcut is written on this platform: ⇧⌘[ on a Mac (Apple's modifier order), Ctrl+Shift+[ elsewhere. */
export function comboLabel(combo: string, mac: boolean): string {
  const c = parseCombo(combo)
  const key = NAMES[c.key] ?? c.key.toUpperCase()
  if (mac) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+')
}
