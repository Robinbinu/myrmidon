import { motion } from 'motion/react'
import {
  type ButtonHTMLAttributes,
  cloneElement,
  forwardRef,
  type InputHTMLAttributes,
  isValidElement,
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

type Variant =
  | 'primary'
  | 'push'
  | 'borderless'
  | 'toolbar'
  | 'destructive'
  | 'danger'
  // Older names, kept until every screen uses the ones above.
  | 'secondary'
  | 'ghost'
  | 'soft'
type Size = 'sm' | 'md'

const PUSH =
  'border border-line-strong/70 bg-control text-fg shadow-[0_0.5px_1px_rgb(0_0_0/0.08)] hover:bg-control-hover active:bg-control-active'
const BORDERLESS = 'text-fg-2 hover:bg-fill hover:text-fg active:bg-fill-strong'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent shadow-[inset_0_0.5px_0_rgb(255_255_255/0.4),0_0.5px_1px_rgb(0_0_0/0.2)] hover:bg-accent-hover active:brightness-95',
  push: PUSH,
  borderless: BORDERLESS,
  toolbar: BORDERLESS,
  destructive: 'bg-bad-fill text-white shadow-[0_0.5px_1px_rgb(0_0_0/0.2)] hover:brightness-110',
  danger: 'border border-bad/35 text-bad-ink hover:bg-bad-soft',
  secondary: PUSH,
  ghost: BORDERLESS,
  soft: 'bg-accent-soft text-accent-fg hover:brightness-105',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }
>(function Button(
  { variant = 'push', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-100 disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-[22px] rounded-[5px] px-2 text-small' : 'h-7 rounded-md px-3 text-body',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
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
        'inline-grid shrink-0 place-items-center rounded-md transition-colors duration-100 disabled:opacity-40',
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

/** The older name for Badge, kept until every screen uses Badge. */
export const Pill = Badge

export function Dot({ status }: { status: string }) {
  const tone = toneFor(status)
  const color = {
    ok: 'bg-ok',
    bad: 'bg-bad',
    warn: 'bg-warn',
    work: 'bg-work',
    accent: 'bg-accent',
    neutral: 'bg-muted/60',
  }[tone]
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {tone === 'work' && (
        <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', color)} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-fill px-1 font-sans text-caption text-muted">
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
        'h-7 appearance-none rounded-md border border-line-strong/70 bg-control bg-[image:var(--chevrons)] bg-[length:10px_14px] bg-[position:right_8px_center] bg-no-repeat pl-2.5 pr-7 text-body text-fg shadow-[0_0.5px_1px_rgb(0_0_0/0.08)] outline-none transition-colors duration-100 hover:bg-control-hover focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/30 disabled:opacity-50',
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
            'relative inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-2.5 text-small font-medium transition-colors',
            props.value === o.value ? 'text-fg' : 'text-fg-2 hover:text-fg',
          )}
        >
          {props.value === o.value && (
            <motion.span
              layoutId={`seg-${props.id}`}
              transition={spring}
              className="absolute inset-0 rounded-[5px] bg-control shadow-[0_0.5px_2px_rgb(0_0_0/0.18),0_0_0_0.5px_rgb(0_0_0/0.05)]"
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Underline tabs whose amber indicator glides between items. */
export function Tabs<T extends string>(props: {
  value: T
  tabs: { value: NoInfer<T>; label: ReactNode; count?: number }[]
  onChange(v: NoInfer<T>): void
  id: string
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 overflow-x-auto border-b border-line px-3', props.className)}
    >
      {props.tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={props.value === t.value}
          onClick={() => props.onChange(t.value)}
          className={cn(
            'relative inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-2 text-callout font-medium transition-colors',
            props.value === t.value ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
          {!!t.count && (
            <span className="rounded-full bg-fill-strong px-1.5 text-caption tabular-nums text-fg-2">
              {t.count}
            </span>
          )}
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

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />
}

export function Empty(props: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {props.icon && (
        <div className="grid size-10 place-items-center rounded-xl bg-fill text-muted">{props.icon}</div>
      )}
      <p className="text-body font-semibold text-fg">{props.title}</p>
      {props.children && <div className="max-w-sm text-callout text-muted">{props.children}</div>}
    </div>
  )
}
