import { PERMISSION_PRESETS, type PermissionPreset } from '@myrmidon/protocol'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState } from 'react'
import { copy } from '../copy.ts'
import { Button, cn } from '../ui/primitives.tsx'
import { spring } from '../ui-config.ts'
import { PRESET_ICONS, presetLabel } from './describe.ts'

const t = copy.permissions

/**
 * The main switch, as Codex's /permissions offers it: Read only, Ask, Auto, Full access, from the strictest, each with
 * its one line. A project or chat shows "Use global (…)" first (`inherit`), the choice that follows the level above.
 * Full access takes a second, warned confirmation before `onChange` hears of it. A radio group: arrow keys move
 * between the choices, as with any radio buttons.
 */
export function PresetChoice(props: {
  value: PermissionPreset | undefined
  onChange(next: PermissionPreset | undefined): void
  /** Offers "use the level above" first; the label names what that is now. */
  inherit?: { label: string; preset: PermissionPreset }
  /** Which presets to offer (the setup assistant leaves out Full access). */
  presets?: readonly PermissionPreset[]
  /** Full access confirmed already (it is the saved value): choosing it again needs no second click. */
  fullConfirmed?: boolean
  disabled?: boolean
}) {
  const name = useId()
  const [confirming, setConfirming] = useState(false)
  const presets = props.presets ?? PERMISSION_PRESETS
  const choose = (next: PermissionPreset | undefined) => {
    if (next === 'full' && !props.fullConfirmed && props.value !== 'full') return setConfirming(true)
    setConfirming(false)
    props.onChange(next)
  }
  const selected = (p: PermissionPreset | undefined) => !confirming && props.value === p
  return (
    <div className="flex flex-col gap-2">
      <fieldset aria-label={t.presetsLabel} disabled={props.disabled} className="m-0 min-w-0 border-0 p-0">
        {props.inherit && (
          <Tile
            name={name}
            value="inherit"
            checked={selected(undefined)}
            onChange={() => choose(undefined)}
            icon={PRESET_ICONS[props.inherit.preset]}
            label={props.inherit.label}
            hint={t.inherit.hint}
            className="mb-2"
          />
        )}
        <div className={cn('grid gap-2', presets.length > 3 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-3')}>
          {presets.map((p) => (
            <Tile
              key={p}
              name={name}
              value={p}
              checked={selected(p) || (confirming && p === 'full')}
              onChange={() => choose(p)}
              icon={PRESET_ICONS[p]}
              label={presetLabel(p)}
              hint={t.presets[p].hint}
              warn={p === 'full'}
              stacked
            />
          ))}
        </div>
      </fieldset>
      <AnimatePresence initial={false}>
        {confirming && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warn/35 bg-warn-soft px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold text-warn-ink">{t.confirmFullTitle}</p>
                <p className="text-callout leading-snug text-fg-2">{copy.fullAccess.warning}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="borderless" onClick={() => setConfirming(false)}>
                  {t.cancel}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setConfirming(false)
                    props.onChange('full')
                  }}
                >
                  {t.confirmFull}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** One choice: a real radio button under a tile that reads as its label. */
function Tile(props: {
  name: string
  value: string
  checked: boolean
  onChange(): void
  icon: (p: { className?: string }) => React.ReactNode
  label: string
  hint: string
  warn?: boolean
  /** Icon over the text, for the grid; otherwise beside it. */
  stacked?: boolean
  className?: string
}) {
  const Icon = props.icon
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-focus/30 has-[:disabled]:cursor-default has-[:disabled]:opacity-50',
        props.stacked ? 'flex-col' : 'items-start',
        props.checked
          ? props.warn
            ? 'border-warn/50 bg-warn-soft/60'
            : 'border-accent/50 bg-accent-soft/50'
          : 'border-line bg-surface hover:bg-fill',
        props.className,
      )}
    >
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={props.onChange}
        className="sr-only"
      />
      <Icon
        className={cn(
          'size-4 shrink-0',
          !props.stacked && 'mt-0.5',
          props.checked ? (props.warn ? 'text-warn-ink' : 'text-accent-fg') : 'text-muted',
        )}
      />
      <span className="min-w-0">
        <span className="block text-body font-medium text-fg">{props.label}</span>
        <span className="block text-callout leading-snug text-muted">{props.hint}</span>
      </span>
    </label>
  )
}
