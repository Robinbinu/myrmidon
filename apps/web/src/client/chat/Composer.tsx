import { ArrowUp, Bot, Crown, Gavel, Minus, Plus, Square, User, Users, Zap } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ModelOption, TeamConfig } from '../api.ts'
import { cn, Kbd, Segmented, spring } from '../ui/primitives.tsx'
import { ModelPicker } from './ModelPicker.tsx'

export const PRESETS: {
  id: string
  name: string
  hint: string
  icon: typeof User
  config: Pick<TeamConfig, 'mode' | 'workers'>
}[] = [
  {
    id: 'solo',
    name: 'Solo',
    hint: 'One agent does everything',
    icon: User,
    config: { mode: 'auto', workers: 0 },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    hint: 'Lead adds up to 3 helpers',
    icon: Users,
    config: { mode: 'auto', workers: 3 },
  },
  {
    id: 'swarm',
    name: 'Swarm',
    hint: 'Lead + 5 workers at once',
    icon: Zap,
    config: { mode: 'manual', workers: 5 },
  },
]

export function TeamSettings(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
  placement?: 'up' | 'down'
}) {
  const { config } = props
  const set = (patch: Partial<TeamConfig>) => props.onConfig({ ...config, ...patch })
  const preset = PRESETS.find((p) => p.config.mode === config.mode && p.config.workers === config.workers)?.id
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => set(p.config)}
            aria-pressed={preset === p.id}
            className={cn(
              'group relative flex flex-col gap-1 rounded-xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card',
              preset === p.id
                ? 'border-accent bg-accent-soft'
                : 'border-line bg-surface hover:border-line-strong',
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <span
                className={cn(
                  'grid size-6 place-items-center rounded-md transition-colors',
                  preset === p.id ? 'bg-accent text-on-accent' : 'bg-surface-2 text-fg-2',
                )}
              >
                <p.icon className="size-3.5" />
              </span>
              {p.name}
            </span>
            <span className="text-[11.5px] text-muted">{p.hint}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          id="team-mode"
          value={config.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'auto', label: 'Auto team' },
            { value: 'manual', label: 'Fixed team' },
          ]}
        />
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-muted">
            {config.mode === 'auto' ? 'Up to' : 'Workers'}
          </span>
          <div className="flex items-center rounded-xl border border-line p-0.5">
            <button
              type="button"
              disabled={config.workers <= 0}
              onClick={() => set({ workers: config.workers - 1 })}
              aria-label="Fewer workers"
              className="grid size-7 place-items-center rounded-lg transition-colors hover:bg-surface-2 disabled:opacity-30"
            >
              <Minus className="size-3.5" />
            </button>
            <motion.output
              key={config.workers}
              initial={{ y: -6, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={spring}
              className="w-7 text-center text-[13px] font-semibold tabular-nums"
              aria-live="polite"
            >
              {config.workers}
            </motion.output>
            <button
              type="button"
              disabled={config.workers >= 8}
              onClick={() => set({ workers: config.workers + 1 })}
              aria-label="More workers"
              className="grid size-7 place-items-center rounded-lg transition-colors hover:bg-surface-2 disabled:opacity-30"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
      <p className="-mt-2 text-[12.5px] text-muted">
        {config.mode === 'auto'
          ? 'The lead plans the work and brings in workers only when they clearly help.'
          : 'All workers start immediately and the lead splits the work between them.'}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <ModelPicker
          placement={props.placement}
          label="Lead"
          icon={<Crown className="size-3" />}
          value={config.leadModel}
          models={props.models}
          onChange={(leadModel) => set({ leadModel })}
        />
        <ModelPicker
          placement={props.placement}
          label="Workers"
          icon={<Bot className="size-3" />}
          value={config.workerModel}
          models={props.models}
          onChange={(workerModel) => set({ workerModel })}
        />
        <ModelPicker
          placement={props.placement}
          label="Judge"
          icon={<Gavel className="size-3" />}
          value={config.judgeModel}
          models={props.models}
          onChange={(judgeModel) => set({ judgeModel })}
        />
      </div>
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
  centered?: boolean
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

  const preset = PRESETS.find((p) => p.config.mode === config.mode && p.config.workers === config.workers)
  const teamLabel = preset
    ? preset.name
    : config.mode === 'auto'
      ? `Auto · up to ${config.workers}`
      : `${config.workers + 1} agents`
  const TeamIcon = preset?.icon ?? Users
  const lead = props.models.find((m) => m.ref === config.leadModel)
  const canSend = text.trim().length > 0 && !props.busy

  return (
    <div className={cn('shrink-0 px-4 pb-4 pt-2 sm:px-6', props.centered && 'pb-0')}>
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
          className="rounded-[22px] border border-line-strong bg-surface shadow-card transition-[box-shadow,border-color] duration-200 focus-within:border-accent/60 focus-within:shadow-[var(--shadow-md),0_0_0_4px_var(--accent-soft)]"
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
              <TeamIcon className="size-3.5" /> {teamLabel}
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
                    canSend
                      ? 'brand-gradient text-white shadow-card hover:brightness-110'
                      : 'bg-surface-3 text-muted',
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
        <div className="mt-2 hidden flex-wrap justify-center gap-x-4 gap-y-1 text-[11.5px] text-muted sm:flex">
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line · <Kbd>/</Kbd> focus
          </span>
          <span>
            {props.running
              ? 'Messages go straight to the lead while it works'
              : 'Every result is checked by an independent judge'}
          </span>
        </div>
      </div>
    </div>
  )
})
