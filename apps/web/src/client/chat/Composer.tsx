import {
  ArrowUp,
  Crown,
  FileText,
  Gavel,
  ListEnd,
  Minus,
  Navigation,
  Paperclip,
  Plus,
  Square,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { type ModelOption, providerOf, type RosterEntry, SPECIALISTS, type TeamConfig } from '../api.ts'
import { cn, spring } from '../ui/primitives.tsx'
import { buildMenu, CommandMenu, rememberCommand } from './CommandMenu.tsx'
import { parseSlash, type SlashCommand } from './commands.ts'
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
  const judging = providerOf(config.judgeModel)
  // Only worth saying when another provider is actually available to pick.
  const sameJudge =
    [swarm ? undefined : config.leadModel, ...config.roster.map((r) => r.model)].some(
      (m) => m && providerOf(m) === judging,
    ) && props.models.some((m) => !m.hidden && m.provider !== judging)
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
      {sameJudge && (
        <p className="-mt-2 text-[11.5px] leading-snug text-muted">
          The judge uses the same provider as the team. One from another provider catches more of its blind
          spots.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
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

/**
 * How a message reaches a running round: `steer` joins the agent's next step, `queue` waits until it has
 * finished what it is doing.
 */
export type Delivery = 'steer' | 'queue'

const MAX_FILES = 10

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Toolbar controls read as quiet text until hovered, so the message stays the focus. */
const CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:opacity-40'

const DELIVERIES = [
  { value: 'steer', label: 'Steer', icon: Navigation, hint: 'Read at the next step' },
  { value: 'queue', label: 'Queue', icon: ListEnd, hint: 'Read once the current work is done' },
] as const

interface ComposerProps {
  models: ModelOption[]
  config: TeamConfig
  onConfig(config: TeamConfig): void
  running: boolean
  busy: boolean
  status?: string
  placeholder: string
  /** `delivery` only matters while a round is running; `files` are attached to the message. */
  onSend(text: string, delivery: Delivery, files: readonly File[]): Promise<void>
  onStop(): void
  /** Inline under the empty-state hero rather than docked at the bottom. */
  centered?: boolean
  onTextChange?(text: string): void
  /** Runs a slash command other than the ones the composer handles itself (team, attach, help). */
  onCommand(name: string, arg: string): Promise<void>
  /** Shows and picks the project folder the chat works in. */
  project?: ReactNode
  /** Whether a chat is open, and whether its latest round stopped early; decides which commands apply. */
  chatState?: { chat: boolean; resumable: boolean }
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const [text, setText] = useState('')
  const [showTeam, setShowTeam] = useState(false)
  const [delivery, setDelivery] = useState<Delivery>('steer')
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const addFiles = (list: Iterable<File>) => {
    const added = [...list].filter((f) => f.size > 0)
    if (added.length === 0) return
    setFiles((prev) => [...prev, ...added].slice(0, MAX_FILES))
  }
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

  const [menuIndex, setMenuIndex] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight whenever the typed command changes
  useEffect(() => setMenuIndex(0), [text])

  const fillCommand = (t: string) => {
    setShowHelp(false)
    setText(t)
    requestAnimationFrame(() => area.current?.focus())
  }

  const runCommand = async (command: SlashCommand, arg: string) => {
    setShowHelp(false)
    if (command.needsArg && !arg) return fillCommand(`/${command.name} `)
    rememberCommand(command.name)
    setText('')
    if (command.name === 'team') return setShowTeam(true)
    if (command.name === 'attach') return picker.current?.click()
    if (command.name === 'help') return setShowHelp(true)
    try {
      await props.onCommand(command.name, arg)
    } catch {
      setText(`/${command.name}${arg ? ` ${arg}` : ''}`)
    }
  }

  const send = async (how: Delivery = delivery) => {
    const slash = parseSlash(text)
    if (slash && files.length === 0) return runCommand(slash.command, slash.arg)
    const value = text.trim() || (files.length > 0 ? 'See the attached files.' : '')
    if (!value || props.busy) return
    const sent = files
    setText('')
    setFiles([])
    setShowTeam(false)
    try {
      await props.onSend(value, how, sent)
    } catch {
      setText(text)
      setFiles(sent)
    }
  }

  const TeamIcon = config.mode === 'swarm' ? Users : Workflow
  const lead = props.models.find((m) => m.ref === config.leadModel)
  const menu = buildMenu({
    text,
    all: showHelp,
    ctx: { running: props.running, chat: !!props.chatState?.chat, resumable: !!props.chatState?.resumable },
    dynamicOptions: (c) =>
      c.name === 'model'
        ? props.models
            .filter((m) => !m.hidden)
            .map((m) => ({
              value: m.ref,
              label: m.name,
              description: `${m.provider}${m.reasoning ? ' · reasoning' : ''}`,
            }))
        : undefined,
    current: (c) =>
      c.name === 'model'
        ? config.mode === 'swarm'
          ? undefined
          : (lead?.name ?? config.leadModel)
        : c.name === 'mode'
          ? config.mode === 'swarm'
            ? 'Swarm'
            : 'Orchestrated'
          : c.name === 'thinking'
            ? (config.thinking ?? 'auto')
            : undefined,
    pickCommand: (c) => void runCommand(c, ''),
    completeCommand: (c) => fillCommand(`/${c.name}${c.needsArg ? ' ' : ''}`),
    pickOption: (c, value) => void runCommand(c, value),
    submit: () => void send(),
  })
  const canSend = (text.trim().length > 0 || files.length > 0) && !props.busy

  return (
    <div className={cn('shrink-0', props.centered ? 'w-full' : 'px-4 pb-4 pt-2 sm:px-6')}>
      <div className="relative mx-auto max-w-[820px]" ref={wrap}>
        <AnimatePresence>
          {menu && !showTeam && (
            <CommandMenu
              key={menu.command?.name ?? 'commands'}
              menu={menu}
              active={menuIndex}
              onHover={setMenuIndex}
            />
          )}
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
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (e.dataTransfer.files.length === 0) return
            e.preventDefault()
            setDragging(false)
            addFiles(e.dataTransfer.files)
          }}
          className={cn(
            'rounded-[26px] border border-line-strong bg-surface shadow-pop transition-[box-shadow,border-color] duration-200 focus-within:border-accent/50 focus-within:shadow-[var(--shadow-lg),0_0_0_4px_var(--accent-soft)]',
            dragging && 'border-accent/60 shadow-[var(--shadow-lg),0_0_0_4px_var(--accent-soft)]',
          )}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {files.map((f, i) => (
                <span
                  key={`${f.name}-${f.size}-${f.lastModified}`}
                  className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pl-2 pr-1 text-[12px]"
                >
                  <FileText className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-muted">{formatSize(f.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))}
                    className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={props.placeholder}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length === 0) return
              e.preventDefault()
              addFiles(e.clipboardData.files)
            }}
            onKeyDown={(e) => {
              if (menu) {
                const items = menu.items
                const pick = items[menuIndex] ?? items[0]
                if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length > 0) {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  setMenuIndex((i) => (i + step + items.length) % items.length)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowHelp(false)
                  if (!showHelp) setText('')
                  return
                }
                if (e.key === 'Tab' && pick?.complete) {
                  e.preventDefault()
                  pick.complete()
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && pick) {
                  e.preventDefault()
                  if (!pick.disabled) pick.run()
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                // Alt+Enter sends the other way, without changing the toggle.
                void send(e.altKey && props.running ? (delivery === 'steer' ? 'queue' : 'steer') : delivery)
              }
            }}
            aria-label="Message"
            className="block max-h-[300px] w-full resize-none bg-transparent px-5 pb-1.5 pt-4 text-[15px] leading-relaxed text-fg outline-none placeholder:text-muted"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="flex min-w-0 flex-1 items-center gap-0.5">
              <button
                type="button"
                onClick={() => picker.current?.click()}
                aria-label="Attach files"
                title="Attach files (or drop / paste them)"
                disabled={files.length >= MAX_FILES}
                className={cn(CHIP, 'w-8 shrink-0 justify-center px-0')}
              >
                <Paperclip className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowTeam(!showTeam)}
                aria-expanded={showTeam}
                title={`${teamLabel(config)}${config.mode === 'swarm' ? '' : ` · lead: ${config.leadModel}`}`}
                className={cn(
                  CHIP,
                  'min-w-0',
                  showTeam && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
                )}
              >
                <TeamIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {config.mode === 'swarm'
                    ? teamLabel(config)
                    : `${lead?.name ?? (config.leadModel || 'Choose a model')} · ${config.roster.length} specialist${config.roster.length === 1 ? '' : 's'}`}
                </span>
              </button>
              {props.project}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <AnimatePresence initial={false}>
                {props.running && (
                  <motion.button
                    key="delivery"
                    type="button"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={spring}
                    onClick={() => setDelivery(delivery === 'steer' ? 'queue' : 'steer')}
                    title={`${DELIVERIES.find((d) => d.value === delivery)?.hint}. Click to switch (Alt+Enter sends the other way).`}
                    aria-label={`Delivery: ${delivery}. Switch to ${delivery === 'steer' ? 'queue' : 'steer'}`}
                    className={CHIP}
                  >
                    {(() => {
                      const d = DELIVERIES.find((x) => x.value === delivery) ?? DELIVERIES[0]
                      return (
                        <>
                          <d.icon className="size-3.5" /> {d.label}
                        </>
                      )
                    })()}
                  </motion.button>
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
                    title={props.status ? `${props.status} Click to stop.` : 'Stop'}
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
          </div>
        </motion.div>
      </div>
    </div>
  )
})
