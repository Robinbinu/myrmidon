/** The helpers setting: what it is called everywhere, and the helpers set aside while it is off. */

import type { RosterEntry, TeamConfig } from '../api.ts'
import { copy } from '../copy.ts'

export type HelperMode = 'never' | 'auto' | 'always'

/** Never: the lead works alone; auto: it brings helpers in when a job needs them; always: every round is the team. */
export function helperMode(config: TeamConfig): HelperMode {
  if (config.roster.length === 0 && config.extraWorkers === 0) return 'never'
  return config.helpers === 'always' ? 'always' : 'auto'
}

/** The helpers setting in words, the same on the chip and in every summary: "No helpers", "2 helpers · auto". */
export function helpersLabel(config: TeamConfig): string {
  const mode = helperMode(config)
  if (mode === 'never') return copy.teamControls.helpers.none
  return copy.teamControls.helpers.summary(
    config.roster.length || config.extraWorkers,
    config.mode === 'swarm',
    copy.teamControls.helperModes[mode].title,
  )
}

/** What the current helpers setting does, in the words of its option. */
export function helpersHint(config: TeamConfig): string {
  return copy.teamControls.helperModes[helperMode(config)].hint
}

const SAVED_HELPERS_KEY = 'myr-helpers-saved'
export type SavedHelpers = Pick<TeamConfig, 'roster' | 'extraWorkers' | 'mode'>

/**
 * The helpers set aside when they were turned off, so turning them back on restores them, after a reload too. The
 * team config itself has no "off" switch: no roster and no extra helpers is what tells the server the lead works alone.
 */
export function readSavedHelpers(): SavedHelpers | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_HELPERS_KEY) ?? 'null') as Partial<SavedHelpers> | null
    if (!raw || (raw.mode !== 'orchestrated' && raw.mode !== 'swarm') || !Array.isArray(raw.roster)) return
    const roster = raw.roster.filter(
      (r): r is RosterEntry => typeof r?.role === 'string' && typeof r?.model === 'string' && !!r.model,
    )
    const extraWorkers = typeof raw.extraWorkers === 'number' ? Math.max(0, Math.floor(raw.extraWorkers)) : 0
    return roster.length || extraWorkers ? { mode: raw.mode, roster, extraWorkers } : undefined
  } catch {
    return undefined
  }
}

export function saveHelpers(saved: SavedHelpers) {
  try {
    localStorage.setItem(SAVED_HELPERS_KEY, JSON.stringify(saved))
  } catch {
    // Private browsing forgets the set-aside helpers; turning them on again starts from the defaults.
  }
}
