/**
 * What a plugin's UI (`ui/index.tsx`) can fill, and what each slot's component receives. The module exports
 * `slots`: `{ 'workspace.tab': { title: 'Board', component: Board }, 'chat.card': { component: Card }, … }`.
 * React and Myrmidon's UI kit (`import { Button } from '@myrmidon/ui'`) are the app's own copies, so plugin UI
 * shares the app's hooks, look and theme.
 */

import type { ColonyState } from './colony-state.ts'

export const PLUGIN_SLOTS = ['chat.card', 'workspace.tab', 'composer.chip', 'settings.page'] as const
export type PluginSlotName = (typeof PLUGIN_SLOTS)[number]

/** The components of Myrmidon's UI kit a plugin can import from `@myrmidon/ui`. */
export const PLUGIN_UI_KIT = [
  'Button',
  'IconButton',
  'Badge',
  // The older name for Badge, kept so plugins that import it keep working.
  'Pill',
  'Switch',
  'TextInput',
  'TextArea',
  'Select',
  'Segmented',
  'Skeleton',
  'Empty',
  'Markdown',
  'cn',
] as const

export interface PluginSlotProps {
  /** Under a plugin's own `plugin/event` in a round: the event, and a way to answer in the chat. */
  'chat.card': {
    readonly event: { readonly type: string; readonly data: Record<string, unknown> }
    readonly state: ColonyState
    send(text: string): void
  }
  /** A tab in the workspace panel, beside Files and Terminal, for the round shown. */
  'workspace.tab': { readonly colonyId: string; readonly state: ColonyState }
  /** A chip in the composer toolbar: it can put text in the message box or send a message. */
  'composer.chip': { readonly chatId?: string; insert(text: string): void; send(text: string): void }
  /** A page under the plugin's row in Settings → Plugins, with its settings and a way to save them. */
  'settings.page': {
    readonly values: Record<string, string | number | boolean>
    save(values: Record<string, string | number | boolean>): Promise<void>
  }
}
