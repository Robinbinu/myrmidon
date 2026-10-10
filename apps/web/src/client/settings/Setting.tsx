import { createContext, type ReactNode, useContext } from 'react'
import { cn, Field } from '../ui/primitives.tsx'
import {
  type DynamicId,
  type ItemOf,
  itemKey,
  SETTINGS,
  type SettingId,
  type StaticSetting,
} from './registry.ts'

/** The attributes that mark a settings row: search jumps to them, and the registry tests read them. */
export type SettingAttrs = { 'data-setting-id': string; 'data-setting-key'?: string }

/** Marks an element as the row of a setting, for rows laid out by hand (a table row, a tile, a custom layout). */
export const settingRow = (id: SettingId): SettingAttrs => ({ 'data-setting-id': id })

/** Marks an element as the row of one live item (a provider, an MCP server), keyed as search lists it. */
export const settingItem = <I extends DynamicId>(id: I, item: ItemOf<I>): SettingAttrs => ({
  'data-setting-id': id,
  'data-setting-key': itemKey(id, item),
})

/** A setting's entry, for a row laid out by hand that shows its label and hint itself. */
export const setting = (id: SettingId): StaticSetting => SETTINGS[id]

/**
 * A setting as a labelled row: its label and hint come from its registry entry, so what search finds is what the row
 * says. `hint` replaces the entry's hint for one that changes with the value (undefined shows none); `bare` leaves
 * out the card row's padding, for a field inside a form.
 */
export function SettingField(props: {
  id: SettingId
  hint?: ReactNode | undefined
  error?: string | undefined
  inline?: boolean
  bare?: boolean
  className?: string
  children: ReactNode
}) {
  const e = setting(props.id)
  const hint = 'hint' in props ? props.hint : e.help
  return (
    <div {...settingRow(props.id)} className={cn(!props.bare && 'px-4 py-3', props.className)}>
      <Field
        label={e.label}
        {...(hint ? { hint } : {})}
        {...(props.error ? { error: props.error } : {})}
        {...(props.inline ? { inline: true } : {})}
      >
        {props.children}
      </Field>
    </div>
  )
}

/** Where search last jumped to: a section reads it to open what hides that row (a folded group, a "show more"). */
export interface SettingTarget {
  id: string
  key?: string
  /** Counts jumps, so jumping to the same row again opens it again. */
  n: number
}

const TargetContext = createContext<SettingTarget | undefined>(undefined)
export const SettingTargetProvider = TargetContext.Provider

/** The jump target while it is one of `ids`, so the section showing them can make the row visible. */
export function useSettingTarget(...ids: string[]): SettingTarget | undefined {
  const target = useContext(TargetContext)
  return target && ids.includes(target.id) ? target : undefined
}
