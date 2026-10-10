import { copy } from '../copy.ts'
import { CALL_HANG_UP_COMBO, CALL_MUTE_COMBO, SETTINGS_SEARCH_COMBO } from '../ui-config.ts'
import { isMac } from './platform.ts'
import { Card } from './primitives.tsx'
import { comboLabel } from './shortcuts.ts'

interface ShortcutInfo {
  readonly label: string
  readonly combo: string
  /** The last key of a run of them, as in ⌘1–9: the combo names the first. */
  readonly through?: string
}

const t = copy.settings.shortcuts

/** Every shortcut the app answers, in the groups the shortcuts sheet and Settings → General show them in. */
export const SHORTCUT_GROUPS: readonly { title: string; items: readonly ShortcutInfo[] }[] = [
  {
    title: t.groups.app,
    items: [
      { label: t.commandMenu, combo: 'mod+k' },
      { label: t.newTask, combo: 'mod+n' },
      { label: t.openSettings, combo: 'mod+,' },
      { label: t.searchSettings, combo: SETTINGS_SEARCH_COMBO },
      { label: t.showShortcuts, combo: 'mod+/' },
      { label: t.close, combo: 'escape' },
    ],
  },
  {
    title: t.groups.window,
    items: [
      { label: t.toggleSidebar, combo: 'mod+b' },
      { label: t.toggleWorkspace, combo: 'mod+j' },
      { label: t.workspaceView, combo: 'mod+alt+1', through: '0' },
    ],
  },
  {
    title: t.groups.chat,
    items: [
      { label: t.jumpToChat, combo: 'mod+1', through: '9' },
      { label: t.previousChat, combo: 'mod+shift+[' },
      { label: t.nextChat, combo: 'mod+shift+]' },
      { label: t.focusComposer, combo: '/' },
      { label: t.send, combo: 'enter' },
      { label: t.newLine, combo: 'shift+enter' },
      { label: t.takeWord, combo: 'tab' },
      { label: t.takeSuggestion, combo: 'arrowright' },
      { label: t.stopRun, combo: 'mod+.' },
    ],
  },
  {
    title: t.groups.calls,
    items: [
      { label: t.muteCall, combo: CALL_MUTE_COMBO },
      { label: t.hangUp, combo: CALL_HANG_UP_COMBO },
    ],
  },
]

/** A shortcut as this platform writes it, a run of keys included (⌘1–9, Ctrl+1–9). */
export function shortcutLabel(s: Pick<ShortcutInfo, 'combo' | 'through'>, mac = isMac): string {
  return `${comboLabel(s.combo, mac)}${s.through ? `–${s.through}` : ''}`
}

/** The shortcuts, grouped, each with its keys at the row's end. */
export function ShortcutList() {
  return (
    <div className="flex flex-col gap-5">
      {SHORTCUT_GROUPS.map((g) => (
        <section key={g.title} aria-label={g.title}>
          <h3 className="mb-1.5 px-1 text-small font-semibold text-muted">{g.title}</h3>
          <Card>
            {g.items.map((s) => (
              <div key={s.label} className="flex items-center justify-between gap-4 px-4 py-2 text-body">
                <span>{s.label}</span>
                <kbd className="shrink-0 rounded-sm bg-fill px-1.5 py-px font-sans text-small tabular-nums text-fg-2">
                  {shortcutLabel(s)}
                </kbd>
              </div>
            ))}
          </Card>
        </section>
      ))}
    </div>
  )
}
