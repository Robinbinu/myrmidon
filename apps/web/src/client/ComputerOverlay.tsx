import { motion, useReducedMotionConfig } from 'motion/react'
import { useEffect, useState } from 'react'
import { api } from './api.ts'
import { copy } from './copy.ts'
import { CrewCursor } from './ui/cursor.tsx'
import { FEATURE_ICONS } from './ui/icons.ts'
import { agentColor } from './ui/pixel.tsx'
import { COMPUTER_OVERLAY, COMPUTER_OVERLAY_POLL_MS } from './ui-config.ts'

const t = copy.computerUse

/** Where an agent last acted on the screen (GET /api/computer/pointers), in screen points. */
export interface ScreenPointer {
  colonyId: string
  agent: string
  x: number
  y: number
  action: 'move' | 'click' | 'type' | 'scroll' | 'drag'
  at: number
}

interface Pointers {
  controls: { colonyId: string; agent: string; app: string }[]
  pointers: ScreenPointer[]
}

/** A display's rectangle in screen points. */
export interface Area {
  x: number
  y: number
  width: number
  height: number
}

/** The pointers on one display, moved into its own coordinates. */
export function pointersOn(area: Area, pointers: readonly ScreenPointer[]): ScreenPointer[] {
  return pointers
    .filter((p) => p.x >= area.x && p.y >= area.y && p.x < area.x + area.width && p.y < area.y + area.height)
    .map((p) => ({ ...p, x: p.x - area.x, y: p.y - area.y }))
}

/**
 * The desktop app's see-through, click-through window over each display while an agent drives the Mac: a glow round
 * the screen's edge, each agent's cursor with its name where it last acted (the driver acts without moving the
 * person's own pointer), and on the main display who is doing what and that Esc stops it.
 */
export function ComputerOverlay() {
  const reduce = useReducedMotionConfig()
  const [state, setState] = useState<Pointers>({ controls: [], pointers: [] })
  const [area, setArea] = useState<Area>(() => screenArea())
  useEffect(() => {
    // A window that shows the page underneath: nothing of the app's own background.
    for (const el of [document.documentElement, document.body]) el.style.background = 'transparent'
    let live = true
    const tick = () =>
      api<Pointers>('/api/computer/pointers').then(
        (s) => live && setState(s),
        // The server going away ends computer use too; the desktop app closes this window.
        () => live && setState({ controls: [], pointers: [] }),
      )
    void tick()
    const timer = setInterval(() => {
      setArea(screenArea())
      void tick()
    }, COMPUTER_OVERLAY_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  if (!state.controls.length) return null
  const first = state.controls[0]
  const main = area.x === 0 && area.y === 0
  const now = Date.now()
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
      <motion.div
        className="absolute inset-0"
        style={{ boxShadow: COMPUTER_OVERLAY.glow, borderRadius: COMPUTER_OVERLAY.radius }}
        initial={{ opacity: 0 }}
        animate={reduce ? { opacity: 1 } : { opacity: [0.65, 1, 0.65] }}
        transition={reduce ? { duration: 0.3 } : { duration: COMPUTER_OVERLAY.breatheS, repeat: Infinity }}
      />
      {main && first && (
        <div
          className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-warn/40 bg-warn-soft px-3 py-1 text-body font-medium text-warn-ink shadow-lg backdrop-blur-md"
          style={{ top: COMPUTER_OVERLAY.labelTop }}
        >
          <FEATURE_ICONS.computerUse className="size-4 shrink-0" />
          {state.controls.length > 1 ? t.bannerMany(state.controls.length) : t.banner(first.agent, first.app)}
          <span className="font-normal opacity-80">{t.escHint}</span>
        </div>
      )}
      {pointersOn(area, state.pointers).map((p) => (
        <CrewCursor
          key={`${p.colonyId}/${p.agent}`}
          name={p.agent}
          color={agentColor(p.agent)}
          x={p.x}
          y={p.y}
          clicking={p.action === 'click' && now - p.at < COMPUTER_OVERLAY.clickShowMs}
        />
      ))}
    </div>
  )
}

/** This window's display: the desktop app opens one overlay window per display, the size of that display. */
function screenArea(): Area {
  return { x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight }
}
