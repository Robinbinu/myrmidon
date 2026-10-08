import { PLUGIN_SLOTS, type PluginSlotName, type PluginSlotProps } from '@myrmidon/protocol'
import * as React from 'react'
import {
  Component,
  type ComponentProps,
  type ComponentType,
  forwardRef,
  type ReactNode,
  useSyncExternalStore,
} from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { importPluginUI } from './api.ts'
import { Markdown } from './chat/Markdown.tsx'
import { copy } from './copy.ts'
import {
  Badge,
  Button,
  cn,
  Empty,
  IconButton,
  Segmented,
  Select,
  Skeleton,
  Switch,
  TextArea,
  TextInput,
} from './ui/primitives.tsx'

/**
 * Plugin UI on the page: each enabled plugin's `ui/index.tsx` is fetched built, imported, and its `slots` export
 * fills the spots it names. A plugin's components run with the app's React and UI kit, set on the global below
 * before any plugin loads, and each one sits behind its own error boundary.
 */

/** What a plugin's UI module may export per slot. */
export interface SlotDef<S extends PluginSlotName = PluginSlotName> {
  readonly component: ComponentType<PluginSlotProps[S]>
  /** For a workspace tab: its name in the panel. */
  readonly title?: string
}

type Slots = { [S in PluginSlotName]?: SlotDef<S> }

/** Button variants the kit offered before they were merged; plugins that still pass one get the nearest today. */
const OLD_VARIANTS: Record<string, ComponentProps<typeof Button>['variant']> = {
  ghost: 'borderless',
  toolbar: 'borderless',
  secondary: 'push',
  soft: 'primary',
}

const PluginButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, 'variant'> & { variant?: string }
>(function PluginButton({ variant, ...rest }, ref) {
  const known = (variant && OLD_VARIANTS[variant]) || (variant as ComponentProps<typeof Button>['variant'])
  return <Button ref={ref} variant={known} {...rest} />
})

const kit = {
  Button: PluginButton,
  IconButton,
  Badge,
  Pill: Badge,
  Switch,
  TextInput,
  TextArea,
  Select,
  Segmented,
  Skeleton,
  Empty,
  Markdown,
  cn,
}
;(globalThis as Record<string, unknown>).__myrmidon = { React, jsxRuntime, ui: kit }

const loaded = new Map<string, { stamp: string; slots: Slots }>()
const failed = new Map<string, string>()
let snapshot: { plugin: string; slots: Slots }[] = []
const listeners = new Set<() => void>()

function publish() {
  snapshot = [...loaded].map(([plugin, l]) => ({ plugin, slots: l.slots }))
  for (const l of listeners) l()
}

/** Loads new and changed plugin UIs and drops the ones switched off; `uiStamp` says when a plugin's UI changed. */
export async function syncPluginUI(
  plugins: readonly { name: string; enabled: boolean; ui?: string; uiStamp?: string }[],
) {
  const wanted = new Map(plugins.filter((p) => p.enabled && p.ui).map((p) => [p.name, p.uiStamp ?? '']))
  let changed = false
  for (const name of [...loaded.keys()])
    if (!wanted.has(name)) {
      loaded.delete(name)
      changed = true
    }
  for (const [name, stamp] of wanted) {
    if (loaded.get(name)?.stamp === stamp || failed.get(name) === stamp) continue
    try {
      const module = (await importPluginUI(name)) as { slots?: Slots }
      const slots = Object.fromEntries(
        Object.entries(module.slots ?? {}).filter(
          ([slot, def]) =>
            (PLUGIN_SLOTS as readonly string[]).includes(slot) && typeof def?.component === 'function',
        ),
      ) as Slots
      loaded.set(name, { stamp, slots })
      failed.delete(name)
      changed = true
    } catch (err) {
      // Tried again only when its files change; the reason shows in the console and the slot stays empty.
      console.error(`plugin ${name}: its UI did not load:`, err)
      failed.set(name, stamp)
    }
  }
  if (changed) publish()
}

/** The plugins filling a slot, in plugin name order. */
export function usePluginSlots<S extends PluginSlotName>(slot: S): { plugin: string; def: SlotDef<S> }[] {
  const all = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot,
  )
  return all.filter((p) => p.slots[slot]).map((p) => ({ plugin: p.plugin, def: p.slots[slot] as SlotDef<S> }))
}

/** Keeps a plugin's crash inside its own slot. */
class SlotBoundary extends Component<{ plugin: string; children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {}
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override componentDidCatch(error: unknown) {
    console.error(`plugin ${this.props.plugin} crashed:`, error)
  }
  override render() {
    if (this.state.error)
      return (
        <div
          className={cn('rounded-xl border border-bad/25 bg-bad-soft px-3 py-2 text-callout text-bad-ink')}
        >
          {copy.pluginSlot.failed(this.props.plugin, this.state.error)}
        </div>
      )
    return this.props.children
  }
}

/** One plugin's component for a slot, behind its error boundary. */
export function PluginSlot<S extends PluginSlotName>(props: {
  plugin: string
  def: SlotDef<S>
  props: PluginSlotProps[S]
}) {
  const Slot = props.def.component as ComponentType<PluginSlotProps[S]>
  return (
    <SlotBoundary plugin={props.plugin}>
      <Slot {...props.props} />
    </SlotBoundary>
  )
}
