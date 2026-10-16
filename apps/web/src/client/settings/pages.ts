import type { LucideIcon } from 'lucide-react'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'

export type Section =
  | 'general'
  | 'appearance'
  | 'mascot'
  | 'specialists'
  | 'companies'
  | 'devices'
  | 'gateways'
  | 'channels'
  | 'voice'
  | 'computer'
  | 'models'
  | 'team'
  | 'tools'
  | 'permissions'
  | 'skills'
  | 'plugins'
  | 'hooks'
  | 'schedules'
  | 'instructions'
  | 'memory'

/** The two tabs of Models & providers. */
export type ModelsTab = 'models' | 'providers'

export type SectionGroup = keyof typeof copy.settings.page.groups
/** The order the section list shows its groups in. */
export const GROUPS: readonly SectionGroup[] = ['setup', 'agents', 'extend', 'connect', 'you']

const page = (id: Section, group: SectionGroup, icon: LucideIcon) => ({
  id,
  group,
  label: copy.settings.sections[id].label,
  hint: copy.settings.sections[id].hint,
  icon,
})

/** The sections in the order the list shows them, each under its group's heading. */
export const SECTIONS: { id: Section; group: SectionGroup; label: string; hint: string; icon: LucideIcon }[] =
  [
    page('models', 'setup', FEATURE_ICONS.models),
    page('team', 'setup', FEATURE_ICONS.crew),
    page('permissions', 'setup', FEATURE_ICONS.permissions),
    page('specialists', 'agents', FEATURE_ICONS.specialists),
    page('companies', 'agents', FEATURE_ICONS.company),
    page('instructions', 'agents', FEATURE_ICONS.instructions),
    page('memory', 'agents', FEATURE_ICONS.memory),
    page('skills', 'agents', FEATURE_ICONS.skills),
    page('tools', 'extend', FEATURE_ICONS.tools),
    page('plugins', 'extend', FEATURE_ICONS.plugins),
    page('hooks', 'extend', FEATURE_ICONS.hooks),
    page('schedules', 'extend', FEATURE_ICONS.schedules),
    page('general', 'you', FEATURE_ICONS.general),
    page('appearance', 'you', FEATURE_ICONS.appearance),
    page('mascot', 'you', FEATURE_ICONS.mascot),
    page('devices', 'connect', FEATURE_ICONS.devices),
    page('gateways', 'connect', FEATURE_ICONS.gateways),
    page('channels', 'connect', FEATURE_ICONS.channels),
    page('voice', 'connect', FEATURE_ICONS.voice),
    page('computer', 'connect', FEATURE_ICONS.computerUse),
  ]

/**
 * Page ids that addresses and links used before a page moved, and where each now lives, so an old `?settings=`
 * address still opens the right page. Reviewer joined Crew & budget, which already chose the reviewer's model.
 */
const SECTION_ALIASES: Readonly<Record<string, Section>> = { verification: 'team' }

/** The page a name stands for (an old name goes where it moved), or nothing for a name no page has. */
export function sectionFor(name: string | null | undefined): Section | undefined {
  if (!name) return undefined
  return SECTIONS.find((s) => s.id === name)?.id ?? SECTION_ALIASES[name]
}

type SectionInfo = (typeof SECTIONS)[number]
const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]))

/** A page's name, hint and glyph. */
export const sectionInfo = (id: Section): SectionInfo => BY_ID.get(id) as SectionInfo
