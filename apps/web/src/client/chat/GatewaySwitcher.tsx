import { ChevronDown, Laptop } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { activeGateway, GATEWAYS_CHANGED, type GatewayInfo, listGateways, switchGateway } from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { MenuItem, MenuSeparator, Popover } from '../ui/Popover.tsx'
import { isMac } from '../ui/platform.ts'
import { cn, Dot } from '../ui/primitives.tsx'
import { GATEWAY_POLL_MS } from '../ui-config.ts'

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
  if (!list || (list.length === 0 && !active)) return null

  const local = t.local(isMac)
  const current = list.find((g) => g.id === active)
  const pick = (id: string | undefined) => {
    setOpen(false)
    if (id !== active) switchGateway(id)
  }
  const item = (props: {
    id?: string
    name: string
    detail: string
    ok?: boolean
    icon: typeof FEATURE_ICONS.gateway
  }) => (
    <MenuItem
      key={props.id ?? 'local'}
      checked={props.id === active}
      onSelect={() => pick(props.id)}
      icon={<props.icon className="size-4 shrink-0 text-muted" />}
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{props.name}</span>
          {props.ok !== undefined && <Dot tone={props.ok ? 'ok' : 'bad'} />}
        </span>
      }
      detail={props.detail}
    />
  )

  return (
    <div ref={box} className="relative px-2.5 pb-1.5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        // Named by the gateway it shows; what it does is its tooltip and description.
        title={t.switcher}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-base border border-line px-2.5 text-callout font-medium text-fg-2 transition-colors hover:bg-fill',
          open && 'bg-fill text-fg',
        )}
      >
        {current ? (
          <FEATURE_ICONS.gateway className="size-3.5 shrink-0" />
        ) : (
          <Laptop className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? local}</span>
        {current && <Dot tone={current.health.ok ? 'ok' : 'bad'} />}
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </button>
      <AnimatePresence>
        {open && (
          <Popover
            role="menu"
            label={t.switcher}
            onClose={() => setOpen(false)}
            within={box}
            className="material-menu absolute left-2.5 z-40 right-2.5 top-[calc(100%-2px)] origin-top rounded-lg border border-line p-1.5"
          >
            {item({ name: local, detail: location.host, icon: Laptop })}
            {list.map((g) =>
              item({
                id: g.id,
                name: g.name,
                detail: g.health.ok ? new URL(g.url).host : (g.health.error ?? t.unreachable),
                ok: g.health.ok,
                icon: FEATURE_ICONS.gateway,
              }),
            )}
            <MenuSeparator />
            <MenuItem
              icon={<FEATURE_ICONS.gateways className="size-4 shrink-0 text-muted" />}
              title={t.manage}
              onSelect={() => {
                setOpen(false)
                props.onManage()
              }}
            />
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}
