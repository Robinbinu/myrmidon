import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { copy } from '../copy.ts'
import { fade, spring, TOAST_MS } from '../ui-config.ts'
import { cn } from './primitives.tsx'

type Kind = 'info' | 'success' | 'error'
/** A button on a toast, e.g. Approve on "Bob wants to talk to your crew". */
export interface ToastAction {
  readonly label: string
  run(): void
}
interface Toast {
  readonly id: number
  readonly kind: Kind
  readonly text: string
  readonly action?: ToastAction
}

const ToastContext = createContext<(text: string, kind?: Kind, action?: ToastAction) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (text: string, kind: Kind = 'info', action?: ToastAction) => {
      const id = Date.now() + Math.random()
      // A message already on screen (a retried request, a poll) is not stacked again.
      setToasts((t) =>
        t.some((x) => x.text === text && x.kind === kind)
          ? t
          : [...t.slice(-3), { id, kind, text, ...(action ? { action } : {}) }],
      )
      setTimeout(
        () => dismiss(id),
        action ? TOAST_MS.action : kind === 'error' ? TOAST_MS.error : TOAST_MS.info,
      )
    },
    [dismiss],
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
            const Icon = t.kind === 'error' ? CircleAlert : t.kind === 'success' ? CircleCheck : Info
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 40, transition: fade }}
                transition={spring}
                role={t.kind === 'error' ? 'alert' : 'status'}
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
                  )}
                />
                <span className="flex-1">{t.text}</span>
                {t.action && (
                  <button
                    type="button"
                    className="-my-1 shrink-0 rounded-md bg-accent px-2.5 py-1 text-small font-medium text-on-accent transition-colors hover:brightness-110"
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
