import { LoaderCircle } from 'lucide-react'
import { motion } from 'motion/react'
import {
  type ButtonHTMLAttributes,
  cloneElement,
  forwardRef,
  type InputHTMLAttributes,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react'
import { spring } from '../ui-config.ts'
import { type Tone, toneFor } from './status.ts'

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'push' | 'borderless' | 'destructive' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent shadow-[inset_0_0.5px_0_rgb(255_255_255/0.4),0_0.5px_1px_rgb(0_0_0/0.2)] hover:bg-accent-hover active:brightness-95',
  push: 'border border-line-strong/70 bg-control text-fg shadow-control hover:bg-control-hover active:bg-control-active',
  borderless: 'text-fg-2 hover:bg-fill hover:text-fg active:bg-fill-strong',
  destructive: 'bg-bad-fill text-white shadow-[0_0.5px_1px_rgb(0_0_0/0.2)] hover:brightness-110',
  danger: 'border border-bad/35 text-bad-ink hover:bg-bad-soft',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant
    size?: Size
    icon?: ReactNode
    /** Work under way: a spinner takes the icon's place and the button waits. */
    loading?: boolean
  }
>(function Button(
  { variant = 'push', size = 'md', icon, loading, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-100 disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-6 rounded-sm px-2 text-small' : 'h-7 rounded-md px-3 text-body',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: Size }
>(function IconButton({ label, active, size = 'md', className, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-md transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-6' : 'size-7',
        active ? 'bg-fill-strong text-fg' : 'text-fg-2 hover:bg-fill hover:text-fg active:bg-fill-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

const TONES: Record<Tone, string> = {
  neutral: 'bg-fill-strong text-fg-2',
  ok: 'bg-ok-soft text-ok-ink',
  bad: 'bg-bad-soft text-bad-ink',
  warn: 'bg-warn-soft text-warn-ink',
  work: 'bg-work/10 text-work-ink',
  accent: 'bg-accent-soft text-accent-fg',
}

export { type Tone, toneFor }

/** A small status capsule. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-caption font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  bad: 'bg-bad',
  warn: 'bg-warn',
  work: 'bg-work',
  accent: 'bg-accent',
  neutral: 'bg-muted/60',
}

/**
 * A status dot. `status` picks its colour as everywhere else (toneFor); `tone` sets it directly, as for a health
 * check. Work in motion pings unless `pulse` is false, as in a lane heading that would otherwise never stop.
 */
export function Dot(props: ({ status: string } | { tone: Tone }) & { pulse?: boolean }) {
  const tone = 'tone' in props ? props.tone : toneFor(props.status)
  const color = DOT[tone]
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {(props.pulse ?? tone === 'work') && (
        <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', color)} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  )
}

/** A count as a badge shows it: past 99 it stops growing. */
export const countText = (n: number) => (n > 99 ? '99+' : String(n))

/**
 * A number on a capsule: items in a tab, requests waiting. Accent asks for the person; `corner` pins it to the
 * corner of the icon it counts for. With `label` it is read as that sentence instead of a bare number.
 */
export function CountBadge(props: {
  count: number
  tone?: 'neutral' | 'accent'
  corner?: boolean
  label?: string
  className?: string
}) {
  return (
    <span
      {...(props.label ? { role: 'img', 'aria-label': props.label, title: props.label } : {})}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-sans text-caption font-semibold leading-none tracking-normal tabular-nums',
        props.tone === 'accent' ? 'bg-accent text-on-accent' : 'bg-fill-strong text-fg-2',
        props.corner && 'absolute -right-1 -top-1',
        props.className,
      )}
    >
      {countText(props.count)}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-line bg-fill px-1 font-sans text-caption text-muted">
      {children}
    </kbd>
  )
}

export function Switch(props: {
  checked: boolean
  onChange(v: boolean): void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 disabled:opacity-40',
        props.checked ? 'bg-accent' : 'bg-fill-strong shadow-[inset_0_0_0_0.5px_var(--separator-strong)]',
      )}
    >
      <motion.span
        layout
        transition={spring}
        className={cn(
          'size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25),0_0_0_0.5px_rgb(0_0_0/0.06)]',
          props.checked ? 'ml-auto' : 'ml-0',
        )}
      />
    </button>
  )
}

const FIELD =
  'w-full rounded-md border border-line-strong/70 bg-control px-2.5 py-1.5 text-body text-fg shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.06)] outline-none transition-[border,box-shadow] duration-100 placeholder:text-muted focus:border-focus focus:ring-3 focus:ring-focus/30 disabled:opacity-50'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(FIELD, className)} {...rest} />
  },
)

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return (
      <textarea ref={ref} className={cn(FIELD, 'min-h-24 resize-y leading-relaxed', className)} {...rest} />
    )
  },
)

/** A native select drawn as a macOS popup button: keyboard and screen readers keep the real control. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-7 appearance-none rounded-md border border-line-strong/70 bg-control bg-[image:var(--chevrons)] bg-[length:10px_14px] bg-[position:right_8px_center] bg-no-repeat pl-2.5 pr-7 text-body text-fg shadow-control outline-none transition-colors duration-100 hover:bg-control-hover focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/30 disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  )
}

/** Controls a label can point at; Field gives them its id. Anything else is labelled as a group instead. */
const LABELABLE = new Set<unknown>(['input', 'select', 'textarea', TextInput, TextArea, Select])

type ControlProps = { id?: string; 'aria-describedby'?: string }

export function Field(props: {
  label: string
  hint?: ReactNode
  /** Why the value is not accepted: shown with the field, and the control is marked invalid. */
  error?: string
  children: ReactNode
  htmlFor?: string
  inline?: boolean
}) {
  const id = useId()
  const control =
    isValidElement<ControlProps>(props.children) && LABELABLE.has(props.children.type)
      ? props.children
      : undefined
  const controlId = props.htmlFor ?? control?.props.id ?? `${id}control`
  const linked = !!props.htmlFor || !!control
  const hintId = props.hint ? `${id}hint` : undefined
  const errorId = props.error ? `${id}error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const error = props.error && (
    <p id={errorId} className="mt-0.5 text-small leading-snug text-bad-ink">
      {props.error}
    </p>
  )
  return (
    <div
      className={cn('flex gap-2', props.inline ? 'items-center justify-between' : 'flex-col')}
      {...(linked ? {} : { role: 'group', 'aria-labelledby': `${id}label`, 'aria-describedby': describedBy })}
    >
      <div className="min-w-0">
        <label
          id={`${id}label`}
          htmlFor={linked ? controlId : undefined}
          className="block text-body font-medium text-fg"
        >
          {props.label}
        </label>
        {props.hint && (
          <p id={hintId} className="mt-0.5 text-callout leading-snug text-muted">
            {props.hint}
          </p>
        )}
        {props.inline && error}
      </div>
      {control
        ? cloneElement(control, {
            id: controlId,
            'aria-describedby':
              [control.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
            ...(props.error ? { 'aria-invalid': true } : {}),
          } as ControlProps)
        : props.children}
      {!props.inline && error}
    </div>
  )
}

/** macOS segmented control with a sliding thumb. */
export function Segmented<T extends string>(props: {
  value: T
  options: { value: NoInfer<T>; label: ReactNode }[]
  onChange(v: NoInfer<T>): void
  id: string
}) {
  return (
    <div className="inline-flex rounded-md bg-fill-strong p-[2px]">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cn(
            'relative inline-flex h-[22px] items-center gap-1.5 rounded-sm px-2.5 text-small font-medium transition-colors',
            props.value === o.value ? 'text-fg' : 'text-fg-2 hover:text-fg',
          )}
        >
          {props.value === o.value && (
            <motion.span
              layoutId={`seg-${props.id}`}
              transition={spring}
              className="absolute inset-0 rounded-sm bg-control shadow-[0_0.5px_2px_rgb(0_0_0/0.18),0_0_0_0.5px_rgb(0_0_0/0.05)]"
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Underline tabs whose amber indicator glides between items. One Tab stop: the arrow keys, Home and End move between
 * tabs and show each one. The content they switch spreads `tabPanel(id, value)` so the two are linked.
 */
export function Tabs<T extends string>(props: {
  value: T
  tabs: { value: NoInfer<T>; label: ReactNode; count?: number }[]
  onChange(v: NoInfer<T>): void
  id: string
  className?: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = props.tabs.findIndex((t) => t.value === props.value)
    const last = props.tabs.length - 1
    const next =
      e.key === 'ArrowRight'
        ? at === last
          ? 0
          : at + 1
        : e.key === 'ArrowLeft'
          ? at <= 0
            ? last
            : at - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : undefined
    const tab = next === undefined ? undefined : props.tabs[next]
    if (!tab) return
    e.preventDefault()
    props.onChange(tab.value)
    e.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(tabId(props.id, tab.value))}`)?.focus()
  }
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn('flex gap-1 overflow-x-auto border-b border-line px-3', props.className)}
    >
      {props.tabs.map((t) => (
        <button
          key={t.value}
          id={tabId(props.id, t.value)}
          type="button"
          role="tab"
          aria-selected={props.value === t.value}
          aria-controls={`${props.id}-panel`}
          tabIndex={props.value === t.value ? 0 : -1}
          onClick={() => props.onChange(t.value)}
          className={cn(
            'relative inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-2 text-callout font-medium transition-colors',
            props.value === t.value ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
          {!!t.count && <CountBadge count={t.count} />}
          {props.value === t.value && (
            <motion.span
              layoutId={`tab-${props.id}`}
              transition={spring}
              className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent"
            />
          )}
        </button>
      ))}
    </div>
  )
}

const tabId = (id: string, value: string) => `${id}-tab-${value}`

/** What the content under a Tabs spreads, so the tab and the panel it shows name each other. */
export function tabPanel(id: string, value: string) {
  return { role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': tabId(id, value) } as const
}

/** A page's title and what the page is for, at the top of a Settings section. */
export function PageHeader(props: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-page-title font-semibold tracking-tight">{props.title}</h3>
      {props.children && <p className="mt-1 text-reading leading-relaxed text-muted">{props.children}</p>}
    </div>
  )
}

/** The heading over one part of a page: an optional icon, its name, and a quieter note after it. */
export function SectionHeader(props: {
  as?: 'h2' | 'h3' | 'h4'
  icon?: ReactNode
  title: ReactNode
  note?: ReactNode
  className?: string
}) {
  const Heading = props.as ?? 'h4'
  return (
    <Heading className={cn('flex items-center gap-2 text-body font-semibold', props.className)}>
      {props.icon}
      {props.title}
      {props.note && <span className="font-normal text-muted">{props.note}</span>}
    </Heading>
  )
}

/**
 * Rows on a rounded panel, separated by hairlines. With a `title` the panel is a section with that heading (and an
 * `action` beside it) across its top.
 */
export function Card(props: { children: ReactNode; className?: string; title?: string; action?: ReactNode }) {
  const panel = 'rounded-2xl border border-line bg-surface'
  if (props.title === undefined)
    return <div className={cn('divide-y divide-line', panel, props.className)}>{props.children}</div>
  return (
    <section className={cn(panel, props.className)}>
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <SectionHeader as="h2" title={props.title} />
        {props.action}
      </header>
      <div className="divide-y divide-line">{props.children}</div>
    </section>
  )
}

/** One row of a Card. */
export function CardRow(props: { children: ReactNode }) {
  return <div className="px-4 py-3.5">{props.children}</div>
}

const BANNER: Record<'bad' | 'warn' | 'ok' | 'info', string> = {
  bad: 'bg-bad-soft text-bad-ink',
  warn: 'bg-warn-soft text-warn-ink',
  ok: 'bg-ok-soft text-ok-ink',
  info: 'bg-fill text-fg-2',
}

/** A notice in the flow of a page: something failed, needs a look, or worked. An `alert` is read out when it appears. */
export function Banner(props: {
  tone: keyof typeof BANNER
  role?: 'alert' | 'status' | 'note'
  className?: string
  children: ReactNode
}) {
  return (
    <div
      role={props.role}
      className={cn('rounded-lg px-4 py-3 text-callout', BANNER[props.tone], props.className)}
    >
      {props.children}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-fill', className)} />
}

export function Empty(props: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {props.icon && (
        <div className="grid size-10 place-items-center rounded-lg bg-fill text-muted">{props.icon}</div>
      )}
      <p className="text-body font-semibold text-fg">{props.title}</p>
      {props.children && <div className="max-w-sm text-callout text-muted">{props.children}</div>}
    </div>
  )
}
