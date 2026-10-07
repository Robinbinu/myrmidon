import { motion } from 'motion/react'
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

export const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive' | 'soft'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-soft',
  secondary: 'bg-surface text-fg border border-line hover:bg-surface-2 hover:border-line-strong',
  ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
  danger: 'text-bad border border-bad/30 hover:bg-bad-soft',
  destructive: 'bg-bad text-white shadow-soft hover:brightness-110',
  soft: 'bg-accent-soft text-accent hover:brightness-110',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }
>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-all duration-150 ease-fluid active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-8 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
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
        'inline-grid shrink-0 place-items-center rounded-lg transition-colors duration-150 active:scale-95 disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-9',
        active ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

const TONES = {
  neutral: 'bg-surface-2 text-fg-2 border-line',
  ok: 'bg-ok-soft text-ok border-ok/30',
  bad: 'bg-bad-soft text-bad border-bad/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  work: 'bg-work/10 text-work border-work/30',
  accent: 'bg-accent-soft text-accent border-accent/30',
} as const
export type Tone = keyof typeof TONES

export function toneFor(status: string): Tone {
  if (['completed', 'verified', 'ready'].includes(status)) return 'ok'
  if (['failed', 'rejected', 'stopped'].includes(status)) return 'bad'
  if (['submitted'].includes(status)) return 'warn'
  if (['running', 'created', 'working', 'in_progress'].includes(status)) return 'work'
  if (['waiting'].includes(status)) return 'accent'
  return 'neutral'
}

export function Pill({
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
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-[11.5px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

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
    <kbd className="rounded-md border border-line border-b-2 bg-surface px-1.5 py-px font-mono text-[11px] text-muted">
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
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 disabled:opacity-40',
        props.checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <motion.span
        layout
        transition={spring}
        className={cn(
          'size-5 rounded-full shadow-soft',
          props.checked ? 'ml-auto bg-on-accent' : 'ml-0 bg-white',
        )}
      />
    </button>
  )
}

const FIELD =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-fg outline-none transition-[border,box-shadow] duration-150 placeholder:text-muted focus:border-accent focus:ring-4 focus:ring-accent-soft disabled:opacity-50'

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

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    // FIELD's w-full would win over w-auto in the generated CSS, so a select drops it and sizes to its options.
    <select className={cn(FIELD.replace('w-full ', ''), 'cursor-pointer py-1.5 pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

export function Field(props: {
  label: string
  hint?: ReactNode
  children: ReactNode
  htmlFor?: string
  inline?: boolean
}) {
  return (
    <div className={cn('flex gap-2', props.inline ? 'items-center justify-between' : 'flex-col')}>
      <div className="min-w-0">
        <label htmlFor={props.htmlFor} className="block text-[13px] font-medium text-fg">
          {props.label}
        </label>
        {props.hint && <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{props.hint}</p>}
      </div>
      {props.children}
    </div>
  )
}

/** Segmented control with a springy sliding thumb. */
export function Segmented<T extends string>(props: {
  value: T
  options: { value: NoInfer<T>; label: ReactNode }[]
  onChange(v: NoInfer<T>): void
  id: string
}) {
  return (
    <div className="inline-flex rounded-xl bg-surface-2 p-1">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cn(
            'relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-[12.5px] font-medium transition-colors',
            props.value === o.value ? 'text-fg' : 'text-fg-2 hover:text-fg',
          )}
        >
          {props.value === o.value && (
            <motion.span
              layoutId={`seg-${props.id}`}
              transition={spring}
              className="absolute inset-0 rounded-lg bg-surface shadow-soft"
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Underline tabs whose indicator glides between items. */
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
            'relative inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-2.5 text-[13px] font-medium transition-colors',
            props.value === t.value ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {t.label}
          {!!t.count && (
            <span className="rounded-full bg-surface-3 px-1.5 text-[11px] tabular-nums text-fg-2">
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
        <div className="grid size-11 place-items-center rounded-2xl bg-surface-2 text-muted">
          {props.icon}
        </div>
      )}
      <p className="text-[14px] font-medium text-fg">{props.title}</p>
      {props.children && <div className="max-w-sm text-[13px] text-muted">{props.children}</div>}
    </div>
  )
}
