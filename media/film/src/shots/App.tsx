import { BarChart3, Folder, HeartPulse, LoaderCircle, Moon, Network, Search, Settings, SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'
import { EASES, lerp, sp, SPRING, tween } from '../anim.ts'
import { TASK_CARD_H, TaskCard } from '../components/Crew.tsx'
import { LedScreen, LogoTile } from '../components/Led.tsx'
import { ICON, SectionLabel, StatusPill, STROKE, Surface, Window } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { RADIUS, SPACE } from '../design.ts'
import { BEAT, WORLD } from '../timeline.ts'
import { C, type CrewName } from '../theme.ts'
import { Bubble } from './Ask.tsx'
import { Composer, WordmarkShot } from './Composer.tsx'

/** The crew in panel order, left to right: the data, the repro, the fix. */
export const ORDER: CrewName[] = ['nova', 'iris', 'quill']
const ROW_GAP = SPACE[3]
const PLAN_HEADER = 40
const BAR = 48
export const THREAD = 'Checkout conversion drop'

/** Top-left of plan row `i` in the world: where the task cards leave from when the crew spawns. */
export function planRow(i: number): { x: number; y: number } {
  const p = WORLD.chat.plan
  return { x: p.x + SPACE[4], y: p.y + SPACE[4] + PLAN_HEADER + SPACE[3] + i * (TASK_CARD_H + ROW_GAP) }
}
const PLAN_H = SPACE[4] * 2 + PLAN_HEADER + SPACE[3] + 3 * TASK_CARD_H + 2 * ROW_GAP

/** A sidebar row: an icon or dot, a label, and whatever sits at its end. */
function Row(props: { f: number; at: number; children: ReactNode; active?: boolean }) {
  const t = sp(props.f, props.at, SPRING.smooth)
  return (
    <div
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        gap: SPACE[3],
        padding: `0 ${SPACE[3]}px`,
        borderRadius: RADIUS.md,
        background: props.active ? C.fillStrong : undefined,
        opacity: t,
        transform: `translateX(${(1 - t) * -16}px)`,
      }}
    >
      {props.children}
    </div>
  )
}

/** The app's sidebar, simplified: search, the project, today's chats, and the places at the bottom. */
function Sidebar(props: { f: number }) {
  const f = props.f
  const at = BEAT.dock + 70
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: WORLD.app.sidebar,
        padding: `${SPACE[16] + SPACE[3]}px ${SPACE[3]}px ${SPACE[4]}px`,
        boxSizing: 'border-box',
        boxShadow: `inset -1px 0 0 ${C.separator}`,
        background: C.sidebar,
        display: 'flex',
        flexDirection: 'column',
        gap: SPACE[1],
      }}
    >
      <Row f={f} at={at}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], flex: 1, height: 40, padding: `0 ${SPACE[3]}px`, margin: `0 -${SPACE[3]}px`, borderRadius: RADIUS.md, background: C.fill }}>
          <Search size={ICON.sm} strokeWidth={STROKE} color={C.label3} />
          <T role="body" color={C.label3}>
            Search
          </T>
        </div>
      </Row>
      <div style={{ padding: `${SPACE[4]}px ${SPACE[3]}px ${SPACE[1]}px` }}>
        <T role="label" color={C.label3}>
          Projects
        </T>
      </div>
      <Row f={f} at={at + 4}>
        <Folder size={ICON.sm} strokeWidth={STROKE} color={C.label2} />
        <T role="body" color={C.label2}>
          acme/shop
        </T>
      </Row>
      <div style={{ padding: `${SPACE[4]}px ${SPACE[3]}px ${SPACE[1]}px` }}>
        <T role="label" color={C.label3}>
          Today
        </T>
      </div>
      <Row f={f} at={at + 8} active={f > BEAT.flight + 85}>
        {f > BEAT.flight + 85 ? (
          <LoaderCircle size={ICON.sm} strokeWidth={STROKE} color={C.accent} style={{ transform: `rotate(${f * 6}deg)` }} />
        ) : (
          <span style={{ width: 14, height: 14, borderRadius: RADIUS.pill, boxShadow: `inset 0 0 0 1.5px ${C.label4}` }} />
        )}
        <T role="body" color={C.label} fit={200}>
          {f > BEAT.flight + 85 ? THREAD : 'New chat'}
        </T>
      </Row>
      <Row f={f} at={at + 12}>
        <span style={{ width: 14, height: 14, borderRadius: RADIUS.pill, boxShadow: `inset 0 0 0 1.5px ${C.label4}` }} />
        <T role="body" color={C.label3} fit={200}>
          Weekly sales digest
        </T>
      </Row>
      <div style={{ flex: 1 }} />
      {(
        [
          [Network, 'Crews'],
          [BarChart3, 'Compare crews'],
          [HeartPulse, 'System'],
          [Settings, 'Settings'],
        ] as const
      ).map(([Icon, label], i) => (
        <Row key={label} f={f} at={at + 16 + i * 3}>
          <Icon size={ICON.sm} strokeWidth={STROKE} color={C.label2} />
          <T role="body" color={C.label2}>
            {label}
          </T>
          <div style={{ flex: 1 }} />
          {label === 'Settings' && <Moon size={ICON.sm} strokeWidth={STROKE} color={C.label3} />}
        </Row>
      ))}
    </div>
  )
}

/**
 * The new-chat screen, as the app greets you: the mascot's dot-matrix screen and a line. Its eyes turn to Robin's phone
 * as it rises, and the screen makes way when the message lands.
 */
function Home(props: { f: number }) {
  const f = props.f
  const gone = tween(f, BEAT.flight + 70, BEAT.flight + 95, 0, 1, EASES.in)
  if (gone >= 1) return null
  const t = sp(f, BEAT.dock + 60, SPRING.smooth)
  const lookingAtPhone = f > BEAT.ask + 30 && f < BEAT.flight + 40
  const following = f >= BEAT.flight + 40
  const eyes = following
    ? { look: [-1, -1] as const }
    : lookingAtPhone
      ? { look: [2, 0] as const, blink: f % 120 < 5 }
      : { blink: f % 100 < 5 }
  const cx = WORLD.composer.docked.x - WORLD.app.x
  return (
    <div
      style={{
        position: 'absolute',
        left: cx - 300,
        top: 150,
        width: 600,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: SPACE[8],
        opacity: t * (1 - gone),
        transform: `translateY(${(1 - t) * 30 - gone * 40}px) scale(${lerp(1, 0.94, gone)})`,
      }}
    >
      <LedScreen cols={15} rows={8} cell={20} eyes={eyes} status="READY" statusColor={C.ok} />
      <T role="title" color={C.label2}>
        Evening, Robin.
      </T>
    </div>
  )
}

/** The lead's reply in the chat: its face, one line, then the plan with its three task cards arriving one by one. */
function Plan(props: { f: number; rowsGone: boolean }) {
  const f = props.f
  if (f < BEAT.plan) return null
  const { lead, plan } = WORLD.chat
  const head = sp(f, BEAT.plan, SPRING.smooth)
  const card = sp(f, BEAT.plan + 40, SPRING.smooth)
  const ox = WORLD.app.x
  const oy = WORLD.app.y + BAR
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: lead.x - ox,
          top: lead.y - oy - 24,
          display: 'flex',
          alignItems: 'center',
          gap: SPACE[4],
          opacity: head,
          transform: `translateY(${(1 - head) * 14}px)`,
        }}
      >
        <LogoTile size={48} eyes={f < BEAT.plan + 50 ? { look: [Math.round(Math.sin(f / 9)), 0] } : { mood: 'happy' }} />
        <T role="body">On it. Three parts can run at once, so I'm bringing in the crew.</T>
      </div>
      <div
        style={{
          position: 'absolute',
          left: plan.x - ox,
          top: plan.y - oy,
          opacity: card,
          transform: `translateY(${(1 - card) * 24}px)`,
        }}
      >
        <Surface width={plan.w} height={PLAN_H} radius="xl" level="card">
          <div style={{ position: 'absolute', left: SPACE[4] + SPACE[1], top: SPACE[4], right: SPACE[4], height: PLAN_HEADER, display: 'flex', alignItems: 'center' }}>
            <SectionLabel>Plan · lead</SectionLabel>
          </div>
          {!props.rowsGone &&
            ORDER.map((who, i) => {
              const t = sp(f, BEAT.plan + 60 + i * 12, SPRING.smooth)
              const r = planRow(i)
              return (
                <div
                  key={who}
                  style={{ position: 'absolute', left: r.x - plan.x, top: r.y - plan.y, opacity: t, transform: `translateY(${(1 - t) * 18}px)` }}
                >
                  <TaskCard who={who} width={plan.w - SPACE[4] * 2} status="queued" frame={f} />
                </div>
              )
            })}
        </Surface>
      </div>
    </>
  )
}

/**
 * The app, as the world sees it from beat 2 to 4: the window draws itself around the composer, Robin's message lands
 * in its chat, the lead plans, and when the crew spawns the whole app falls back out of focus behind their panels.
 */
export function AppLayer(props: { f: number; rowsGone: boolean }) {
  const f = props.f
  if (f > BEAT.fold) return null
  const { app } = WORLD
  const appear = tween(f, BEAT.dock + 10, BEAT.dock + 100, 0, 1, EASES.out)
  const back = tween(f, BEAT.spawn, BEAT.spawn + 36, 0, 1, EASES.inOut)
  const landed = f >= BEAT.flight + 85
  const b = WORLD.chat.bubble
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity: lerp(1, 0.3, back) * (1 - tween(f, BEAT.fold - 30, BEAT.fold)),
        filter: back > 0.02 ? `blur(${back * 5}px)` : undefined,
        transform: `scale(${lerp(1, 0.97, back)})`,
        transformOrigin: '960px 540px',
      }}
    >
      {appear > 0 && (
        <div
          style={{
            position: 'absolute',
            left: app.x,
            top: app.y,
            opacity: appear,
            transform: `scale(${lerp(0.94, 1, appear)})`,
            transformOrigin: `${WORLD.composer.docked.x - app.x}px ${WORLD.composer.docked.y - app.y}px`,
            filter: appear < 0.98 ? `blur(${(1 - appear) * 8}px)` : undefined,
          }}
        >
          <Window
            width={app.w}
            height={app.h}
            bar={BAR}
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[3], marginLeft: app.sidebar - 108 }}>
                <T role="body" weight="semibold" color={C.label} fit={420}>
                  {landed ? THREAD : 'New chat'}
                </T>
                {f > BEAT.plan + 40 && <StatusPill status="working" />}
              </div>
            }
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[4] }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], color: C.label2 }}>
                  <Network size={ICON.sm} strokeWidth={STROKE} />
                  <T role="body" color={C.label2}>
                    Crew
                  </T>
                </span>
                <SquarePen size={ICON.sm} strokeWidth={STROKE} color={C.label3} />
              </div>
            }
          >
            <Sidebar f={f} />
            <Home f={f} />
            {landed && (
              <div style={{ position: 'absolute', left: b.right - b.w - app.x, top: b.top - app.y - BAR }}>
                <Bubble landed />
              </div>
            )}
            <Plan f={f} rowsGone={props.rowsGone} />
          </Window>
        </div>
      )}
      <Composer f={f} />
      <WordmarkShot f={f} />
    </div>
  )
}
