import {
  Camera as CameraIcon,
  Check,
  FileCode,
  GitBranch,
  LoaderCircle,
  MousePointerClick,
  NotebookText,
  Sparkles,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { clamp, EASES, lerp, quad, sp, SPRING, track, tween, typed } from '../anim.ts'
import { MotionBlur } from '../components/World.tsx'
import { ConversionChart } from '../components/Chart.tsx'
import { CrewCursor, MailPill, type Stop, TASK_CARD_H, TaskCard } from '../components/Crew.tsx'
import { ICON, SectionLabel, type Status, StatusPill, STROKE, Surface, Window } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { RADIUS, SAFE, SPACE, SURFACE } from '../design.ts'
import { BEAT, WORLD } from '../timeline.ts'
import { C, CREW, type CrewName } from '../theme.ts'
import { ORDER, planRow } from './App.tsx'

const P = WORLD.panels
const PAD = SPACE[4]
const SUB_Y = PAD + TASK_CARD_H + SPACE[3]
const SUB_H = 40
const BODY_Y = SUB_Y + SUB_H + SPACE[3]
export const BODY = { w: P.w - PAD * 2, h: P.h - BODY_Y - PAD }
const LINE = 28.8
/** Frames a panel takes to fold back into its task card. */
export const FOLD = 36

export const panelLeft = (i: number) => (P.cx[i] ?? 0) - P.w / 2
/** World top-left of panel `i`'s header card: where the plan's cards land, and where the board's cards leave from. */
export const headerAt = (i: number) => ({ x: panelLeft(i) + PAD, y: P.top + PAD })
const bodyAt = (i: number) => ({ x: panelLeft(i) + PAD, y: P.top + BODY_Y })

/* ------------------------------------------------------------------ the plan's cards fly out to the panels */

const FLY = 52
const flyStart = (i: number) => BEAT.spawn + 12 + i * 6
export const landAt = (i: number) => flyStart(i) + FLY

function cardFlight(i: number, f: number) {
  const a = planRow(i)
  const b = headerAt(i)
  const dip = tween(f, BEAT.spawn, BEAT.spawn + 12, 0, 1, EASES.out) * 10
  const t = tween(f, flyStart(i), landAt(i), 0, 1, EASES.inOut)
  const [x, y] = quad(t, [a.x, a.y + dip], [lerp(a.x, b.x, 0.5), Math.min(a.y, b.y) - 140], [b.x, b.y])
  return { x, y, t, scale: 1 + Math.sin(t * Math.PI) * 0.05 }
}

function FlyingCards() {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill>
      {ORDER.map((who, i) => {
        const s = cardFlight(i, f)
        if (f >= landAt(i)) return null
        return (
          <div key={who} data-cover={`spawn-${who}`} style={{ position: 'absolute', left: s.x, top: s.y, transform: `scale(${s.scale})` }}>
            <TaskCard who={who} width={BODY.w} status="queued" frame={f} />
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

/** Beat 4B: the three task cards leave the lead's plan, each to become the header of its agent's panel. */
export function SpawnFlight(props: { f: number }) {
  const f = props.f
  if (f < BEAT.spawn || f >= landAt(2)) return null
  if (f < flyStart(0))
    return (
      <>
        {ORDER.map((who, i) => {
          const s = cardFlight(i, f)
          return (
            <div key={who} style={{ position: 'absolute', left: s.x, top: s.y }}>
              <TaskCard who={who} width={BODY.w} status="queued" frame={f} />
            </div>
          )
        })}
      </>
    )
  return (
    <MotionBlur samples={6}>
        <FlyingCards />
      </MotionBlur>
  )
}

/* ------------------------------------------------------------------ the panels */

/** How much panel `i` is the one the camera is looking at (1) or out of focus beside it (0). */
function focus(i: number, f: number): number {
  const keys = [
    [
      { f: 1540, v: 1 },
      { f: 1765, v: 1 },
      { f: 1800, v: 0 },
      { f: BEAT.together + 5, v: 0 },
      { f: BEAT.together + 40, v: 1 },
    ],
    [
      { f: 1540, v: 1 },
      { f: 1575, v: 0 },
      { f: 1765, v: 0 },
      { f: 1800, v: 1 },
      { f: 1965, v: 1 },
      { f: 2000, v: 0 },
      { f: BEAT.together + 5, v: 0 },
      { f: BEAT.together + 40, v: 1 },
    ],
    [
      { f: 1540, v: 1 },
      { f: 1575, v: 0 },
      { f: 1965, v: 0 },
      { f: 2000, v: 1 },
    ],
  ][i]
  return keys ? track(f, keys) : 1
}

const DONE: Record<CrewName, number> = { nova: 1745, iris: 1925, quill: 2140 }

function status(who: CrewName, f: number, i: number): Status {
  if (f < landAt(i) + 14) return 'queued'
  return f >= DONE[who] ? 'done' : 'working'
}

/** The bar under a panel's task card: what the agent is driving, and what it is doing with it. */
function SubBar(props: { icon: ReactNode; title: string; mono?: boolean; pill: ReactNode }) {
  return (
    <div style={{ position: 'absolute', left: PAD, top: SUB_Y, width: BODY.w, height: SUB_H, display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
      {props.icon}
      <T role="body" weight="medium" mono={props.mono} color={C.label2} fit={280}>
        {props.title}
      </T>
      <div style={{ flex: 1 }} />
      {props.pill}
    </div>
  )
}

function Pill(props: { children: string; tone?: 'work' | 'warn' | 'ok'; icon?: ReactNode }) {
  const fg = props.tone === 'ok' ? C.ok : props.tone === 'warn' ? C.warn : C.accent
  const bg = props.tone === 'ok' ? C.okSoft : props.tone === 'warn' ? C.warnSoft : C.accentSoft
  return (
    <span data-box="" style={{ display: 'inline-flex', alignItems: 'center', gap: SPACE[1] + 2, height: 28, padding: `0 ${SPACE[2] + 2}px`, borderRadius: RADIUS.sm, background: bg, color: fg, flexShrink: 0 }}>
      {props.icon}
      <T role="label" color={fg}>
        {props.children}
      </T>
    </span>
  )
}

const spin = (f: number) => ({ transform: `rotate(${f * 7}deg)` })

/** A code block in the film's editor style: gutter numbers, mono lines, optional per-line tint. */
function Code(props: { lines: { n?: number; text: string; tint?: string; mark?: string }[]; width: number; gutter?: boolean }) {
  return (
    <div data-box="" style={{ width: props.width, padding: `${SPACE[2]}px 0`, borderRadius: RADIUS.md, background: SURFACE.inset, boxShadow: `inset 0 0 0 1px ${C.separator}` }}>
      {props.lines.map((l, i) => (
        <div key={`${i}-${l.text}`} style={{ display: 'flex', alignItems: 'center', height: LINE, background: l.tint, paddingRight: SPACE[3] }}>
          {props.gutter !== false && (
            <span style={{ width: 44, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: SPACE[1], paddingRight: SPACE[3], flexShrink: 0 }}>
              {l.mark && <span style={{ width: 10, height: 10, borderRadius: RADIUS.pill, background: l.mark, boxShadow: `0 0 8px ${l.mark}` }} />}
              <T role="mono" color={C.label4}>
                {l.n === undefined ? '' : String(l.n)}
              </T>
            </span>
          )}
          <T role="mono" color={C.termText} style={{ whiteSpace: 'pre', paddingLeft: props.gutter === false ? SPACE[3] : 0 }}>
            {l.text}
          </T>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------- nova: the notebook */

const SQL = ['SELECT device, currency,', '  conv_rate(ts) AS rate', 'FROM checkout_events', 'GROUP BY 1, 2']
const SEGMENTS: [string, number, number][] = [
  ['desktop · USD', 3.9, 3.8],
  ['desktop · EUR', 3.7, 3.6],
  ['mobile · USD', 3.1, 3.0],
  ['mobile · EUR', 3.4, 0.6],
]

function CellHead(props: { n: number; lang: string; state: 'idle' | 'running' | 'done'; f: number; result?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], height: 32 }}>
      <T role="label" mono color={C.label4}>
        {`[${props.n}]`}
      </T>
      <T role="label" mono color={C.label3}>
        {props.lang}
      </T>
      <div style={{ flex: 1 }} />
      {props.state === 'running' && <LoaderCircle size={16} strokeWidth={2} color={C.accent} style={spin(props.f)} />}
      {props.state === 'done' && (
        <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[1], color: C.ok }}>
          <Check size={16} strokeWidth={2.4} />
          <T role="label" mono color={C.ok}>
            {props.result ?? ''}
          </T>
        </span>
      )}
    </div>
  )
}

function Notebook(props: { f: number }) {
  const f = props.f
  const n = typed(SQL.join('\n'), f, 1552, 46)
  const lines = n.split('\n')
  const ran = f >= 1606
  const scroll = track(f, [
    { f: 1680, v: 0 },
    { f: 1728, v: -118, ease: EASES.inOut },
  ])
  const py = typed('plot(rate, by="hour", where=seg)', f, 1664, 60)
  const plotted = f >= 1682
  const insight = sp(f, 1738, SPRING.pop)
  return (
    <div data-scroll="" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: scroll, width: BODY.w, display: 'flex', flexDirection: 'column', gap: SPACE[3] }}>
        <div>
          <CellHead n={1} lang="sql" state={ran ? 'done' : f > 1592 ? 'running' : 'idle'} f={f} result="0.8s · 1.2M rows" />
          <Code width={BODY.w} lines={SQL.map((_, i) => ({ n: i + 1, text: lines[i] ?? '' }))} />
        </div>
        <div data-box="" style={{ borderRadius: RADIUS.md, background: SURFACE.card, boxShadow: `inset 0 0 0 1px ${C.separator}`, padding: `${SPACE[1]}px ${SPACE[3]}px`, opacity: ran ? 1 : 0 }}>
          <div style={{ display: 'flex', height: 30, alignItems: 'center' }}>
            <T role="label" mono color={C.label4} style={{ width: 230 }}>
              segment
            </T>
            <T role="label" mono color={C.label4} style={{ width: 100 }}>
              before
            </T>
            <T role="label" mono color={C.label4}>
              after
            </T>
          </div>
          {SEGMENTS.map(([name, before, after], i) => {
            const t = sp(f, 1610 + i * 7, SPRING.smooth)
            const hot = i === 3 && f >= 1650
            const count = tween(f, 1612 + i * 7, 1640 + i * 7, 0, 1, EASES.out)
            return (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 36,
                  margin: `0 -${SPACE[3]}px`,
                  padding: `0 ${SPACE[3]}px`,
                  borderRadius: RADIUS.sm,
                  background: hot ? C.badSoft : undefined,
                  boxShadow: hot ? `inset 0 0 0 1px rgba(255,99,105,${0.5 * tween(f, 1650, 1660)})` : undefined,
                  opacity: t,
                  transform: `translateX(${(1 - t) * 12}px)`,
                }}
              >
                <T role="mono" color={hot ? C.label : C.label2} style={{ width: 230 }}>
                  {name}
                </T>
                <T role="mono" color={C.label3} style={{ width: 100 }}>
                  {`${(before * count).toFixed(1)}%`}
                </T>
                <T role="mono" weight={hot ? 'semibold' : 'regular'} color={hot ? C.bad : C.label2}>
                  {`${lerp(before, after, count).toFixed(1)}%`}
                </T>
              </div>
            )
          })}
        </div>
        <div style={{ opacity: tween(f, 1658, 1668) }}>
          <CellHead n={2} lang="python" state={plotted ? 'done' : f > 1676 ? 'running' : 'idle'} f={f} result="chart" />
          <Code width={BODY.w} lines={[{ n: 1, text: py }]} />
          <div data-box="" style={{ marginTop: SPACE[2], padding: SPACE[3], borderRadius: RADIUS.md, background: SURFACE.inset, boxShadow: `inset 0 0 0 1px ${C.separator}` }}>
            <ConversionChart width={BODY.w - SPACE[3] * 2} height={124} draw={tween(f, 1684, 1722, 0, 1, EASES.inOut)} marker={tween(f, 1716, 1736, 0, 1, EASES.out)} />
          </div>
        </div>
        <div
          data-box=""
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: SPACE[3],
            height: 56,
            padding: `0 ${SPACE[4]}px`,
            borderRadius: RADIUS.lg,
            background: C.accentSoft,
            boxShadow: `inset 0 0 0 1px rgba(255,179,26,0.4), 0 0 ${30 * insight}px rgba(255,179,26,0.25)`,
            opacity: clamp(insight * 1.5, 0, 1),
            transform: `scale(${lerp(0.9, 1, insight)})`,
          }}
        >
          <Sparkles size={ICON.sm} strokeWidth={STROKE} color={C.accent} />
          <T role="body" weight="semibold" color={C.accent} fit={BODY.w - 80}>
            mobile · EUR · since the 21:40 deploy
          </T>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------- iris: the Mac */

const STEPS: { at: number; text: string; bad?: boolean }[] = [
  { at: 1776, text: 'open checkout' },
  { at: 1792, text: 'viewport 390×844' },
  { at: 1812, text: 'tap Pay €49.99' },
  { at: 1840, text: 'amount mismatch', bad: true },
  { at: 1912, text: 'screenshot saved' },
]
const BROWSER = { x: 20, y: 64, w: 250, h: 470 }
const PAY_CLICK = 1810
const FLASH = 1888

function Checkout(props: { f: number }) {
  const f = props.f
  const busy = f >= PAY_CLICK + 2 && f < 1836
  const failed = f >= 1836
  const toast = sp(f, 1836, SPRING.pop)
  const press = tween(f, PAY_CLICK - 3, PAY_CLICK) * (1 - tween(f, PAY_CLICK, PAY_CLICK + 8))
  const inner = BROWSER.w - SPACE[4] * 2
  return (
    <div style={{ position: 'absolute', inset: 0, padding: SPACE[4], display: 'flex', flexDirection: 'column', gap: SPACE[3], background: '#f5f5f7' }}>
      <T role="heading" color="#1d1d1f">
        Checkout
      </T>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <T role="label" color="#424245">
          Pro plan
        </T>
        <T role="label" weight="semibold" color="#1d1d1f">
          €49.99
        </T>
      </div>
      <div data-box="" style={{ height: 44, borderRadius: RADIUS.md, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', padding: `0 ${SPACE[3]}px` }}>
        <T role="label" mono color="#424245">
          •••• 4242
        </T>
      </div>
      <div
        data-box=""
        style={{
          height: 52,
          borderRadius: RADIUS.md,
          background: failed ? '#c9c9ce' : C.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: SPACE[2],
          transform: `scale(${1 - press * 0.05})`,
        }}
      >
        {busy && <LoaderCircle size={18} strokeWidth={2.2} color={C.onAccent} style={spin(f)} />}
        <T role="body" weight="semibold" color={C.onAccent}>
          Pay €49.99
        </T>
      </div>
      {failed && (
        <div
          data-box=""
          style={{
            width: inner,
            boxSizing: 'border-box',
            padding: `${SPACE[2]}px ${SPACE[3]}px`,
            borderRadius: RADIUS.md,
            background: '#fdecec',
            boxShadow: 'inset 0 0 0 1px rgba(215,0,21,0.3)',
            display: 'flex',
            gap: SPACE[2],
            alignItems: 'flex-start',
            opacity: toast,
            transform: `translateY(${(1 - toast) * 10}px)`,
          }}
        >
          <X size={16} strokeWidth={2.4} color="#d70015" style={{ marginTop: 3, flexShrink: 0 }} />
          <T role="label" wrap color="#d70015" style={{ width: inner - 48 }}>
            Payment failed: amount mismatch
          </T>
        </div>
      )}
    </div>
  )
}

function Computer(props: { f: number }) {
  const f = props.f
  const on = tween(f, 1764, 1780)
  const breathe = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin((f / 60) * ((2 * Math.PI) / 3.2)))
  const glow = on * breathe
  const flash = f >= FLASH ? Math.exp(-(f - FLASH) / 6) : 0
  const thumb = tween(f, FLASH + 4, FLASH + 26, 0, 1, EASES.inOut)
  const stepsX = BROWSER.x + BROWSER.w + SPACE[4]
  const stepsW = BODY.w - stepsX - SPACE[3]
  return (
    <div
      data-box=""
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 10,
        overflow: 'hidden',
        background: 'radial-gradient(120% 90% at 30% 0%, #1b2233 0%, #0d1018 70%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: BROWSER.x,
          top: BROWSER.y,
          transform: `scale(${1 - flash * 0.02})`,
        }}
      >
        <Window width={BROWSER.w} height={BROWSER.h} bar={40} title={<T role="label" mono color={C.label3} fit={140}>acme.dev/checkout</T>}>
          <Checkout f={f} />
          <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: flash * 0.7 }} />
        </Window>
      </div>
      <div style={{ position: 'absolute', left: stepsX, top: BROWSER.y, width: stepsW, display: 'flex', flexDirection: 'column', gap: SPACE[2] }}>
        <SectionLabel>Steps</SectionLabel>
        {STEPS.map((s) => {
          const t = sp(f, s.at, SPRING.smooth)
          if (f < s.at) return null
          return (
            <div key={s.text} style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], height: 28, opacity: t, transform: `translateX(${(1 - t) * 10}px)` }}>
              {s.bad ? <X size={16} strokeWidth={2.4} color={C.bad} /> : s.text.startsWith('screenshot') ? <CameraIcon size={16} strokeWidth={2} color={C.ok} /> : <Check size={16} strokeWidth={2.4} color={C.ok} />}
              <T role="label" mono color={s.bad ? C.bad : C.label2} fit={stepsW - 28}>
                {s.text}
              </T>
            </div>
          )
        })}
        {f >= FLASH + 4 && (
          <div
            style={{
              marginTop: SPACE[2],
              width: 96,
              height: 180,
              borderRadius: RADIUS.sm,
              background: '#f5f5f7',
              boxShadow: `0 0 0 2px ${C.ok}, 0 10px 30px -10px rgba(0,0,0,0.8)`,
              transform: `translate(${(1 - thumb) * -150}px, ${(1 - thumb) * 40}px) scale(${lerp(2.4, 1, thumb)})`,
              transformOrigin: '0 0',
              opacity: tween(f, FLASH + 4, FLASH + 10),
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div style={{ position: 'absolute', left: 8, right: 8, top: 74, height: 14, borderRadius: 3, background: '#c9c9ce' }} />
            <div style={{ position: 'absolute', left: 8, right: 8, top: 96, height: 18, borderRadius: 3, background: '#fdecec', boxShadow: 'inset 0 0 0 1px rgba(215,0,21,0.4)' }} />
          </div>
        )}
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 10,
          pointerEvents: 'none',
          boxShadow: `inset 0 0 0 3px rgba(255,138,76,${0.9 * glow}), inset 0 0 24px 6px rgba(255,138,76,${0.6 * glow}), inset 0 0 90px 24px rgba(255,138,76,${0.25 * glow})`,
        }}
      />
    </div>
  )
}

/* -------------------------------- quill: the debugger */

function Debugger(props: { f: number }) {
  const f = props.f
  const paused = f >= 1972 && f < 2046
  const fixed = f >= 2040
  const amount = sp(f, 2004, SPRING.pop)
  const testRun = f >= 2076
  const passed = Math.round(tween(f, 2088, 2128, 0, 412, EASES.out))
  const code: { n?: number; text: string; tint?: string; mark?: string }[] = [
    { n: 12, text: 'function toCents(eur: number) {' },
    { n: 13, text: '  const amount = eur * 100' },
    fixed
      ? { n: 14, text: '- return Math.floor(amount)', tint: C.del }
      : { n: 14, text: '  return Math.floor(amount)', tint: paused ? 'rgba(255,138,76,0.16)' : undefined, mark: f >= 1972 ? C.bad : undefined },
    ...(fixed ? [{ n: 15, text: typed('+ return Math.round(amount)', f, 2040, 70), tint: C.add }] : []),
    { n: fixed ? 16 : 15, text: '}' },
  ]
  const vars: [string, string, string?][] = [
    ['eur', '49.99'],
    ['amount', '4998.999999999999', C.accent],
    ['toCents', fixed ? '4999' : '4998', fixed ? C.ok : C.bad],
  ]
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: SPACE[3] }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], height: 36 }}>
          <FileCode size={16} strokeWidth={2} color={C.label3} />
          <T role="label" mono color={C.label2}>
            checkout/currency.ts
          </T>
          <div style={{ flex: 1 }} />
          {paused && <Pill tone="warn">paused on breakpoint</Pill>}
          {fixed && (
            <T role="label" mono color={C.label3}>
              +1 −1
            </T>
          )}
        </div>
        <Code width={BODY.w} lines={code} />
      </div>
      <div data-box="" style={{ padding: `${SPACE[2]}px ${SPACE[3]}px`, borderRadius: RADIUS.md, background: SURFACE.card, boxShadow: `inset 0 0 0 1px ${C.separator}`, opacity: tween(f, 1990, 2002) }}>
        <div style={{ height: 30, display: 'flex', alignItems: 'center' }}>
          <SectionLabel>Variables</SectionLabel>
        </div>
        {vars.map(([k, v, color]) => (
          <div
            key={k}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 32,
              margin: `0 -${SPACE[3]}px`,
              padding: `0 ${SPACE[3]}px`,
              background: k === 'amount' ? `rgba(255,179,26,${0.14 * amount})` : undefined,
            }}
          >
            <T role="mono" color={C.label3} style={{ width: 110 }}>
              {k}
            </T>
            <T role="mono" weight={color ? 'semibold' : 'regular'} color={color ?? C.label2}>
              {v}
            </T>
          </div>
        ))}
      </div>
      <div data-box="" style={{ flex: 1, padding: `${SPACE[2]}px ${SPACE[3]}px`, borderRadius: RADIUS.md, background: C.terminal, boxShadow: `inset 0 0 0 1px ${C.separator}`, opacity: tween(f, 2066, 2076) }}>
        <T role="mono" color={C.termGreen} style={{ display: 'block' }}>
          {`$ ${typed('bun test', f, 2068, 30)}`}
        </T>
        {testRun && (
          <>
            {['toCents(49.99) → 4999', 'checkout · EUR · mobile'].map((t, i) =>
              f >= 2082 + i * 6 ? (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], height: LINE }}>
                  <Check size={16} strokeWidth={2.4} color={C.termGreen} />
                  <T role="mono" color={C.termText}>
                    {t}
                  </T>
                </div>
              ) : null,
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[3], height: LINE + 6 }}>
              <T role="mono" weight="semibold" color={C.ok}>
                {`${passed} passed`}
              </T>
              <T role="mono" color={C.label3}>
                0 failed
              </T>
              <div style={{ flex: 1, height: 6, borderRadius: RADIUS.pill, background: C.fill }}>
                <div style={{ width: `${(passed / 412) * 100}%`, height: '100%', borderRadius: RADIUS.pill, background: C.ok }} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* -------------------------------- the panel */

function Panel(props: { who: CrewName; i: number; f: number }) {
  const { who, i, f } = props
  if (f < landAt(i)) return null
  const unfold = tween(f, landAt(i), landAt(i) + 48, 0, 1, EASES.expoOut)
  const fold = tween(f, BEAT.fold, BEAT.fold + FOLD, 0, 1, EASES.inOut)
  const closed = TASK_CARD_H + PAD * 2
  const h = lerp(lerp(closed, P.h, unfold), closed, fold)
  const body = tween(f, landAt(i) + 18, landAt(i) + 40) * (1 - tween(f, BEAT.fold, BEAT.fold + 20))
  const fo = focus(i, f)
  const mail = MAIL[who].filter((at) => f >= at).length
  const working = status(who, f, i) === 'working'
  const c = CREW[who]
  return (
    <div
      style={{
        position: 'absolute',
        left: panelLeft(i),
        top: P.top,
        opacity: lerp(0.42, 1, fo) * tween(f, landAt(i) - 1, landAt(i) + 6),
        filter: fo < 0.98 ? `blur(${(1 - fo) * 4}px)` : undefined,
      }}
    >
      <Surface width={P.w} height={h} radius="xl" tint={working ? `${c.color}55` : undefined}>
        <div style={{ position: 'absolute', left: PAD, top: PAD }}>
          <TaskCard who={who} width={BODY.w} status={status(who, f, i)} frame={f} live={working ? 0.7 + 0.3 * Math.sin(f / 15) : 0} happy={f >= DONE[who]} mail={mail} />
        </div>
        <div style={{ opacity: body }}>
          {who === 'nova' && (
            <SubBar icon={<NotebookText size={ICON.sm} strokeWidth={STROKE} color={C.label2} />} title="nova's notebook" pill={f >= DONE.nova ? <StatusPill status="done" /> : <Pill>querying</Pill>} />
          )}
          {who === 'iris' && (
            <SubBar
              icon={<MousePointerClick size={ICON.sm} strokeWidth={STROKE} color={C.warn} />}
              title="iris is using your Mac"
              pill={<Pill tone="warn">Safari</Pill>}
            />
          )}
          {who === 'quill' && (
            <SubBar icon={<GitBranch size={ICON.sm} strokeWidth={STROKE} color={C.label2} />} title="quill/fix-eur-rounding" mono pill={f >= DONE.quill ? <StatusPill status="done" /> : <Pill>debugging</Pill>} />
          )}
          <div style={{ position: 'absolute', left: PAD, top: BODY_Y, width: BODY.w, height: Math.max(0, h - BODY_Y - PAD), overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: BODY.w, height: BODY.h }}>
              {who === 'nova' && <Notebook f={f} />}
              {who === 'iris' && <Computer f={f} />}
              {who === 'quill' && <Debugger f={f} />}
            </div>
          </div>
        </div>
      </Surface>
    </div>
  )
}

/** Beat 4: the three agents' panels, from the moment their cards land until they fold back into cards. */
export function Panels(props: { f: number }) {
  const f = props.f
  if (f < landAt(0) || f >= BEAT.fold + FOLD) return null
  return (
    <>
      {ORDER.map((who, i) => (
        <Panel key={who} who={who} i={i} f={f} />
      ))}
    </>
  )
}

/* ------------------------------------------------------------------ cursors and mail between the panels */

const nb = bodyAt(0)
const ib = bodyAt(1)
const qb = bodyAt(2)

const CURSORS: { who: CrewName; from: number; to: number; stops: Stop[] }[] = [
  {
    who: 'nova',
    from: 1556,
    to: 1800,
    stops: [
      { f: 1556, x: nb.x + 380, y: nb.y + 260 },
      { f: 1600, x: nb.x + 300, y: nb.y + 120 },
      { f: 1650, x: nb.x + 200, y: nb.y + 345, click: true },
      { f: 1700, x: nb.x + 360, y: nb.y + 420 },
      { f: 1742, x: nb.x + 420, y: nb.y + 520, click: true },
      { f: 1800, x: nb.x + 600, y: nb.y + 560 },
    ],
  },
  {
    who: 'iris',
    from: 1764,
    to: 1990,
    stops: [
      { f: 1764, x: ib.x + 200, y: ib.y + 620 },
      { f: PAY_CLICK, x: ib.x + BROWSER.x + 150, y: ib.y + BROWSER.y + 40 + 222, click: true },
      { f: 1850, x: ib.x + 230, y: ib.y + 430 },
      { f: FLASH, x: ib.x + 330, y: ib.y + 300, click: true },
      { f: 1950, x: ib.x + 400, y: ib.y + 520 },
    ],
  },
  {
    who: 'quill',
    from: 1968,
    to: 2170,
    stops: [
      { f: 1968, x: qb.x + 420, y: qb.y + 180 },
      { f: 2036, x: qb.x + 330, y: qb.y + 58 + LINE * 2.5, click: true },
      { f: 2068, x: qb.x + 240, y: qb.y + 470, click: true },
      { f: 2130, x: qb.x + 420, y: qb.y + 520 },
    ],
  },
]

export function PanelCursors(props: { f: number }) {
  const f = props.f
  return (
    <>
      {CURSORS.map((c) =>
        f >= c.from && f <= c.to ? (
          <CrewCursor
            key={c.who}
            name={c.who}
            color={CREW[c.who].color}
            frame={f}
            stops={c.stops}
            opacity={tween(f, c.from, c.from + 10) * (1 - tween(f, c.to - 12, c.to))}
          />
        ) : null,
      )}
    </>
  )
}

/**
 * Messages between crewmates. Each passes along the mail lane, the band above the panels that the captions leave free
 * between their lines, travelling from the sender's side toward the receiver's, and arrives as the mail badge on the
 * receiver's card. It never crosses the panels themselves.
 */
export const MESSAGES: { from: CrewName; to: CrewName; text: string; at: number; until: number }[] = [
  { from: 'nova', to: 'iris', text: "It's EUR on mobile, since 21:40.", at: 1714, until: 1800 },
  { from: 'iris', to: 'quill', text: "Repro'd: Pay €49.99 fails. Screenshot attached.", at: 1920, until: 1972 },
  { from: 'nova', to: 'quill', text: 'The 21:40 deploy touched currency.ts.', at: 1972, until: 2024 },
]
/** When each card's mail badge counts a new message: as the message leaves the lane. */
const MAIL: Record<CrewName, number[]> = Object.fromEntries(
  ORDER.map((who) => [who, MESSAGES.filter((m) => m.to === who).map((m) => m.until - 8)]),
) as Record<CrewName, number[]>

/** The mail lane, in screen space: one message at a time, sliding in, drifting toward its receiver, and away. */
export function MailLane(props: { f: number }) {
  const f = props.f
  const m = MESSAGES.find((x) => f >= x.at && f < x.until)
  if (!m) return null
  const enter = sp(f, m.at, SPRING.smooth)
  const leave = tween(f, m.until - 16, m.until, 0, 1, EASES.in)
  const drift = tween(f, m.at, m.until - 16, -40, 40, EASES.inOut)
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: SAFE.top,
        height: SAFE.captionBottom - SAFE.top,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: clamp(enter * 1.4, 0, 1) * (1 - leave),
        transform: `translateX(${(1 - enter) * -360 + drift + leave * 360}px)`,
      }}
    >
      <MailPill from={m.from} to={m.to} text={m.text} cover={`mail-${m.at}`} />
    </div>
  )
}

