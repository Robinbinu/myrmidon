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
  type CrewMember,
  getReviewMode,
  type ModelOption,
  providerOf,
  type ReviewMode,
  setReviewMode,
  type TeamConfig,
} from '../api.ts'
import { copy } from '../copy.ts'
import { PluginSlot, usePluginSlots } from '../plugins.tsx'
import { usePersistentFlag } from '../ui/hooks.ts'
import { cn, Segmented } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { MAX_FILE_BYTES, MAX_FILES, spring } from '../ui-config.ts'
import { buildMenu, CommandMenu, type MenuModel, rememberCommand } from './CommandMenu.tsx'
import { parseSlash, type SlashCommand } from './commands.ts'
import { helpersHint, helpersLabel } from './helpers.ts'
import { ModelPicker, PickerHost } from './ModelPicker.tsx'
import { withoutDatedAliases } from './model-list.ts'
import { HelpersChip, HelpersEditor, ReviewChip, Row, ThinkingChip } from './TeamControls.tsx'

export const MODES = [
  {
    id: 'orchestrated',
    ...copy.composer.modes.orchestrated,
    icon: Workflow,
  },
  {
    id: 'swarm',
    ...copy.composer.modes.swarm,
    icon: Users,
  },
] as const

export function teamLabel(config: TeamConfig): string {
  const n = config.roster.length
  return copy.composer.teamLabel(config.mode === 'swarm', n)
}

const GROUP = 'divide-y divide-line overflow-visible rounded-[10px] border border-line bg-surface'

const THINKING = [
  { value: 'auto', label: copy.composer.thinking.auto },
  { value: 'low', label: copy.composer.thinking.low },
  { value: 'medium', label: copy.composer.thinking.medium },
  { value: 'high', label: copy.composer.thinking.high },
] as const

const REVIEW = [
  { value: 'off', label: copy.composer.review.off },
  { value: 'auto', label: copy.composer.review.auto },
  { value: 'always', label: copy.composer.review.always },
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
  const reviewOff = props.review === 'off'

  return (
    <div className="flex flex-col gap-3">
      <div className={GROUP}>
        {!swarm && (
          <Row label={copy.composer.lead} hint={copy.composer.leadHint}>
            <ModelPicker
              variant="compact"
              placement={props.placement}
              label={copy.composer.lead}
              value={config.leadModel}
              models={props.models}
              onChange={(leadModel) => set({ leadModel })}
            />
          </Row>
        )}
        <Row
          label={copy.composer.reviewer}
          hint={
            props.review === 'off'
              ? copy.composer.reviewerHint.off
              : props.review === 'always'
                ? copy.composer.reviewerHint.always
                : props.review === 'auto'
                  ? copy.composer.reviewerHint.auto
                  : copy.composer.reviewerHint.unknown
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
              label={copy.composer.reviewer}
              value={config.judgeModel}
              models={props.models}
              onChange={(judgeModel) => set({ judgeModel })}
            />
          )}
        </Row>
        <Row label={copy.composer.thinkingLabel} hint={copy.composer.thinkingHint}>
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
        <p className="-mt-1 px-1 text-[11.5px] leading-snug text-muted">{copy.composer.sameProvider}</p>
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
          <span className="flex-1 text-[13px]">{copy.composer.helpers}</span>
          <span className="text-[12px] text-muted">{helpersLabel(config)}</span>
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
      <p className="px-1 text-[11.5px] leading-snug text-muted">{helpersHint(config)}</p>
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

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Toolbar controls read as quiet text until hovered, so the message stays the focus. */
const CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:opacity-40'

const DELIVERIES = [
  { value: 'steer', icon: Navigation, ...copy.composer.deliveries.steer },
  { value: 'queue', icon: ListEnd, ...copy.composer.deliveries.queue },
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
  /** Crew members the person can write to directly by typing @ and a name. */
  crew?: readonly CrewMember[]
}

/** An @name being typed at the end of the message. */
const MENTION_AT_END = /(^|\s)@([a-z0-9-]*)$/i

/**
 * While an @name is being typed, the crew members it could be: picking one completes the name, and the message then
 * goes to them directly.
 */
function mentionMenu(
  text: string,
  crew: readonly CrewMember[] | undefined,
  insert: (name: string) => void,
): MenuModel | undefined {
  const typed = MENTION_AT_END.exec(text)
  if (!typed || !crew?.length) return undefined
  const prefix = (typed[2] ?? '').toLowerCase()
  const items = crew
    .filter((c) => c.name.toLowerCase().startsWith(prefix))
    .map((c, i) => ({
      key: c.name,
      ...(i === 0 ? { section: copy.composer.mention.section } : {}),
      title: `@${c.name}`,
      description: c.specialty ?? c.role,
      agent: c.name,
      run: () => insert(c.name),
      complete: () => insert(c.name),
    }))
  return items.length ? { items, label: copy.composer.mention.label } : undefined
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const [text, setText] = useState('')
  const chips = usePluginSlots('composer.chip')
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
  const toast = useToast()
  // Files that can't go are refused here, by name, rather than at send time or silently.
  const addFiles = (list: Iterable<File>) => {
    const nonEmpty = [...list].filter((f) => f.size > 0)
    const tooLarge = nonEmpty.filter((f) => f.size > MAX_FILE_BYTES)
    for (const f of tooLarge) toast(copy.app.fileTooLarge(f.name), 'error')
    const fitting = nonEmpty.filter((f) => f.size <= MAX_FILE_BYTES)
    const room = Math.max(0, MAX_FILES - files.length)
    if (fitting.length > room) toast(copy.composer.tooManyFiles(MAX_FILES, fitting.length - room), 'error')
    const added = fitting.slice(0, room)
    if (added.length > 0) setFiles((prev) => [...prev, ...added].slice(0, MAX_FILES))
  }
  const area = useRef<HTMLTextAreaElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const teamPanel = useRef<HTMLDivElement>(null)
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
      // The download starts without any sign in the page; say it happened and where to look.
      if (command.name === 'export') toast(copy.composer.exported, 'success')
    } catch {
      setText(`/${command.name}${arg ? ` ${arg}` : ''}`)
    }
  }

  const send = async (how: Delivery = delivery) => {
    const slash = parseSlash(text)
    if (slash && files.length === 0) return runCommand(slash.command, slash.arg)
    const value = text.trim() || (files.length > 0 ? copy.composer.attachedOnly : '')
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

  // Escape closes the menu for the text as it is, and keeps the text; typing on opens it again.
  const [closedFor, setClosedFor] = useState<string>()
  const mention = mentionMenu(text, props.crew, (name) =>
    fillCommand(text.replace(MENTION_AT_END, (_m, space: string) => `${space}@${name} `)),
  )
  const listed =
    mention ??
    buildMenu({
      text,
      all: showHelp,
      ctx: { running: props.running, chat: !!props.chatState?.chat, resumable: !!props.chatState?.resumable },
      dynamicOptions: (c) =>
        c.name === 'model'
          ? withoutDatedAliases(
              props.models.filter((m) => !m.hidden),
              config.leadModel,
            ).map((m) => ({
              value: m.ref,
              label: m.name,
              description: `${m.provider}${m.reasoning ? copy.composer.reasoning : ''}`,
            }))
          : undefined,
      current: (c) =>
        c.name === 'model'
          ? config.mode === 'swarm'
            ? undefined
            : (props.models.find((m) => m.ref === config.leadModel)?.name ?? config.leadModel)
          : c.name === 'mode'
            ? config.mode === 'swarm'
              ? copy.composer.modes.swarm.name
              : copy.composer.modes.orchestrated.name
            : c.name === 'thinking'
              ? (config.thinking ?? 'auto')
              : undefined,
      pickCommand: (c) => void runCommand(c, ''),
      completeCommand: (c) => fillCommand(`/${c.name}${c.needsArg ? ' ' : ''}`),
      pickOption: (c, value) => void runCommand(c, value),
      submit: () => void send(),
    })
  const menu = !showHelp && text === closedFor ? undefined : listed
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
              ref={teamPanel}
              role="dialog"
              aria-label={copy.composer.teamDialog}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }}
              transition={spring}
              className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-full origin-bottom rounded-2xl border border-line bg-surface p-4 shadow-pop"
            >
              <div className="mb-3 flex items-baseline justify-between px-1">
                <h3 className="text-[13px] font-semibold">{copy.composer.teamHeading}</h3>
                <span className="text-[11.5px] text-muted">{copy.composer.teamApplies}</span>
              </div>
              <PickerHost.Provider value={teamPanel}>
                <TeamSettings
                  models={props.models}
                  config={config}
                  onConfig={props.onConfig}
                  {...(review ? { review } : {})}
                  onReview={changeReview}
                />
              </PickerHost.Provider>
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
                  className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-0.5 pl-2 pr-0.5 text-[12px]"
                >
                  <FileText className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-muted">{formatSize(f.size)}</span>
                  <button
                    type="button"
                    aria-label={copy.composer.removeFile(f.name)}
                    onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg"
                  >
                    <X className="size-3.5" />
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
                  if (showHelp) return setShowHelp(false)
                  return setClosedFor(text)
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
            aria-label={copy.composer.message}
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
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <button
                type="button"
                onClick={() => picker.current?.click()}
                aria-label={copy.composer.attach}
                title={copy.composer.attachTitle}
                disabled={files.length >= MAX_FILES}
                className={cn(CHIP, 'w-8 shrink-0 justify-center px-0')}
              >
                <Paperclip className="size-4" />
              </button>
              <ModelPicker
                variant="chip"
                placement="up"
                label={copy.composer.lead}
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
              {chips.map(({ plugin, def }) => (
                <PluginSlot
                  key={plugin}
                  plugin={plugin}
                  def={def}
                  props={{
                    insert: (t) => fillCommand(text ? `${text} ${t}` : t),
                    send: (t) => void props.onSend(t, delivery, []).catch(() => {}),
                  }}
                />
              ))}
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
                    onClick={() => {
                      setDelivery(delivery === 'steer' ? 'queue' : 'steer')
                      // Back to the message, so Enter sends it instead of flipping the toggle again.
                      area.current?.focus()
                    }}
                    title={copy.composer.deliveryTitle(DELIVERIES.find((d) => d.value === delivery)?.hint)}
                    aria-label={copy.composer.deliveryLabel(
                      delivery,
                      delivery === 'steer' ? 'queue' : 'steer',
                    )}
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
              {/* While a round runs, Stop stays put; Send joins it once there is something to send. */}
              <AnimatePresence mode="popLayout" initial={false}>
                {props.running && (
                  <motion.button
                    key="stop"
                    type="button"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    transition={spring}
                    onClick={props.onStop}
                    aria-label={copy.composer.stopLabel}
                    title={props.status ? copy.composer.stopTitle(props.status) : copy.composer.stop}
                    className="grid size-9 place-items-center rounded-full bg-fg text-bg transition-transform active:scale-90"
                  >
                    <Square className="size-3.5" fill="currentColor" />
                  </motion.button>
                )}
                {(!props.running || canSend) && (
                  <motion.button
                    key="send"
                    type="button"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    transition={spring}
                    onClick={() => void send()}
                    disabled={!canSend}
                    aria-label={copy.composer.send}
                    title={copy.composer.sendTitle}
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
