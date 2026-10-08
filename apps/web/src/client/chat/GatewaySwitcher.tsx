import { Check, ChevronDown, Laptop, Server, Settings2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { activeGateway, GATEWAYS_CHANGED, type GatewayInfo, listGateways, switchGateway } from '../api.ts'
import { copy } from '../copy.ts'
import { isMac } from '../ui/platform.ts'
import { cn } from '../ui/primitives.tsx'
import { GATEWAY_POLL_MS, spring } from '../ui-config.ts'

/** The gateways this machine knows, checked again every so often; undefined until the first answer. */
export function useGateways(): GatewayInfo[] | undefined {
  const [list, setList] = useState<GatewayInfo[]>()
  useEffect(() => {
    let alive = true
    const load = () =>
      listGateways()
        .then((l) => alive && setList(l))
        // A chats-only device cannot list gateways; it simply sees no switcher.
        .catch(() => alive && setList([]))
    void load()
    const timer = setInterval(load, GATEWAY_POLL_MS)
    window.addEventListener(GATEWAYS_CHANGED, load)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener(GATEWAYS_CHANGED, load)
    }
  }, [])
  return list
}

function HealthDot(props: { ok: boolean }) {
  return <span className={cn('inline-flex size-2 shrink-0 rounded-full', props.ok ? 'bg-ok' : 'bg-bad')} />
}

/**
 * Which gateway this window shows: this machine, or another Myrmidon it reaches (a VPS, a home server). Hidden until
 * there is another to switch to.
 */
export function GatewaySwitcher(props: { onManage(): void }) {
  const t = copy.gateways
  const list = useGateways()
  const active = activeGateway()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (!list || (list.length === 0 && !active)) return null

  const local = t.local(isMac)
  const current = list.find((g) => g.id === active)
  const pick = (id: string | undefined) => {
    setOpen(false)
    if (id !== active) switchGateway(id)
  }
  const item = (props: { id?: string; name: string; detail: string; ok?: boolean; icon: typeof Server }) => (
    <button
      key={props.id ?? 'local'}
      type="button"
      role="menuitemradio"
      aria-checked={props.id === active}
      onClick={() => pick(props.id)}
      className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-fill"
    >
      <props.icon className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <span className="truncate">{props.name}</span>
          {props.ok !== undefined && <HealthDot ok={props.ok} />}
        </span>
        <span className="block truncate text-[11.5px] text-muted">{props.detail}</span>
      </span>
      {props.id === active && <Check className="size-4 shrink-0 text-accent-fg" />}
    </button>
  )

  return (
    <div ref={box} className="relative px-2.5 pb-1.5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.switcher}
        title={t.switcher}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-[9px] border border-line px-2.5 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-fill',
          open && 'bg-fill text-fg',
        )}
      >
        {current ? <Server className="size-3.5 shrink-0" /> : <Laptop className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? local}</span>
        {current && <HealthDot ok={current.health.ok} />}
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1 } }}
            transition={spring}
            className="material-menu absolute left-2.5 right-2.5 top-[calc(100%-2px)] z-40 origin-top rounded-[14px] border border-line p-1.5"
          >
            {item({ name: local, detail: location.host, icon: Laptop })}
            {list.map((g) =>
              item({
                id: g.id,
                name: g.name,
                detail: g.health.ok ? new URL(g.url).host : (g.health.error ?? t.unreachable),
                ok: g.health.ok,
                icon: Server,
              }),
            )}
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                props.onManage()
              }}
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[13px] text-fg-2 transition-colors hover:bg-fill"
            >
              <Settings2 className="size-4 shrink-0 text-muted" />
              {t.manage}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
