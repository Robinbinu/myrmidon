import { ArrowUp, ChevronRight, ListEnd, Navigation, Paperclip, Square } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
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
import { SUGGEST_KEY, SUGGEST_MODEL_KEY, usePersistentFlag } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Popover } from '../ui/Popover.tsx'
import { cn, SectionHeader, Segmented } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { MAX_FILE_BYTES, MAX_FILES, spring } from '../ui-config.ts'
import { PendingFiles } from './Attachments.tsx'
import { buildMenu, CommandMenu, type MenuModel, rememberCommand } from './CommandMenu.tsx'
import { parseSlash, type SlashCommand } from './commands.ts'
import { readDraft, saveDraft } from './drafts.ts'
import { helperMode, helpersHint, helpersLabel, withHelperMode } from './helpers.ts'
import { ModelPicker, PickerHost } from './ModelPicker.tsx'
import { withoutDatedAliases } from './model-list.ts'
import { nextWord } from './suggest.ts'
import { HelpersChip, HelpersEditor, ReviewChip, Row, TeamChip, ThinkingChip } from './TeamControls.tsx'
import { idleRoom, naturalWidth, shouldFold } from './toolbar-fit.ts'
import { useModelWord, useSuggester } from './use-suggester.ts'

export const MODES = [
  {
    id: 'orchestrated',
    ...copy.composer.modes.orchestrated,
    icon: FEATURE_ICONS.orchestrated,
  },
  {
    id: 'swarm',
    ...copy.composer.modes.swarm,
    icon: FEATURE_ICONS.swarm,
  },
] as const

export function teamLabel(config: TeamConfig): string {
  const n = config.roster.length
  return copy.composer.teamLabel(config.mode === 'swarm', n)
}

const GROUP = 'divide-y divide-line overflow-visible rounded-base border border-line bg-surface'

const THINKING = [
  { value: 'auto', label: copy.composer.thinking.auto },
  { value: 'low', label: copy.composer.thinking.low },
  { value: 'medium', label: copy.composer.thinking.medium },
  { value: 'high', label: copy.composer.thinking.high },
] as const

const HELPER_MODES = [
  { value: 'never', label: copy.teamControls.helperModes.never.title },
  { value: 'auto', label: copy.teamControls.helperModes.auto.title },
  { value: 'always', label: copy.teamControls.helperModes.always.title },
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
        <p className="-mt-1 px-1 text-footnote leading-snug text-muted">{copy.composer.sameProvider}</p>
      )}

      <div className={GROUP}>
        <Row label={copy.composer.helpers} hint={helpersHint(config)}>
          <Segmented
            id="composer-helpers"
            value={helperMode(config)}
            options={[...HELPER_MODES]}
            onChange={(mode) => props.onConfig(withHelperMode(config, mode, props.models))}
          />
        </Row>
        {helperMode(config) !== 'never' && (
          <button
            type="button"
            onClick={() => setHelpersOpen(!helpersOpen)}
            aria-expanded={helpersOpen}
            className="flex min-h-11 w-full items-center gap-2 px-3 text-left"
          >
            <ChevronRight
              className={cn('size-3.5 shrink-0 text-muted transition-transform', helpersOpen && 'rotate-90')}
            />
            <span className="flex-1 text-body">{copy.composer.helperList}</span>
            <span className="text-small text-muted">{helpersLabel(config)}</span>
          </button>
        )}
        <AnimatePresence initial={false}>
          {helpersOpen && helperMode(config) !== 'never' && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              // Clipped only while it folds, so the helpers' model lists can open past its edge.
              animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
              exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
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

/** A file's size the way people say it: 812 B, 34 KB, 1.3 MB. */
/** Toolbar controls read as quiet text until hovered, so the message stays the focus. */
const CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-xl px-2 text-callout font-medium text-muted transition-colors duration-150 hover:bg-fill hover:text-fg disabled:opacity-40'

const DELIVERIES = [
  { value: 'steer', icon: Navigation, ...copy.composer.deliveries.steer },
  { value: 'queue', icon: ListEnd, ...copy.composer.deliveries.queue },
] as const

interface ComposerProps {
  /** Where the unsent text is kept, so a refresh doesn't lose it: the chat's id, or the new-chat screen's. */
  draftKey?: string
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
  const [text, setText] = useState(() => (props.draftKey ? readDraft(props.draftKey) : ''))
  // The box is mounted per chat, so the key never changes under a typed text.
  useEffect(() => {
    if (props.draftKey) saveDraft(props.draftKey, text)
  }, [text, props.draftKey])
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
    const [first] = tooLarge
    if (first)
      toast(
        tooLarge.length === 1
          ? copy.app.fileTooLarge(first.name)
          : copy.composer.filesTooLarge(tooLarge.map((f) => f.name)),
        'error',
      )
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

  // Where the toolbar can't fit every chip, Thinking, Reviewer and Helpers fold into one Team chip, so the model and
  // project chips keep their names. The chips' full width is measured while they are all shown (it changes with the
  // model and project names) and remembered while folded.
  const chipRow = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const folded = useRef(false)
  const fullChips = useRef(0)
  const [narrow, setNarrow] = useState(false)
  const fitChips = useRef(() => {})
  fitChips.current = () => {
    const row = chipRow.current
    const right = actions.current
    if (!row || !right) return
    if (!folded.current) fullChips.current = naturalWidth(row)
    folded.current = shouldFold(folded.current, idleRoom(row, right), fullChips.current)
    setNarrow(folded.current)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure before paint when what the chips say changes
  useLayoutEffect(() => {
    fitChips.current()
  }, [config, review, props.project, props.models])
  useEffect(() => {
    const observer = new ResizeObserver(() => fitChips.current())
    for (const el of [chipRow.current, actions.current]) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
      // The download starts without any sign in the page; say it happened and where to look. Without a chat there is
      // nothing to download, and the app already says so.
      if (command.name === 'export' && props.chatState?.chat) toast(copy.composer.exported, 'success')
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
    // Sending from the new-chat screen moves to the new chat in the same update, unmounting this box before its draft
    // effect sees the empty text; a failed send puts the text back below, which keeps it again.
    if (props.draftKey) saveDraft(props.draftKey, '')
    setFiles([])
    setShowTeam(false)
    try {
      await props.onSend(value, how, sent)
      if (text.trim()) suggester?.learn(text.trim())
    } catch {
      setText(text)
      setFiles(sent)
    }
  }

  // Escape closes the menu for the text as it is, and keeps the text; any change to the text (typing, sending,
  // picking) opens it again.
  const [closedFor, setClosedFor] = useState<string>()
  useEffect(() => {
    if (text !== closedFor) setClosedFor(undefined)
  }, [text, closedFor])
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

  // Ghost text after the caret, from what the person wrote before: Tab takes its next word, → all of it, Esc hides it.
  const [suggestOn] = usePersistentFlag(SUGGEST_KEY, true)
  const suggester = useSuggester(suggestOn)
  const [atEnd, setAtEnd] = useState(true)
  const [hiddenFor, setHiddenFor] = useState<string>()
  const [modelOn] = usePersistentFlag(SUGGEST_MODEL_KEY, false)
  const shown = !menu && atEnd && text !== hiddenFor
  const local = shown ? suggester?.suggest(text) : undefined
  // The model only guesses a whole next word, after a space, and only when the person's own history had nothing.
  const modelWord = useModelWord(
    text,
    suggestOn && modelOn && shown && !local && / $/.test(text) && !!text.trim(),
  )
  const ghost = local ?? modelWord
  const ghostLayer = useRef<HTMLDivElement>(null)
  const take = (part: string) => {
    const next = text + part
    setText(next)
    requestAnimationFrame(() => {
      const el = area.current
      if (!el) return
      el.selectionStart = el.selectionEnd = next.length
      setAtEnd(true)
    })
  }
  // The ghost layer scrolls with the box, so the suggestion stays after the last line of text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the box whenever the suggestion changes
  useLayoutEffect(() => {
    if (ghostLayer.current && area.current) ghostLayer.current.scrollTop = area.current.scrollTop
  }, [ghost])
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
            <Popover
              role="dialog"
              label={copy.composer.teamDialog}
              onClose={() => setShowTeam(false)}
              within={wrap}
              box={teamPanel}
              up
              className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-full origin-bottom rounded-2xl border border-line bg-surface p-4 shadow-pop"
            >
              <div className="mb-3 flex items-baseline justify-between px-1">
                <SectionHeader as="h3" title={copy.composer.teamHeading} />
                <span className="text-footnote text-muted">{copy.composer.teamApplies}</span>
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
            </Popover>
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
            'rounded-xl border border-line-strong bg-surface shadow-pop transition-[box-shadow,border-color] duration-200 focus-within:border-accent/50 focus-within:shadow-[var(--shadow-lg),0_0_0_4px_var(--accent-soft)]',
            dragging && 'border-accent/60 shadow-[var(--shadow-lg),0_0_0_4px_var(--accent-soft)]',
          )}
        >
          {files.length > 0 && (
            <PendingFiles
              files={files}
              onRemove={(i) => setFiles((prev) => prev.filter((_, n) => n !== i))}
            />
          )}
          <div className="relative">
            <textarea
              ref={area}
              rows={1}
              value={text}
              placeholder={props.placeholder}
              onChange={(e) => setText(e.target.value)}
              onSelect={(e) => {
                const el = e.currentTarget
                setAtEnd(el.selectionStart === el.value.length && el.selectionEnd === el.value.length)
              }}
              onScroll={(e) => {
                if (ghostLayer.current) ghostLayer.current.scrollTop = e.currentTarget.scrollTop
              }}
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
                if (ghost && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                  if (e.key === 'Tab') {
                    e.preventDefault()
                    return take(nextWord(ghost))
                  }
                  if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    return take(ghost)
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    return setHiddenFor(text)
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  // Alt+Enter sends the other way, without changing the toggle.
                  void send(e.altKey && props.running ? (delivery === 'steer' ? 'queue' : 'steer') : delivery)
                }
              }}
              aria-label={copy.composer.message}
              className="block max-h-[300px] w-full resize-none bg-transparent px-5 pb-1.5 pt-4 text-headline leading-relaxed text-fg outline-none placeholder:text-muted"
            />
            {ghost && (
              // The typed text again, invisible, so the suggestion lands right after the caret, wrapped as the box wraps.
              <div
                ref={ghostLayer}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap px-5 pb-1.5 pt-4 text-headline leading-relaxed [overflow-wrap:break-word]"
              >
                <span className="invisible">{text}</span>
                <span className="text-muted">{ghost}</span>
              </div>
            )}
          </div>
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
            <div ref={chipRow} className="flex min-w-0 flex-1 items-center gap-1">
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
              {narrow ? (
                <TeamChip
                  config={config}
                  {...(review ? { review } : {})}
                  open={showTeam}
                  onClick={() => setShowTeam(!showTeam)}
                />
              ) : (
                <>
                  <ThinkingChip config={config} onConfig={props.onConfig} />
                  <ReviewChip
                    models={props.models}
                    config={config}
                    onConfig={props.onConfig}
                    {...(review ? { review } : {})}
                    onReview={changeReview}
                  />
                  <HelpersChip models={props.models} config={config} onConfig={props.onConfig} />
                </>
              )}
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
            <div ref={actions} className="flex shrink-0 items-center gap-1.5">
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
              {/* While a round runs, Stop holds the rightmost place; Send appears to its left once there is something to
                  send, so reaching for Stop never sends a message. */}
              <AnimatePresence mode="popLayout" initial={false}>
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
                      'grid size-8 place-items-center rounded-lg transition-colors duration-100',
                      canSend
                        ? 'bg-accent text-on-accent shadow-[inset_0_0.5px_0_rgb(255_255_255/0.4),0_0.5px_1px_rgb(0_0_0/0.2)] hover:bg-accent-hover'
                        : 'bg-fill-strong text-muted',
                    )}
                  >
                    <ArrowUp className="size-4" strokeWidth={2.5} />
                  </motion.button>
                )}
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
                    className="grid size-8 place-items-center rounded-lg bg-fg text-bg transition-opacity hover:opacity-90"
                  >
                    <Square className="size-3.5" fill="currentColor" />
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
