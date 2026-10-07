import {
  Brain,
  Check,
  ChevronDown,
  Gauge,
  Minus,
  Plus,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Sparkles,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type ModelOption, type ReviewMode, type RosterEntry, SPECIALISTS, type TeamConfig } from '../api.ts'
import { Button, cn, Segmented, Select, Switch, spring } from '../ui/primitives.tsx'
import { ModelPicker } from './ModelPicker.tsx'

const PILL =
  'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-line bg-fill/40 px-2.5 text-[12.5px] font-medium text-fg-2 shadow-[inset_0_0.5px_0_rgb(255_255_255/0.07)] transition-colors hover:bg-fill hover:text-fg'

/** A glass pill in the composer toolbar that opens its own menu above it. */
function ChipMenu(props: {
  label: string
  icon: ReactNode
  value: ReactNode
  width?: number
  children(close: () => void): ReactNode
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="relative min-w-0" ref={box}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        title={props.label}
        onClick={() => setOpen(!open)}
        className={cn(PILL, open && 'bg-fill text-fg')}
      >
        {props.icon}
        <span className="truncate">{props.value}</span>
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.1 } }}
            transition={spring}
            style={{ width: props.width ?? 300 }}
            className="material-menu absolute bottom-[calc(100%+8px)] left-0 z-40 origin-bottom-left rounded-[14px] border border-line p-1.5"
          >
            {props.children(() => setOpen(false))}
          </motion.div>
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
  onSelect(): void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      onClick={props.onSelect}
      className="flex w-full items-center gap-3 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-fill"
    >
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-[8px] border transition-colors',
          props.selected ? 'border-transparent bg-accent text-on-accent' : 'border-line bg-fill/60 text-fg-2',
        )}
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-fg">{props.title}</span>
        <span className="block text-[11.5px] leading-snug text-muted">{props.hint}</span>
      </span>
      {props.selected && <Check className="size-4 shrink-0 text-accent-fg" />}
    </button>
  )
}

/** A heading for a chip menu: small caps on the left, the current setting on the right. */
function MenuHead(props: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between px-2 pb-1 pt-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">{props.title}</span>
      {props.note && <span className="text-[11px] text-muted">{props.note}</span>}
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
    title: 'Auto',
    hint: 'Quick for questions, deeper for real work',
    icon: Sparkles,
    level: 0.5,
  },
  { key: 'low', title: 'Fast', hint: 'Answers right away', icon: Zap, level: 0.2 },
  { key: 'medium', title: 'Balanced', hint: 'Thinks before it acts', icon: Gauge, level: 0.6 },
  { key: 'high', title: 'Deep', hint: 'Thinks hard at every step; slower', icon: Brain, level: 1 },
] as const

/** How hard the lead thinks per step. */
export function ThinkingChip(props: { config: TeamConfig; onConfig(c: TeamConfig): void }) {
  const current = EFFORT.find((e) => e.key === (props.config.thinking ?? 'auto')) ?? EFFORT[0]
  return (
    <ChipMenu
      label="Thinking"
      icon={<current.icon className="size-3.5 shrink-0" />}
      value={current.key === 'auto' ? 'Thinking' : current.title}
    >
      {(close) => (
        <>
          <MenuHead title="Thinking" note={current.title} />
          <EffortRuler level={current.level} />
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
        </>
      )}
    </ChipMenu>
  )
}

const REVIEW = [
  { key: 'off', title: 'Off', hint: 'The lead’s answer completes the task', icon: ShieldOff },
  {
    key: 'auto',
    title: 'Auto',
    hint: 'The lead asks for a check when the work deserves it',
    icon: ShieldQuestion,
  },
  {
    key: 'always',
    title: 'Always',
    hint: 'Every final answer is checked before it is done',
    icon: ShieldCheck,
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
  const Icon = current?.icon ?? ShieldCheck
  return (
    <ChipMenu
      label="Reviewer"
      icon={<Icon className="size-3.5 shrink-0" />}
      value={props.review === 'off' ? 'No review' : props.review === 'always' ? 'Always review' : 'Review'}
    >
      {() => (
        <>
          <MenuHead title="Reviewer" />
          {REVIEW.map((r) => (
            <Option
              key={r.key}
              icon={<r.icon className="size-4" />}
              title={r.title}
              hint={r.hint}
              selected={r.key === props.review}
              onSelect={() => props.onReview(r.key)}
            />
          ))}
          {props.review !== 'off' && (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-line px-2 pb-1 pt-2.5">
              <span className="whitespace-nowrap text-[12.5px] text-fg-2">Reviewer model</span>
              <ModelPicker
                variant="compact"
                placement="up"
                label="Reviewer"
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

/** Whether the lead may bring in helpers for big jobs, and who they are. */
export function HelpersChip(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
}) {
  const { config } = props
  const n = config.roster.length
  const on = n > 0 || config.extraWorkers > 0
  // Turning helpers off keeps the list, so turning them back on restores it.
  const saved = useRef<Pick<TeamConfig, 'roster' | 'extraWorkers' | 'mode'>>(undefined)
  const toggle = (next: boolean) => {
    if (!next) {
      saved.current = { roster: config.roster, extraWorkers: config.extraWorkers, mode: config.mode }
      return props.onConfig({ ...config, mode: 'orchestrated', roster: [], extraWorkers: 0 })
    }
    props.onConfig({
      ...config,
      ...(saved.current ?? {
        mode: 'orchestrated',
        roster: [
          { role: 'researcher', model: config.leadModel },
          { role: 'coder', model: config.leadModel },
        ],
        extraWorkers: 2,
      }),
    })
  }
  return (
    <ChipMenu
      label="Helpers"
      icon={<Users className="size-3.5 shrink-0" />}
      value={on ? `${n || config.extraWorkers} ${config.mode === 'swarm' ? 'peers' : 'helpers'}` : 'Solo'}
      width={380}
    >
      {() => (
        <>
          <div className="flex items-start gap-3 px-2 pb-2 pt-1.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">Bring in helpers</span>
              <span className="block text-[11.5px] leading-snug text-muted">
                The lead answers itself and calls them only for big jobs
              </span>
            </span>
            <Switch checked={on} onChange={toggle} label="Bring in helpers" />
          </div>
          {on && (
            <div className="overflow-hidden rounded-[10px] border border-line bg-surface/60">
              <HelpersEditor models={props.models} config={config} onConfig={props.onConfig} placement="up" />
            </div>
          )}
        </>
      )}
    </ChipMenu>
  )
}

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
    <div className="inline-flex h-7 items-center overflow-hidden rounded-md border border-line-strong/70 bg-control shadow-[0_0.5px_1px_rgb(0_0_0/0.08)]">
      <button
        type="button"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
        aria-label={`Fewer ${props.label}`}
        className={step}
      >
        <Minus className="size-3" />
      </button>
      <output className="w-6 text-center text-[13px] tabular-nums" aria-live="polite">
        {props.value}
      </output>
      <button
        type="button"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
        aria-label={`More ${props.label}`}
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
        <div className="text-[13px]">{props.label}</div>
        {props.hint && <div className="text-[11.5px] leading-snug text-muted">{props.hint}</div>}
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
  const addRow = (role: string) =>
    config.roster.length < 8 &&
    set({ roster: [...config.roster, { role, model: config.roster.at(-1)?.model ?? config.leadModel }] })
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
      <Row label="Style">
        <Segmented
          id="composer-mode"
          value={config.mode}
          options={[
            { value: 'orchestrated', label: 'Lead + helpers' },
            { value: 'swarm', label: 'Equal peers' },
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
            {swarm ? (
              <span className="flex-1 text-[13px] text-fg-2">Peer {i + 1}</span>
            ) : (
              <input
                value={r.role}
                maxLength={40}
                aria-label={`Role of helper ${i + 1}`}
                onChange={(e) => setRow(i, { role: e.target.value.toLowerCase() })}
                className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[13px] capitalize outline-none hover:bg-fill focus:bg-fill"
              />
            )}
            <ModelPicker
              variant="compact"
              placement={props.placement}
              label={swarm ? `Peer ${i + 1}` : r.role || 'Helper'}
              value={r.model}
              models={props.models}
              onChange={(model) => setRow(i, { model })}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={swarm && config.roster.length <= 2}
              aria-label={`Remove ${swarm ? `peer ${i + 1}` : r.role}`}
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
              Add peer
            </Button>
          ) : (
            <Select
              value=""
              aria-label="Add a helper"
              onChange={(e) => e.target.value && addRow(e.target.value)}
              className="h-[26px] text-[12.5px]"
            >
              <option value="">Add helper…</option>
              {unused.map((role) => (
                <option key={role} value={role}>
                  {role[0]?.toUpperCase()}
                  {role.slice(1)}
                </option>
              ))}
              <option value="specialist">Custom</option>
            </Select>
          )}
        </div>
      )}
      {!swarm && (
        <Row label="More on demand" hint="Extra helpers the lead may add when the job needs them">
          <Stepper
            value={config.extraWorkers}
            min={0}
            max={Math.max(0, 8 - config.roster.length)}
            onChange={(extraWorkers) => set({ extraWorkers })}
            label="extra helpers"
          />
        </Row>
      )}
    </div>
  )
}
