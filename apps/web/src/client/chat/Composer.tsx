import { ArrowUp, Crown, Gavel, Minus, Plus, Square, Users, Workflow, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { type ModelOption, type RosterEntry, SPECIALISTS, type TeamConfig } from '../api.ts'
import { cn, spring } from '../ui/primitives.tsx'
import { ModelPicker } from './ModelPicker.tsx'

export const MODES = [
  {
    id: 'orchestrated',
    name: 'Orchestrated',
    hint: 'A lead assigns tasks to specialists, each on the model that fits',
    icon: Workflow,
  },
  {
    id: 'swarm',
    name: 'Swarm',
    hint: 'Equal peers share one plan, notes, and tasks; no boss',
    icon: Users,
  },
] as const

export function teamLabel(config: TeamConfig): string {
  const n = config.roster.length
  return config.mode === 'swarm'
    ? `Swarm · ${n} peer${n === 1 ? '' : 's'}`
    : `Orchestrated · ${n} specialist${n === 1 ? '' : 's'}`
}

function Stepper(props: {
  value: number
  min: number
  max: number
  onChange(n: number): void
  label: string
}) {
  return (
    <div className="flex items-center rounded-xl border border-line p-0.5">
      <button
        type="button"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
        aria-label={`Fewer ${props.label}`}
        className="grid size-7 place-items-center rounded-lg transition-colors hover:bg-surface-2 disabled:opacity-30"
      >
        <Minus className="size-3.5" />
      </button>
      <motion.output
        key={props.value}
        initial={{ y: -6, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={spring}
        className="w-7 text-center text-[13px] font-semibold tabular-nums"
        aria-live="polite"
      >
        {props.value}
      </motion.output>
      <button
        type="button"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
        aria-label={`More ${props.label}`}
        className="grid size-7 place-items-center rounded-lg transition-colors hover:bg-surface-2 disabled:opacity-30"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

/** Team mode, roster, and models: the per-message team picker and the default in Settings. */
export function TeamSettings(props: {
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
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => switchMode(m.id)}
            aria-pressed={config.mode === m.id}
            className={cn(
              'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-150',
              config.mode === m.id
                ? 'border-fg bg-surface-2'
                : 'border-line bg-surface hover:border-line-strong',
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <m.icon className="size-4" />
              {m.name}
            </span>
            <span className="text-[11.5px] leading-snug text-muted">{m.hint}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {!swarm && (
          <ModelPicker
            placement={props.placement}
            label="Lead"
            icon={<Crown className="size-3" />}
            value={config.leadModel}
            models={props.models}
            onChange={(leadModel) => set({ leadModel })}
          />
        )}
        <ModelPicker
          placement={props.placement}
          label="Judge"
          icon={<Gavel className="size-3" />}
          value={config.judgeModel}
          models={props.models}
          onChange={(judgeModel) => set({ judgeModel })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
            {swarm ? 'Peers' : 'Specialists'}
          </span>
          <span className="text-[11.5px] text-muted">{config.roster.length} / 8</span>
        </div>
        <AnimatePresence initial={false}>
          {config.roster.map((r, i) => (
            <motion.div
              key={ids.current[i]}
              layout
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-end gap-2"
            >
              {swarm ? (
                <span className="flex h-9 items-center rounded-lg border border-line px-3 text-[12.5px] text-muted">
                  Peer {i + 1}
                </span>
              ) : (
                <input
                  value={r.role}
                  maxLength={40}
                  aria-label={`Role of specialist ${i + 1}`}
                  onChange={(e) => setRow(i, { role: e.target.value.toLowerCase() })}
                  className="h-9 rounded-lg border border-line bg-surface px-3 text-[13px] outline-none transition-colors focus:border-line-strong"
                />
              )}
              <ModelPicker
                placement={props.placement}
                label={swarm ? `Peer ${i + 1} model` : `${r.role || 'specialist'} model`}
                value={r.model}
                models={props.models}
                onChange={(model) => setRow(i, { model })}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={swarm && config.roster.length <= 2}
                aria-label={`Remove ${swarm ? `peer ${i + 1}` : r.role}`}
                className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30"
              >
                <X className="size-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        {config.roster.length < 8 && (
          <div className="flex flex-wrap gap-1.5">
            {swarm ? (
              <button
                type="button"
                onClick={() => addRow('peer')}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12px] text-fg-2 hover:text-fg"
              >
                <Plus className="size-3" /> Peer
              </button>
            ) : (
              <>
                {unused.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => addRow(role)}
                    className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12px] text-fg-2 hover:text-fg"
                  >
                    <Plus className="size-3" /> {role}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => addRow('specialist')}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12px] text-fg-2 hover:text-fg"
                >
                  <Plus className="size-3" /> custom
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {!swarm && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-muted">
            The lead may add more specialists when it needs them
          </span>
          <Stepper
            value={config.extraWorkers}
            min={0}
            max={Math.max(0, 8 - config.roster.length)}
            onChange={(extraWorkers) => set({ extraWorkers })}
            label="extra specialists"
          />
        </div>
      )}
      <p className="text-[12px] leading-snug text-muted">
        Simple questions skip the team and get a direct answer; single deliverables get one agent. The team is
        used for work that needs it.
      </p>
    </div>
  )
}

export interface ComposerHandle {
  focus(): void
  fill(text: string): void
}

interface ComposerProps {
  models: ModelOption[]
  config: TeamConfig
  onConfig(config: TeamConfig): void
  running: boolean
  busy: boolean
  status?: string
  placeholder: string
  onSend(text: string): Promise<void>
  onStop(): void
  /** Inline under the empty-state hero rather than docked at the bottom. */
  centered?: boolean
  onTextChange?(text: string): void
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const [text, setText] = useState('')
  const [showTeam, setShowTeam] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const { config } = props

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    fill: (t: string) => {
      setText(t)
      requestAnimationFrame(() => area.current?.focus())
    },
  }))

  const onTextChange = useRef(props.onTextChange)
  onTextChange.current = props.onTextChange
  useEffect(() => onTextChange.current?.(text), [text])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the textarea whenever its text changes
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`
  }, [text])

  useEffect(() => {
    if (!showTeam) return
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setShowTeam(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setShowTeam(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [showTeam])

  const send = async () => {
    const value = text.trim()
    if (!value || props.busy) return
    setText('')
    setShowTeam(false)
    try {
      await props.onSend(value)
    } catch {
      setText(value)
    }
  }

  const TeamIcon = config.mode === 'swarm' ? Users : Workflow
  const lead = props.models.find((m) => m.ref === config.leadModel)
  const canSend = text.trim().length > 0 && !props.busy

  return (
    <div className={cn('shrink-0', props.centered ? 'w-full' : 'px-4 pb-4 pt-2 sm:px-6')}>
      <div className="relative mx-auto max-w-[820px]" ref={wrap}>
        <AnimatePresence>
          {showTeam && (
            <motion.div
              role="dialog"
              aria-label="Team and models"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }}
              transition={spring}
              className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-full origin-bottom rounded-2xl border border-line bg-surface p-4 shadow-pop"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold">Team &amp; models</h3>
                <span className="text-[11.5px] text-muted">Saved for your next tasks</span>
              </div>
              <TeamSettings models={props.models} config={config} onConfig={props.onConfig} />
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          layout
          transition={spring}
          className="rounded-[26px] border border-line-strong bg-surface shadow-pop transition-[box-shadow,border-color] duration-200 focus-within:border-accent/50 focus-within:shadow-[var(--shadow-lg),0_0_0_4px_var(--accent-soft)]"
        >
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={props.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            aria-label="Message"
            className="block max-h-[300px] w-full resize-none bg-transparent px-5 pb-1.5 pt-4 text-[15px] leading-relaxed text-fg outline-none placeholder:text-muted"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-1.5">
            <button
              type="button"
              onClick={() => setShowTeam(!showTeam)}
              aria-expanded={showTeam}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-all duration-150',
                showTeam
                  ? 'border-accent/40 bg-accent-soft text-accent'
                  : 'border-line text-fg-2 hover:border-line-strong hover:bg-surface-2 hover:text-fg',
              )}
            >
              <TeamIcon className="size-3.5" /> {teamLabel(config)}
            </button>
            <button
              type="button"
              onClick={() => setShowTeam(true)}
              title={config.leadModel}
              className="inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] font-medium text-fg-2 transition-all duration-150 hover:border-line-strong hover:bg-surface-2 hover:text-fg"
            >
              <Crown className="size-3.5 shrink-0" />
              <span className="truncate">{lead?.name ?? (config.leadModel || 'Choose a model')}</span>
            </button>
            <span className="flex-1" />
            <AnimatePresence>
              {props.status && (
                <motion.span
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="hidden max-w-[300px] truncate text-[12.5px] text-muted sm:inline"
                >
                  {props.status}
                </motion.span>
              )}
            </AnimatePresence>
            <AnimatePresence mode="popLayout" initial={false}>
              {props.running && !text.trim() ? (
                <motion.button
                  key="stop"
                  type="button"
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={spring}
                  onClick={props.onStop}
                  aria-label="Stop the colony"
                  title="Stop"
                  className="grid size-9 place-items-center rounded-full bg-fg text-bg transition-transform active:scale-90"
                >
                  <Square className="size-3.5" fill="currentColor" />
                </motion.button>
              ) : (
                <motion.button
                  key="send"
                  type="button"
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={spring}
                  onClick={() => void send()}
                  disabled={!canSend}
                  aria-label="Send"
                  title="Send (Enter)"
                  className={cn(
                    'grid size-9 place-items-center rounded-full transition-all duration-150 active:scale-90',
                    canSend ? 'bg-ink text-on-ink shadow-card hover:opacity-90' : 'bg-surface-3 text-muted',
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </div>
  )
})
