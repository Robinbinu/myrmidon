import {
  ArrowUp,
  ChevronRight,
  FileText,
  ListEnd,
  Navigation,
  Paperclip,
  Square,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  getReviewMode,
  type ModelOption,
  providerOf,
  type ReviewMode,
  setReviewMode,
  type TeamConfig,
} from '../api.ts'
import { usePersistentFlag } from '../ui/hooks.ts'
import { cn, Segmented, spring } from '../ui/primitives.tsx'
import { buildMenu, CommandMenu, rememberCommand } from './CommandMenu.tsx'
import { parseSlash, type SlashCommand } from './commands.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { HelpersChip, HelpersEditor, ReviewChip, Row, ThinkingChip } from './TeamControls.tsx'

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

const GROUP = 'divide-y divide-line overflow-visible rounded-[10px] border border-line bg-surface'

const THINKING = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const

const REVIEW = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
  { value: 'always', label: 'Always' },
] as const

/**
 * The lead, its reviewer and how hard it thinks, with the helpers it may call folded away below: the person talks to
 * the lead, which brings helpers in only for big jobs. Used in the composer and as the default in Settings.
 */
export function TeamSettings(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
  placement?: 'up' | 'down'
  /** The reviewer setting, when this panel may change it (it lives in the server's settings). */
  review?: ReviewMode
  onReview?(mode: ReviewMode): void
}) {
  const { config } = props
  const set = (patch: Partial<TeamConfig>) => props.onConfig({ ...config, ...patch })
  const swarm = config.mode === 'swarm'
  const [helpersOpen, setHelpersOpen] = usePersistentFlag('myr-helpers-open', false)
  const judging = providerOf(config.judgeModel)
  // Only worth saying when another provider is actually available to pick.
  const sameJudge =
    [swarm ? undefined : config.leadModel, ...config.roster.map((r) => r.model)].some(
      (m) => m && providerOf(m) === judging,
    ) && props.models.some((m) => !m.hidden && m.provider !== judging)
  const n = config.roster.length
  const summary = n === 0 ? 'None' : `${n} ${swarm ? 'peer' : 'helper'}${n === 1 ? '' : 's'}`
  const reviewOff = props.review === 'off'

  return (
    <div className="flex flex-col gap-3">
      <div className={GROUP}>
        {!swarm && (
          <Row label="Lead" hint="Who you talk to">
            <ModelPicker
              variant="compact"
              placement={props.placement}
              label="Lead"
              value={config.leadModel}
              models={props.models}
              onChange={(leadModel) => set({ leadModel })}
            />
          </Row>
        )}
        <Row
          label="Reviewer"
          hint={
            props.review === 'off'
              ? 'Answers are not reviewed'
              : props.review === 'always'
                ? 'Checks every final answer'
                : props.review === 'auto'
                  ? 'When the lead asks for a check'
                  : 'Checks the work'
          }
        >
          {props.review && props.onReview && (
            <Segmented
              id="composer-review"
              value={props.review}
              options={[...REVIEW]}
              onChange={props.onReview}
            />
          )}
          {!reviewOff && (
            <ModelPicker
              variant="compact"
              placement={props.placement}
              label="Reviewer"
              value={config.judgeModel}
              models={props.models}
              onChange={(judgeModel) => set({ judgeModel })}
            />
          )}
        </Row>
        <Row label="Thinking" hint="Auto: quick for questions, deeper for work">
          <Segmented
            id="composer-thinking"
            value={config.thinking ?? 'auto'}
            options={[...THINKING]}
            onChange={(v) => {
              const { thinking: _, ...rest } = config
              props.onConfig(v === 'auto' ? rest : { ...rest, thinking: v })
            }}
          />
        </Row>
      </div>
      {sameJudge && !reviewOff && (
        <p className="-mt-1 px-1 text-[11.5px] leading-snug text-muted">
          The reviewer shares a provider with the team; one from another provider catches more of its blind
          spots.
        </p>
      )}

      <div className={GROUP}>
        <button
          type="button"
          onClick={() => setHelpersOpen(!helpersOpen)}
          aria-expanded={helpersOpen}
          className="flex min-h-11 w-full items-center gap-2 px-3 text-left"
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted transition-transform', helpersOpen && 'rotate-90')}
          />
          <span className="flex-1 text-[13px]">Helpers</span>
          <span className="text-[12px] text-muted">
            {summary} · {swarm ? 'equal peers' : 'called by the lead'}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {helpersOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="divide-y divide-line border-t border-line">
                <HelpersEditor
                  models={props.models}
                  config={config}
                  onConfig={props.onConfig}
                  {...(props.placement ? { placement: props.placement } : {})}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p className="px-1 text-[11.5px] leading-snug text-muted">
        The lead answers itself and calls helpers only for big jobs.
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
  // The reviewer mode is a server setting; read it on load and whenever the team panel opens, so a change made in
  // Settings shows here.
  const [review, setReview] = useState<ReviewMode>()
  useEffect(() => {
    if (showTeam !== undefined) getReviewMode().then(setReview, () => setReview(undefined))
  }, [showTeam])
  const changeReview = (mode: ReviewMode) => {
    const before = review
    setReview(mode)
    setReviewMode(mode).catch(() => setReview(before))
  }
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
  useEffect(() => {
    onTextChange.current?.(text)
  }, [text])

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
  useEffect(() => {
    setMenuIndex(0)
  }, [text])

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
          : (props.models.find((m) => m.ref === config.leadModel)?.name ?? config.leadModel)
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
              <div className="mb-3 flex items-baseline justify-between px-1">
                <h3 className="text-[13px] font-semibold">Lead &amp; helpers</h3>
                <span className="text-[11.5px] text-muted">Applies to your next messages</span>
              </div>
              <TeamSettings
                models={props.models}
                config={config}
                onConfig={props.onConfig}
                {...(review ? { review } : {})}
                onReview={changeReview}
              />
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
              <ModelPicker
                variant="chip"
                placement="up"
                label="Lead"
                value={config.leadModel}
                models={props.models}
                onChange={(leadModel) => props.onConfig({ ...config, leadModel })}
              />
              <ThinkingChip config={config} onConfig={props.onConfig} />
              <ReviewChip
                models={props.models}
                config={config}
                onConfig={props.onConfig}
                {...(review ? { review } : {})}
                onReview={changeReview}
              />
              <HelpersChip models={props.models} config={config} onConfig={props.onConfig} />
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
