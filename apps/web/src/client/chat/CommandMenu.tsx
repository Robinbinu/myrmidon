import {
  Brain,
  Check,
  CircleHelp,
  ClipboardList,
  CornerDownLeft,
  Cpu,
  Download,
  ListEnd,
  type LucideIcon,
  Navigation,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Plus,
  RotateCcw,
  Settings,
  Square,
  Users,
  Workflow,
} from 'lucide-react'
import { motion } from 'motion/react'
import { Fragment, useEffect, useRef } from 'react'
import { copy } from '../copy.ts'
import { AgentAvatar } from '../ui/pixel.tsx'
import { cn, Kbd } from '../ui/primitives.tsx'
import { spring } from '../ui-config.ts'
import {
  type ArgOption,
  allCommands,
  GROUPS,
  type MenuSection,
  menuSections,
  rankCommands,
  rankOptions,
  type SlashCommand,
  type SlashContext,
  slashStage,
  unavailable,
} from './commands.ts'

const ICONS: Record<string, LucideIcon> = {
  plan: ClipboardList,
  steer: Navigation,
  queue: ListEnd,
  stop: Square,
  resume: Play,
  retry: RotateCcw,
  model: Cpu,
  mode: Workflow,
  thinking: Brain,
  team: Users,
  new: Plus,
  rename: Pencil,
  attach: Paperclip,
  export: Download,
  mcp: Plug,
  settings: Settings,
  help: CircleHelp,
}

const RECENT_KEY = 'myr-recent-commands'

export function recentCommands(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 3) : []
  } catch {
    return []
  }
}

export function rememberCommand(name: string) {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([name, ...recentCommands().filter((n) => n !== name)].slice(0, 3)),
    )
  } catch {
    // Recents are a convenience; private mode simply forgets them.
  }
}

export interface MenuItem {
  readonly key: string
  /** Section header shown above this item. */
  readonly section?: string
  readonly title: string
  /** Letters of `title` to highlight. */
  readonly matches?: readonly number[]
  readonly mono?: boolean
  readonly hint?: string
  readonly description?: string
  readonly icon?: LucideIcon
  /** A crew member's name: the row shows their face instead of an icon. */
  readonly agent?: string
  /** The setting's current value, shown on the right. */
  readonly value?: string
  readonly current?: boolean
  readonly disabled?: string
  /** Enter / click. */
  run(): void
  /** Tab: fill the composer instead of running. */
  complete?(): void
}

export interface MenuModel {
  readonly items: MenuItem[]
  /** Set while choosing an argument: the command being completed. */
  readonly command?: SlashCommand
  /** What the list is, for screen readers, when it is not the command list. */
  readonly label?: string
  /** The /help view: every command with its description, and the composer's keys. */
  readonly help?: boolean
}

/**
 * What the menu shows for the composer's text: commands while a name is being typed (recent and grouped when
 * nothing is typed yet), or a command's argument choices after `/name `.
 */
export function buildMenu(input: {
  text: string
  all: boolean
  ctx: SlashContext
  dynamicOptions(command: SlashCommand): ArgOption[] | undefined
  current(command: SlashCommand): string | undefined
  pickCommand(command: SlashCommand): void
  completeCommand(command: SlashCommand): void
  pickOption(command: SlashCommand, value: string): void
  submit(): void
}): MenuModel | undefined {
  const stage = input.all ? { stage: 'name' as const, query: '' } : slashStage(input.text)
  if (!stage) return undefined

  if (stage.stage === 'arg') {
    const { command } = stage
    const options = command.options ?? input.dynamicOptions(command)
    const current = input.current(command)
    if (!options)
      return {
        command,
        items: [
          {
            key: 'hint',
            title: stage.query
              ? copy.commandMenu.argHint.run(command.name)
              : copy.commandMenu.argHint.type(command.args ?? copy.commandMenu.argHint.theArgument),
            description: command.description,
            icon: ICONS[command.name] ?? CornerDownLeft,
            ...(stage.query ? {} : { disabled: copy.commandMenu.argHint.typeFirst }),
            run: input.submit,
          },
        ],
      }
    return {
      command,
      items: rankOptions(stage.query, options)
        .slice(0, 60)
        .map(
          (o): MenuItem => ({
            key: o.value,
            title: o.label,
            ...(o.description ? { description: o.description } : {}),
            // `current` is what the chip shows: a label (model name, mode) or a value (thinking level).
            current: o.value === current || o.label === current,
            run: () => input.pickOption(command, o.value),
          }),
        ),
    }
  }

  const item = (command: SlashCommand, matches: readonly number[], section?: string): MenuItem => {
    const reason = unavailable(command, input.ctx)
    const value = input.current(command)
    return {
      key: `${section ?? ''}/${command.name}`,
      ...(section ? { section } : {}),
      title: `/${command.name}`,
      matches: matches.map((i) => i + 1),
      mono: true,
      ...(command.args ? { hint: command.args } : {}),
      description: command.description,
      icon: ICONS[command.name] ?? CornerDownLeft,
      ...(value ? { value } : {}),
      ...(reason ? { disabled: reason } : {}),
      run: () => input.pickCommand(command),
      complete: () => input.completeCommand(command),
    }
  }

  if (stage.query)
    return { items: rankCommands(stage.query, input.ctx).map((r) => item(r.command, r.matches)) }

  // Help is a reference: every command in its group, in a fixed order, whether or not it can run now.
  const sections = input.all
    ? GROUPS.map((group) => ({
        section: group as MenuSection,
        commands: allCommands().filter((c) => c.group === group),
      }))
    : menuSections(input.ctx, recentCommands())
  const items = sections.flatMap(({ section, commands }) =>
    commands.map((c, i) =>
      item(
        c,
        [],
        i === 0
          ? section === 'recent'
            ? copy.commandMenu.recent
            : section === 'unavailable'
              ? copy.commandMenu.unavailable
              : copy.commands.groups[section]
          : undefined,
      ),
    ),
  )
  return { items, ...(input.all ? { help: true } : {}) }
}

function Highlight({ text, at }: { text: string; at?: readonly number[] }) {
  if (!at?.length) return <>{text}</>
  const hit = new Set(at)
  return (
    <>
      {[...text].map((ch, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: one span per character of a fixed string
          key={i}
          className={hit.has(i) ? 'text-accent-fg' : undefined}
        >
          {ch}
        </span>
      ))}
    </>
  )
}

/** The `/` palette above the composer: keyboard-first, with every command's state at a glance. */
export function CommandMenu(props: { menu: MenuModel; active: number; onHover(index: number): void }) {
  const list = useRef<HTMLDivElement>(null)
  // Keep the highlighted row in view while moving with the arrow keys.
  useEffect(() => {
    list.current?.querySelector(`[data-index="${props.active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [props.active])
  const { command, help } = props.menu
  const Icon = command ? (ICONS[command.name] ?? CornerDownLeft) : undefined

  return (
    <motion.div
      role="listbox"
      aria-label={
        props.menu.label ??
        (command
          ? copy.commandMenu.chooseFor(command.args ?? copy.commandMenu.anArgument, command.name)
          : copy.commandMenu.label)
      }
      initial={{ opacity: 0, y: 6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, transition: { duration: 0.1 } }}
      transition={spring}
      className="absolute bottom-[calc(100%+8px)] left-0 z-30 flex max-h-[min(420px,60vh)] w-full max-w-[560px] origin-bottom-left flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
    >
      {command && Icon && (
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-callout">
          <span className="grid size-6 place-items-center rounded-md bg-accent-soft text-accent-fg">
            <Icon className="size-3.5" />
          </span>
          <span className="font-mono font-medium">/{command.name}</span>
          <span className="truncate text-muted">{command.description}</span>
        </div>
      )}
      {help && (
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-callout">
          <span className="grid size-6 place-items-center rounded-md bg-accent-soft text-accent-fg">
            <CircleHelp className="size-3.5" />
          </span>
          <span className="font-mono font-medium">/help</span>
          <span className="truncate text-muted">{copy.commandMenu.help.title}</span>
        </div>
      )}
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {props.menu.items.length === 0 && (
          <p className="px-3 py-3 text-callout text-muted">{copy.commandMenu.noMatches}</p>
        )}
        {props.menu.items.map((it, i) => {
          const active = i === props.active
          const ItemIcon = it.icon
          return (
            <div key={it.key}>
              {it.section && (
                <div className="px-2.5 pb-1 pt-2.5 font-mono text-caption uppercase tracking-[0.14em] text-muted first:pt-1">
                  {it.section}
                </div>
              )}
              <button
                type="button"
                role="option"
                data-index={i}
                aria-selected={active}
                aria-disabled={!!it.disabled}
                title={it.disabled}
                onMouseEnter={() => props.onHover(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (!it.disabled) it.run()
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-100',
                  active && 'bg-surface-2',
                  it.disabled && 'opacity-45',
                )}
              >
                {it.agent ? (
                  <AgentAvatar name={it.agent} status="idle" size={32} awake />
                ) : ItemIcon ? (
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-xl transition-colors',
                      active && !it.disabled ? 'bg-accent-soft text-accent-fg' : 'bg-surface-2 text-fg-2',
                    )}
                  >
                    <ItemIcon className="size-4" />
                  </span>
                ) : (
                  <span className="grid size-5 shrink-0 place-items-center text-accent-fg">
                    {it.current && <Check className="size-4" />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn('shrink-0 text-body font-medium', it.mono && 'font-mono')}>
                      <Highlight text={it.title} {...(it.matches ? { at: it.matches } : {})} />
                    </span>
                    {it.hint && (
                      <span className="truncate font-mono text-footnote text-muted">{it.hint}</span>
                    )}
                  </span>
                  {(it.disabled ?? it.description) && (
                    <span className={cn('block text-small text-muted', !help && 'truncate')}>
                      {help && it.disabled
                        ? `${it.description} · ${it.disabled}`
                        : (it.disabled ?? it.description)}
                    </span>
                  )}
                </span>
                {it.value && (
                  <span className="max-w-[160px] shrink-0 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-caption text-fg-2">
                    {it.value}
                  </span>
                )}
                {active && !it.disabled && <CornerDownLeft className="size-3.5 shrink-0 text-muted" />}
              </button>
            </div>
          )
        })}
        {help && (
          <>
            <div className="px-2.5 pb-1 pt-2.5 font-mono text-caption uppercase tracking-[0.14em] text-muted">
              {copy.commandMenu.help.keysSection}
            </div>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 px-2.5 pb-2 text-callout">
              {copy.commandMenu.help.keys.map((k) => (
                <Fragment key={k.does}>
                  <dt className="flex items-center gap-1">
                    {k.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </dt>
                  <dd className="text-fg-2">{k.does}</dd>
                </Fragment>
              ))}
            </dl>
          </>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3.5 py-1.5 text-caption text-muted">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> {copy.commandMenu.footer.move}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> {command ? copy.commandMenu.footer.choose : copy.commandMenu.footer.run}
        </span>
        {!command && (
          <span className="flex items-center gap-1">
            <Kbd>Tab</Kbd> {copy.commandMenu.footer.complete}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> {copy.commandMenu.footer.close}
        </span>
      </div>
    </motion.div>
  )
}
