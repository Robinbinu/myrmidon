import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { fade, spring, TOAST_MS } from '../ui-config.ts'
import { cn } from './primitives.tsx'

/** `progress` is work still under way: it stays until settled with how it went. */
type Kind = 'info' | 'success' | 'error' | 'progress'
/** How work a progress toast was waiting on turned out. */
export type ToastOutcome = Exclude<Kind, 'progress'>
/** A button on a toast, e.g. Approve on "Bob wants to talk to your crew". */
export interface ToastAction {
  readonly label: string
  /** A longer hint on hover, e.g. the key that does the same. */
  readonly title?: string
  run(): void
}
export interface ToastOptions {
  /** How long it stays in place of its kind's usual time. A toast given its own time is never merged with a like one. */
  readonly ms?: number
}
/** A toast on screen: one showing work under way is settled with how it went; any can be taken away. */
export interface ToastHandle {
  settle(text: string, kind: ToastOutcome): void
  close(): void
}
export interface Toast {
  readonly id: number
  readonly kind: Kind
  readonly text: string
  readonly action?: ToastAction
}
type Push = (text: string, kind?: Kind, action?: ToastAction, options?: ToastOptions) => ToastHandle

/** How many toasts show at once; an older one gives way to a new one. */
const MAX_TOASTS = 4

/**
 * The toasts with one more. A plain message already on screen (a retried request, a poll) is not stacked again; work
 * under way and toasts given their own time are each their own.
 */
export function withToast(list: readonly Toast[], toast: Toast, merge: boolean): readonly Toast[] {
  if (merge && list.some((x) => x.text === toast.text && x.kind === toast.kind)) return list
  return [...list.slice(-(MAX_TOASTS - 1)), toast]
}

/** The toasts with one settled into how its work went; one dismissed meanwhile comes back, since the outcome is news. */
export function settled(
  list: readonly Toast[],
  id: number,
  text: string,
  kind: ToastOutcome,
): readonly Toast[] {
  if (!list.some((x) => x.id === id)) return withToast(list, { id, kind, text }, false)
  return list.map((x) => (x.id === id ? { id, kind, text } : x))
}

const ToastContext = createContext<Push>(() => ({ settle: () => {}, close: () => {} }))

/** Shows a toast. */
export function useToast(): (...args: Parameters<Push>) => void {
  return useContext(ToastContext)
}

/** Shows a toast and keeps hold of it: to settle work under way with how it went, or to take it away early. */
export function useToastHandle(): Push {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])
  const leaveAfter = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id))
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      )
    },
    [dismiss],
  )
  const push = useCallback<Push>(
    (text, kind = 'info', action, options) => {
      const id = Date.now() + Math.random()
      const merge = kind !== 'progress' && options?.ms === undefined
      setToasts((t) => withToast(t, { id, kind, text, ...(action ? { action } : {}) }, merge))
      if (kind !== 'progress')
        leaveAfter(
          id,
          options?.ms ?? (action ? TOAST_MS.action : kind === 'error' ? TOAST_MS.error : TOAST_MS.info),
        )
      return {
        settle: (next, outcome) => {
          setToasts((t) => settled(t, id, next, outcome))
          leaveAfter(id, outcome === 'error' ? TOAST_MS.error : TOAST_MS.info)
        },
        close: () => dismiss(id),
      }
    },
    [dismiss, leaveAfter],
  )
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[80] flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-2"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon =
              t.kind === 'error'
                ? CircleAlert
                : t.kind === 'success'
                  ? CircleCheck
                  : t.kind === 'progress'
                    ? LoaderCircle
                    : Info
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 40, transition: fade }}
                transition={spring}
                role={t.kind === 'error' ? 'alert' : 'status'}
                aria-busy={t.kind === 'progress' || undefined}
                className="glass pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line px-3.5 py-3 text-reading shadow-pop"
              >
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    t.kind === 'error'
                      ? 'text-bad-ink'
                      : t.kind === 'success'
                        ? 'text-ok-ink'
                        : 'text-accent-fg',
                    t.kind === 'progress' && 'animate-spin',
                  )}
                />
                <span className="flex-1">{t.text}</span>
                {t.action && (
                  <button
                    type="button"
                    className="-my-1 shrink-0 rounded-md bg-accent px-2.5 py-1 text-small font-medium text-on-accent transition-colors hover:brightness-110"
                    title={t.action.title}
                    onClick={() => {
                      t.action?.run()
                      dismiss(t.id)
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
                <button
                  type="button"
                  className="-my-1 -mr-1.5 grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-fill hover:text-fg"
                  onClick={() => dismiss(t.id)}
                  aria-label={copy.common.dismiss}
                >
                  <X className="size-4" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
