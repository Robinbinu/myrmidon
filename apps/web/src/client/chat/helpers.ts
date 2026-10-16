/** The helpers setting: what it is called everywhere, and the helpers set aside while it is off. */

import type { ModelOption, RosterEntry, TeamConfig } from '../api.ts'
import { copy } from '../copy.ts'

export type HelperMode = 'never' | 'auto' | 'always'

/** Never: the lead works alone; auto: it brings helpers in when a job needs them; always: every round is the team. */
export function helperMode(config: TeamConfig): HelperMode {
  // A company's roles are the helpers: it has a crew even with no roster of its own.
  if (config.roster.length === 0 && config.extraWorkers === 0 && !config.company) return 'never'
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
    const roster = (raw.roster as Partial<Record<keyof RosterEntry, unknown>>[])
      .filter((r) => typeof r?.role === 'string' && typeof r?.model === 'string' && !!r.model)
      .map(
        (r): RosterEntry => ({
          role: r.role as string,
          model: r.model as string,
          ...(typeof r.specialist === 'string' && r.specialist ? { specialist: r.specialist } : {}),
        }),
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

/**
 * The helpers set aside, on models that can still be used: one that is gone since (a provider signed out, a key
 * removed) is swapped for the lead's model, which the server would otherwise refuse as unknown.
 */
function restoredHelpers(config: TeamConfig, models: readonly ModelOption[]): SavedHelpers | undefined {
  const saved = readSavedHelpers()
  if (!saved) return undefined
  const known = new Set(models.map((m) => m.ref))
  return {
    ...saved,
    roster: saved.roster.map((r) => (known.has(r.model) ? r : { ...r, model: config.leadModel })),
  }
}

/**
 * The config with helpers set to `next`. Never sets the helpers aside and leaves the lead alone (a swarm without
 * peers is no swarm, so it becomes a lead); turning them on brings back the ones set aside, or two to start with.
 */
export function withHelperMode(
  config: TeamConfig,
  next: HelperMode,
  models: readonly ModelOption[],
): TeamConfig {
  const { helpers: _, company: __, tierModels: ___, ...alone } = config
  const { helpers: _h, ...rest } = config
  const on = helperMode(config) !== 'never'
  if (next === 'never') {
    if (on) saveHelpers({ roster: config.roster, extraWorkers: config.extraWorkers, mode: config.mode })
    return { ...alone, mode: 'orchestrated', roster: [], extraWorkers: 0 }
  }
  return {
    ...rest,
    ...(on
      ? {}
      : (restoredHelpers(config, models) ?? {
          mode: 'orchestrated',
          roster: [
            { role: 'researcher', model: config.leadModel },
            { role: 'coder', model: config.leadModel },
          ],
          extraWorkers: 2,
        })),
    ...(next === 'always' ? { helpers: 'always' as const } : {}),
  }
}
