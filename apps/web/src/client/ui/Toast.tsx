import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { cn, spring } from './primitives.tsx'

type Kind = 'info' | 'success' | 'error'
interface Toast {
  readonly id: number
  readonly kind: Kind
  readonly text: string
}

const ToastContext = createContext<(text: string, kind?: Kind) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (text: string, kind: Kind = 'info') => {
      const id = Date.now() + Math.random()
      setToasts((t) => [...t.slice(-3), { id, kind, text }])
      setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500)
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
                exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
                transition={spring}
                role={t.kind === 'error' ? 'alert' : 'status'}
                className="glass pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line px-3.5 py-3 text-[13.5px] shadow-pop"
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
                <button
                  type="button"
                  className="text-muted transition-colors hover:text-fg"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
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
