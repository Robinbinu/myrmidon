import { ChevronDown, Gauge, Minus, Plus, Sparkles, User, Users, UsersRound, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useRef, useState } from 'react'
import { type ModelOption, type ReviewMode, type RosterEntry, SPECIALISTS, type TeamConfig } from '../api.ts'
import { copy } from '../copy.ts'
import { useSpecialists } from '../specialists.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { MenuItem, MenuList, Popover } from '../ui/Popover.tsx'
import { agentColor } from '../ui/pixel.tsx'
import { Button, cn, Segmented, Select } from '../ui/primitives.tsx'
import { AGENT_MIN_WINDOW } from '../ui-config.ts'
import { type HelperMode, helperMode, helpersLabel, withHelperMode } from './helpers.ts'
import { ModelPicker, PickerHost, windowLabel } from './ModelPicker.tsx'

const PILL =
  'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-line bg-fill/40 px-2.5 text-callout font-medium text-fg-2 shadow-[inset_0_0.5px_0_rgb(255_255_255/0.07)] transition-colors hover:bg-fill hover:text-fg'

/**
 * A glass pill in the composer toolbar that opens its own panel above it. The pill reads as its value (the label is
 * its tooltip and description), so what a person sees is what a screen reader says and what voice control matches.
 */
function ChipMenu(props: {
  label: string
  icon: ReactNode
  value: string
  width?: number
  children(close: () => void): ReactNode
}) {
  const [open, setOpen] = useState(false)
  // A menu that would run past the window's right edge opens leftward from the chip instead.
  const [alignRight, setAlignRight] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={props.label}
        onClick={() => {
          const left = box.current?.getBoundingClientRect().left ?? 0
          setAlignRight(left + (props.width ?? 300) > window.innerWidth - 16)
          setOpen(!open)
        }}
        className={cn(PILL, open && 'bg-fill text-fg')}
      >
        {props.icon}
        <span className="truncate">{props.value}</span>
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </button>
      <AnimatePresence>
        {open && (
          <Popover
            role="dialog"
            label={props.label}
            onClose={() => setOpen(false)}
            within={box}
            box={pop}
            up
            style={{ width: props.width ?? 300 }}
            className={cn(
              'material-menu absolute bottom-[calc(100%+8px)] z-40 rounded-lg border border-line p-1.5',
              alignRight ? 'right-0 origin-bottom-right' : 'left-0 origin-bottom-left',
            )}
          >
            <PickerHost.Provider value={pop}>{props.children(() => setOpen(false))}</PickerHost.Provider>
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}

/** One choice in a chip menu: an icon tile, a name, a line on what it does, and a check when chosen. */
function Option(props: {
  icon: ReactNode
  title: string
  hint: string
  selected: boolean
  /** No choice is made yet and this is the first, so Tab lands here. */
  tabStop?: boolean
  onSelect(): void
}) {
  return (
    <MenuItem
      checked={props.selected}
      tabStop={props.tabStop}
      onSelect={props.onSelect}
      title={props.title}
      detail={props.hint}
      multiline
      icon={
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-base border transition-colors',
            props.selected
              ? 'border-transparent bg-accent text-on-accent'
              : 'border-line bg-fill/60 text-fg-2',
          )}
        >
          {props.icon}
        </span>
      }
    />
  )
}

/** A heading for a chip menu: small caps on the left, the current setting on the right. */
function MenuHead(props: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between px-2 pb-1 pt-1.5">
      <span className="section-label text-muted">{props.title}</span>
      {props.note && <span className="text-caption text-muted">{props.note}</span>}
    </div>
  )
}

const TICKS = 49

/** A tick ruler, like an instrument scale: ticks light up to the thinking effort. */
function EffortRuler(props: { level: number }) {
  return (
    <svg viewBox={`0 0 ${TICKS * 6} 22`} className="mx-2 mb-1.5 h-[22px] w-[calc(100%-1rem)]" aria-hidden>
      {Array.from({ length: TICKS }, (_, i) => {
        const major = i % 8 === 0
        const lit = i / (TICKS - 1) <= props.level
        return (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional
            key={i}
            x1={i * 6 + 3}
            x2={i * 6 + 3}
            y1={major ? 2 : 8}
            y2={20}
            strokeWidth={major ? 1.4 : 1}
            stroke="currentColor"
            className={cn('transition-colors duration-200', lit ? 'text-accent' : 'text-fg/20')}
          />
        )
      })}
    </svg>
  )
}

const EFFORT = [
  {
    key: 'auto',
    title: copy.teamControls.effort.auto.title,
    hint: copy.teamControls.effort.auto.hint,
    icon: Sparkles,
    level: 0.5,
  },
  {
    key: 'low',
    title: copy.teamControls.effort.low.title,
    hint: copy.teamControls.effort.low.hint,
    icon: FEATURE_ICONS.lightThinking,
    level: 0.2,
  },
  {
    key: 'medium',
    title: copy.teamControls.effort.medium.title,
    hint: copy.teamControls.effort.medium.hint,
    icon: Gauge,
    level: 0.6,
  },
  {
    key: 'high',
    title: copy.teamControls.effort.high.title,
    hint: copy.teamControls.effort.high.hint,
    icon: FEATURE_ICONS.thinking,
    level: 1,
  },
] as const

/** How hard the lead thinks per step. */
export function ThinkingChip(props: { config: TeamConfig; onConfig(c: TeamConfig): void }) {
  const current = EFFORT.find((e) => e.key === (props.config.thinking ?? 'auto')) ?? EFFORT[0]
  return (
    <ChipMenu
      label={copy.teamControls.thinking.label}
      icon={<current.icon className="size-3.5 shrink-0" />}
      value={current.key === 'auto' ? copy.teamControls.thinking.label : current.title}
    >
      {(close) => (
        <>
          <MenuHead title={copy.teamControls.thinking.label} note={current.title} />
          <EffortRuler level={current.level} />
          <MenuList label={copy.teamControls.thinking.label}>
            {EFFORT.map((e) => (
              <Option
                key={e.key}
                icon={<e.icon className="size-4" />}
                title={e.title}
                hint={e.hint}
                selected={e.key === current.key}
                onSelect={() => {
                  const { thinking: _, ...rest } = props.config
                  props.onConfig(e.key === 'auto' ? rest : { ...rest, thinking: e.key })
                  close()
                }}
              />
            ))}
          </MenuList>
        </>
      )}
    </ChipMenu>
  )
}

const REVIEW = [
  {
    key: 'off',
    title: copy.teamControls.review.off.title,
    hint: copy.teamControls.review.off.hint,
    icon: FEATURE_ICONS.reviewOff,
  },
  {
    key: 'auto',
    title: copy.teamControls.review.auto.title,
    hint: copy.teamControls.review.auto.hint,
    icon: FEATURE_ICONS.reviewAuto,
  },
  {
    key: 'always',
    title: copy.teamControls.review.always.title,
    hint: copy.teamControls.review.always.hint,
    icon: FEATURE_ICONS.verdict,
  },
] as const

/** When an independent reviewer checks the lead's work, and which model it is. */
export function ReviewChip(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
  review?: ReviewMode
  onReview(mode: ReviewMode): void
}) {
  const current = REVIEW.find((r) => r.key === props.review)
  const Icon = current?.icon ?? FEATURE_ICONS.verdict
  return (
    <ChipMenu
      label={copy.teamControls.reviewer.label}
      icon={<Icon className="size-3.5 shrink-0" />}
      value={
        props.review === 'off'
          ? copy.teamControls.reviewer.valueOff
          : props.review === 'always'
            ? copy.teamControls.reviewer.valueAlways
            : copy.teamControls.reviewer.valueAuto
      }
    >
      {() => (
        <>
          <MenuHead title={copy.teamControls.reviewer.label} />
          <MenuList label={copy.teamControls.reviewer.label}>
            {REVIEW.map((r, i) => (
              <Option
                key={r.key}
                tabStop={i === 0 && !current}
                icon={<r.icon className="size-4" />}
                title={r.title}
                hint={r.hint}
                selected={r.key === props.review}
                onSelect={() => props.onReview(r.key)}
              />
            ))}
          </MenuList>
          {props.review !== 'off' && (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-line px-2 pb-1 pt-2.5">
              <span className="whitespace-nowrap text-callout text-fg-2">
                {copy.teamControls.reviewer.model}
              </span>
              <ModelPicker
                variant="compact"
                placement="up"
                label={copy.teamControls.reviewer.label}
                value={props.config.judgeModel}
                models={props.models}
                onChange={(judgeModel) => props.onConfig({ ...props.config, judgeModel })}
              />
            </div>
          )}
        </>
      )}
    </ChipMenu>
  )
}

/**
 * Thinking, reviewer and helpers folded into one chip, for a toolbar too narrow for all three: it opens the team panel,
 * and its tooltip reads out the three settings.
 */
export function TeamChip(props: { config: TeamConfig; review?: ReviewMode; open: boolean; onClick(): void }) {
  const thinking = EFFORT.find((e) => e.key === (props.config.thinking ?? 'auto')) ?? EFFORT[0]
  const reviewer =
    props.review === 'off'
      ? copy.teamControls.reviewer.valueOff
      : props.review === 'always'
        ? copy.teamControls.reviewer.valueAlways
        : copy.teamControls.reviewer.valueAuto
  const summary = copy.teamControls.team.summary(thinking.title, reviewer, helpersLabel(props.config))
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={props.open}
      title={summary}
      onClick={props.onClick}
      className={cn(PILL, 'shrink-0', props.open && 'bg-fill text-fg')}
    >
      <Users className="size-3.5 shrink-0" />
      {copy.teamControls.team.label}
      <ChevronDown className="size-3 shrink-0 text-muted" />
    </button>
  )
}

/** Whether the lead may bring in helpers for big jobs, and who they are. */
export function HelpersChip(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
}) {
  const { config } = props
  const mode = helperMode(config)
  const on = mode !== 'never'
  const choose = (next: HelperMode) => props.onConfig(withHelperMode(config, next, props.models))
  return (
    <ChipMenu
      label={copy.teamControls.helpers.label}
      icon={<Users className="size-3.5 shrink-0" />}
      value={helpersLabel(config)}
      width={380}
    >
      {() => (
        <>
          <MenuHead title={copy.teamControls.helpers.label} />
          <MenuList label={copy.teamControls.helpers.label}>
            {HELPER_MODES.map((h) => (
              <Option
                key={h.key}
                icon={<h.icon className="size-4" />}
                title={h.title}
                hint={h.hint}
                selected={h.key === mode}
                onSelect={() => choose(h.key)}
              />
            ))}
          </MenuList>
          {on && (
            <div className="mt-1.5 rounded-base border border-line bg-surface/60">
              <HelpersEditor models={props.models} config={config} onConfig={props.onConfig} placement="up" />
            </div>
          )}
        </>
      )}
    </ChipMenu>
  )
}

const HELPER_MODES = [
  {
    key: 'never',
    title: copy.teamControls.helperModes.never.title,
    hint: copy.teamControls.helperModes.never.hint,
    icon: User,
  },
  {
    key: 'auto',
    title: copy.teamControls.helperModes.auto.title,
    hint: copy.teamControls.helperModes.auto.hint,
    icon: Users,
  },
  {
    key: 'always',
    title: copy.teamControls.helperModes.always.title,
    hint: copy.teamControls.helperModes.always.hint,
    icon: UsersRound,
  },
] as const

function Stepper(props: {
  value: number
  min: number
  max: number
  onChange(n: number): void
  label: string
}) {
  const step =
    'grid h-full w-6 place-items-center text-fg-2 transition-colors hover:bg-fill disabled:opacity-30'
  return (
    <div className="inline-flex h-7 items-center overflow-hidden rounded-md border border-line-strong/70 bg-control shadow-control">
      <button
        type="button"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
        aria-label={copy.teamControls.stepper.fewer(props.label)}
        className={step}
      >
        <Minus className="size-3" />
      </button>
      <output className="w-6 text-center text-body tabular-nums" aria-live="polite">
        {props.value}
      </output>
      <button
        type="button"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
        aria-label={copy.teamControls.stepper.more(props.label)}
        className={step}
      >
        <Plus className="size-3" />
      </button>
    </div>
  )
}

/** One settings row: a label (and a quiet hint) on the left, its control on the right. */
export function Row(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5">
      <div className="min-w-0">
        <div className="text-body">{props.label}</div>
        {props.hint && <div className="text-footnote leading-snug text-muted">{props.hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{props.children}</div>
    </div>
  )
}

/** The helpers the lead may call in: their style, each helper's role and model, and how many more it may add. */
export function HelpersEditor(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
  placement?: 'up' | 'down'
}) {
  const { config } = props
  const set = (patch: Partial<TeamConfig>) => props.onConfig({ ...config, ...patch })
  const swarm = config.mode === 'swarm'
  const setRow = (i: number, patch: Partial<RosterEntry>) =>
    set({ roster: config.roster.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const saved = useSpecialists()
  const addRow = (role: string) => {
    if (config.roster.length >= 8) return
    const model = config.roster.at(-1)?.model ?? config.leadModel
    // `@name` picks one of the person's saved specialists: its role and model come with it.
    const specialist = role.startsWith('@') ? saved.find((s) => s.name === role.slice(1)) : undefined
    set({
      roster: [
        ...config.roster,
        specialist
          ? { role: specialist.specialty, model: specialist.model ?? model, specialist: specialist.name }
          : { role, model },
      ],
    })
  }
  // Rows have no identity of their own; keep stable keys so removing one animates the right row.
  const ids = useRef<number[]>([])
  const nextId = useRef(0)
  while (ids.current.length < config.roster.length) ids.current.push(nextId.current++)
  ids.current.length = config.roster.length
  const removeRow = (i: number) => {
    ids.current.splice(i, 1)
    set({ roster: config.roster.filter((_, j) => j !== i) })
  }
  const switchMode = (mode: TeamConfig['mode']) => {
    if (mode === config.mode) return
    // Keep the models; the roles only make sense for specialists.
    const models = config.roster.map((r) => r.model)
    while (mode === 'swarm' && models.length < 2) models.push(config.leadModel)
    const roster = models.map((model, i) => ({
      role: mode === 'swarm' ? 'peer' : (SPECIALISTS[i % SPECIALISTS.length] as string),
      model,
    }))
    set({ mode, roster })
  }
  const unused = SPECIALISTS.filter((r) => !config.roster.some((x) => x.role === r))
  return (
    <div className="divide-y divide-line">
      <Row label={copy.teamControls.editor.style}>
        <Segmented
          id="composer-mode"
          value={config.mode}
          options={[
            { value: 'orchestrated', label: copy.teamControls.editor.orchestrated },
            { value: 'swarm', label: copy.teamControls.editor.swarm },
          ]}
          onChange={switchMode}
        />
      </Row>
      <AnimatePresence initial={false}>
        {config.roster.map((r, i) => (
          <motion.div
            key={ids.current[i]}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, height: 0 }}
            className="group flex min-h-11 items-center gap-2 px-3 py-1.5"
          >
            {r.specialist ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-body">
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: agentColor(r.specialist) }}
                />
                <span className="truncate">
                  {copy.teamControls.editor.specialistOf(r.specialist, r.role)}
                </span>
              </span>
            ) : swarm ? (
              <span className="flex-1 text-body text-fg-2">{copy.teamControls.editor.peer(i + 1)}</span>
            ) : (
              <input
                value={r.role}
                maxLength={40}
                aria-label={copy.teamControls.editor.roleOf(i + 1)}
                onChange={(e) => setRow(i, { role: e.target.value.toLowerCase() })}
                className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-body capitalize outline-none hover:bg-fill focus:bg-fill"
              />
            )}
            <ModelPicker
              variant="compact"
              placement={props.placement}
              label={swarm ? copy.teamControls.editor.peer(i + 1) : r.role || copy.teamControls.editor.helper}
              value={r.model}
              models={props.models}
              minWindow={AGENT_MIN_WINDOW}
              minReason={copy.teamControls.editor.minReason(windowLabel(AGENT_MIN_WINDOW))}
              onChange={(model) => setRow(i, { model })}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={swarm && config.roster.length <= 2}
              aria-label={copy.teamControls.editor.remove(
                swarm ? copy.teamControls.editor.peerLower(i + 1) : r.role,
              )}
              className="grid size-6 place-items-center rounded-md text-muted opacity-0 transition-opacity hover:bg-fill hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden"
            >
              <X className="size-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      {config.roster.length < 8 && (
        <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
          {swarm ? (
            <Button
              size="sm"
              variant="borderless"
              icon={<Plus className="size-3" />}
              onClick={() => addRow('peer')}
            >
              {copy.teamControls.editor.addPeer}
            </Button>
          ) : (
            <Select
              value=""
              aria-label={copy.teamControls.editor.addHelperLabel}
              onChange={(e) => e.target.value && addRow(e.target.value)}
              className="h-[26px]"
            >
              <option value="">{copy.teamControls.editor.addHelper}</option>
              {unused.map((role) => (
                <option key={role} value={role}>
                  {role[0]?.toUpperCase()}
                  {role.slice(1)}
                </option>
              ))}
              <option value="specialist">{copy.teamControls.editor.custom}</option>
              {saved.some((s) => !config.roster.some((r) => r.specialist === s.name)) && (
                <optgroup label={copy.teamControls.editor.yourSpecialists}>
                  {saved
                    .filter((s) => !config.roster.some((r) => r.specialist === s.name))
                    .map((s) => (
                      <option key={s.id} value={`@${s.name}`}>
                        {copy.teamControls.editor.specialistOf(s.name, s.specialty)}
                      </option>
                    ))}
                </optgroup>
              )}
            </Select>
          )}
        </div>
      )}
      {!swarm && (
        <Row
          label={copy.teamControls.editor.moreOnDemand.label}
          hint={copy.teamControls.editor.moreOnDemand.hint}
        >
          <Stepper
            value={config.extraWorkers}
            min={0}
            max={Math.max(0, 8 - config.roster.length)}
            onChange={(extraWorkers) => set({ extraWorkers })}
            label={copy.teamControls.editor.moreOnDemand.stepper}
          />
        </Row>
      )}
    </div>
  )
}
