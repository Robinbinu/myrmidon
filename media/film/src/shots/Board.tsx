import { BadgeCheck, Check, ChevronRight, ListChecks, Mail, ShieldQuestion, X } from 'lucide-react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASES, lerp, quad, sp, SPRING, tween } from '../anim.ts'
import { MotionBlur } from '../components/World.tsx'
import { CrewCursor, MailCard, TASK_CARD_H, TaskCard } from '../components/Crew.tsx'
import { Button, ICON, SectionLabel, STROKE, Surface, Window } from '../components/Surface.tsx'
import { T } from '../components/Text.tsx'
import { RADIUS, SPACE, SURFACE } from '../design.ts'
import { BEAT, WORLD } from '../timeline.ts'
import { C, CREW, type CrewName } from '../theme.ts'
import { ORDER } from './App.tsx'
import { BODY, FOLD, headerAt, MESSAGES } from './Crew.tsx'

const B = WORLD.board
const BAR = 48
const LANE_TOP = B.y + BAR + SPACE[6]
const LANE_W = BODY.w + SPACE[8]
const laneX = (lane: 0 | 1) => B.x + SPACE[6] + lane * (LANE_W + SPACE[6])
const cardY = (i: number) => LANE_TOP + 44 + i * (TASK_CARD_H + SPACE[3])
const MAIL_X = laneX(1) + LANE_W + SPACE[6]
const MAIL_W = B.x + B.w - SPACE[6] - MAIL_X

/* ------------------------------------------------------------------ the panels' cards drop onto the board */

const DROP = 90
const dropStart = (i: number) => BEAT.fold + FOLD + i * 12
const dropEnd = (i: number) => dropStart(i) + DROP
const TICK = (i: number) => BEAT.review + 14 + i * 22
const SLIDE = (i: number) => BEAT.review + 68 + i * 8
/** The frames the reviewer ticks each card on. */
export const TICK_AT = [0, 1, 2].map(TICK)

function cardAt(i: number, f: number) {
  const a = headerAt(i)
  const t = tween(f, dropStart(i), dropEnd(i), 0, 1, EASES.inOut)
  const bx = laneX(0)
  const by = cardY(i)
  // Each card swings out to the right and slides into its slot along its own row, so the cards never cross the lane's
  // label or each other; they shrink a little in the air.
  const [x0, y0] = quad(t, [a.x, a.y], [bx + 600, by], [bx, by])
  const slide = tween(f, SLIDE(i), SLIDE(i) + 34, 0, 1, EASES.inOut)
  return { x: lerp(x0, laneX(1), slide), y: y0, t, slide, scale: 1 - 0.3 * Math.sin(Math.PI * t) }
}

function DroppingCards() {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill>
      {ORDER.map((who, i) => {
        const s = cardAt(i, f)
        if (f >= dropEnd(i)) return null
        return (
          <div key={who} data-cover={`drop-${who}`} style={{ position: 'absolute', left: s.x, top: s.y, transform: `scale(${s.scale})`, transformOrigin: '0 50%' }}>
            <TaskCard who={who} width={BODY.w} status="review" frame={f} />
          </div>
        )
      })}
    </AbsoluteFill>
  )
}

/** Beat 5A: each panel, folded to its card, drops onto the board's review lane as the camera tilts down. */
export function FoldFlight(props: { f: number }) {
  const f = props.f
  if (f < dropStart(0) || f >= dropEnd(2)) return null
  return (
    <MotionBlur samples={6}>
        <DroppingCards />
      </MotionBlur>
  )
}

/* ------------------------------------------------------------------ the board */

const THREAD: { from: CrewName; to: CrewName; text: string }[] = [
  ...MESSAGES.map(({ from, to, text }) => ({ from, to, text })),
  { from: 'quill', to: 'nova', text: 'Float rounding: 4998.999… cents. Fixed, with a test.' },
  { from: 'iris', to: 'quill', text: 'Re-tested on mobile. Payment goes through.' },
]
const mailAt = (k: number) => BEAT.fold + 90 + k * 30

function Lane(props: { lane: 0 | 1; label: string; count: number; dot: string }) {
  return (
    <div style={{ position: 'absolute', left: laneX(props.lane) - B.x, top: LANE_TOP - B.y - BAR, height: 32, display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
      <SectionLabel dot={props.dot}>{`${props.label} ${props.count}`}</SectionLabel>
    </div>
  )
}

export function Board(props: { f: number }) {
  const f = props.f
  if (f < BEAT.fold + 30 || f > BEAT.recede + 80) return null
  const appear = sp(f, BEAT.fold + 36, SPRING.smooth)
  const dim = tween(f, BEAT.trust, BEAT.trust + 70, 0, 1, EASES.inOut)
  const inReview = ORDER.filter((_, i) => f >= dropEnd(i) && f < SLIDE(i) + 17).length
  const done = ORDER.filter((_, i) => f >= SLIDE(i) + 17).length
  const reviewer: { f: number; x: number; y: number; click?: boolean }[] = [
    { f: BEAT.review - 10, x: laneX(0) + 300, y: cardY(2) + 180 },
    ...ORDER.map((_, i) => ({ f: TICK(i), x: laneX(0) + 380, y: cardY(i) + 70, click: true })),
    { f: BEAT.review + 140, x: laneX(0) + 520, y: cardY(2) + 200 },
  ]
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: lerp(1, 0.3, dim) * appear,
        filter: dim > 0.02 ? `blur(${dim * 6}px)` : undefined,
      }}
    >
      <div style={{ position: 'absolute', left: B.x, top: B.y, transform: `translateY(${(1 - appear) * 40}px)` }}>
        <Window
          width={B.w}
          height={B.h}
          bar={BAR}
          title={
            <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], marginLeft: SPACE[4] }}>
              <ListChecks size={ICON.sm} strokeWidth={STROKE} color={C.label2} />
              <T role="body" weight="semibold">
                Tasks
              </T>
              <T role="label" color={C.label3}>
                {`${done} of 3 done`}
              </T>
            </span>
          }
        >
          <Lane lane={0} label="In review" count={inReview} dot={C.warn} />
          <Lane lane={1} label="Done" count={done} dot={C.ok} />
          <div style={{ position: 'absolute', left: MAIL_X - B.x, top: LANE_TOP - B.y - BAR, width: MAIL_W, bottom: SPACE[6] }}>
            <Surface width={MAIL_W} height={B.h - BAR - SPACE[6] * 2} radius="lg" level="card" fill={SURFACE.inset}>
              <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: SPACE[2], padding: `0 ${SPACE[4]}px`, boxShadow: `inset 0 -1px 0 ${C.separator}` }}>
                <Mail size={ICON.sm} strokeWidth={STROKE} color={C.label2} />
                <T role="body" weight="semibold">
                  Mail
                </T>
              </div>
              <div data-scroll="" style={{ position: 'absolute', left: SPACE[4], right: SPACE[4], top: 52 + SPACE[3], bottom: SPACE[4], display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: SPACE[3], overflow: 'hidden' }}>
                {THREAD.map((m, k) => {
                  const t = sp(f, mailAt(k), SPRING.smooth)
                  if (f < mailAt(k)) return null
                  return (
                    <div key={m.text} style={{ opacity: t, transform: `translateY(${(1 - t) * 24}px)` }}>
                      <MailCard from={m.from} to={m.to} text={m.text} width={MAIL_W - SPACE[4] * 2} />
                    </div>
                  )
                })}
              </div>
            </Surface>
          </div>
        </Window>
      </div>
      {ORDER.map((who, i) => {
        if (f < dropEnd(i)) return null
        const s = cardAt(i, f)
        const land = sp(f, dropEnd(i), SPRING.pop)
        const ticked = f >= TICK(i) + 3
        return (
          <div key={who} style={{ position: 'absolute', left: s.x, top: s.y, transform: `scale(${lerp(1.03, 1, land)})` }}>
            <TaskCard who={who} width={BODY.w} status={ticked ? 'done' : 'review'} frame={f} happy={ticked} />
          </div>
        )
      })}
      {f >= BEAT.review - 10 && f < BEAT.review + 170 && (
        <CrewCursor
          name="reviewer"
          color={C.judge}
          frame={f}
          stops={reviewer}
          opacity={tween(f, BEAT.review - 10, BEAT.review) * (1 - tween(f, BEAT.review + 150, BEAT.review + 170))}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ the review stamp, which becomes the approval */

const STAMP = { x: laneX(0) + BODY.w / 2, y: cardY(1) + TASK_CARD_H / 2, w: 470, h: 136, rot: -6 }
const CARD = { ...WORLD.approval, h: 300 }
const MORPH = [BEAT.trust + 20, BEAT.trust + 100] as const
const ALLOW = BEAT.allow

/** Where the stamp-turned-card is, how big, how turned, and how far it has become the approval card. */
function stampState(f: number) {
  const drop = tween(f, BEAT.stamp - 30, BEAT.stamp, 0, 1, EASES.in)
  const m = tween(f, MORPH[0], MORPH[1], 0, 1, EASES.inOut)
  return {
    x: lerp(STAMP.x, CARD.x, m),
    y: lerp(STAMP.y, CARD.y, m),
    w: lerp(STAMP.w, CARD.w, m),
    h: lerp(STAMP.h, CARD.h, m),
    rot: lerp(STAMP.rot, 0, m),
    scale: lerp(1.5, 1, drop),
    opacity: tween(drop, 0.45, 1),
    m,
  }
}

function Verdict(props: { f: number }) {
  const f = props.f
  const score = tween(f, BEAT.stamp - 20, BEAT.stamp + 10, 0, 0.97, EASES.out)
  return (
    <div style={{ position: 'absolute', inset: 0, padding: `${SPACE[4]}px ${SPACE[6]}px`, display: 'flex', gap: SPACE[3] }}>
      <BadgeCheck size={ICON.md} strokeWidth={STROKE} color={C.ok} style={{ marginTop: 4, flexShrink: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE[1] }}>
        <T role="heading" color={C.ok}>
          {`Reviewed · score ${score.toFixed(2)}`}
        </T>
        <T role="label" color={C.label2} fit={STAMP.w - 110}>
          Root cause confirmed, regression test added
        </T>
        <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[1], color: C.label3 }}>
          <ChevronRight size={14} strokeWidth={2.4} />
          <T role="label" mono color={C.label3}>
            412 passed
          </T>
        </span>
      </div>
    </div>
  )
}

function Approval(props: { f: number }) {
  const f = props.f
  const allowed = f >= ALLOW + 6
  const hover = tween(f, ALLOW - 30, ALLOW - 18)
  const press = tween(f, ALLOW - 2, ALLOW) * (1 - tween(f, ALLOW + 4, ALLOW + 10))
  const done = sp(f, ALLOW + 6, SPRING.pop)
  const inner = CARD.w - SPACE[8] * 2
  return (
    <div style={{ position: 'absolute', inset: 0, padding: SPACE[8], display: 'flex', flexDirection: 'column', gap: SPACE[3] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[3] }}>
        <ShieldQuestion size={32} strokeWidth={STROKE} color={C.warn} />
        <T role="title">Deploy hotfix to production?</T>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SPACE[2] }}>
        <T role="body" weight="semibold" color={CREW.quill.color}>
          quill
        </T>
        <T role="body" color={C.label2}>
          wants to deploy
        </T>
        <T role="body" mono color={C.label}>
          quill/fix-eur-rounding
        </T>
      </div>
      <div data-box="" style={{ width: inner, boxSizing: 'border-box', padding: `${SPACE[3]}px ${SPACE[4]}px`, borderRadius: RADIUS.lg, background: C.content }}>
        <T role="mono" color={C.label2}>
          3 files changed · 412 tests passed · reviewed 0.97
        </T>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: SPACE[3], height: 52 }}>
        {allowed ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], opacity: done, transform: `translateY(${(1 - done) * 8}px)` }}>
            <Check size={ICON.md} strokeWidth={2.4} color={C.ok} />
            <T role="body" weight="semibold" color={C.ok}>
              Allowed by Robin · logged as event #2047
            </T>
          </span>
        ) : (
          <>
            <Button icon={X}>Deny</Button>
            <Button primary icon={Check} hover={hover} press={press}>
              Allow once
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** Allow once, in the world: the button Robin's cursor aims for. */
const ALLOW_AT = { x: CARD.x + CARD.w / 2 - SPACE[8] - 92, y: CARD.y + CARD.h / 2 - SPACE[8] - 26 }

/**
 * Beats 5B–6: the reviewer's verdict slams onto the board, then slides to the centre, straightens and grows into the
 * approval card; Robin allows it.
 */
export function StampAndApproval(props: { f: number }) {
  const f = props.f
  if (f < BEAT.stamp - 30 || f > BEAT.recede + 80) return null
  const s = stampState(f)
  const impact = f >= BEAT.stamp ? f - BEAT.stamp : -1
  const verdictOut = tween(f, MORPH[0], MORPH[0] + 16)
  const approvalIn = tween(f, MORPH[1] - 30, MORPH[1] + 4)
  const border = s.m < 0.5 ? `rgba(61,220,132,${0.5 - s.m * 0.4})` : `rgba(255,138,76,${0.2 + (s.m - 0.5) * 0.6})`
  const fill = s.m < 0.5 ? '#0f2419' : '#1d1612'
  return (
    <>
      {impact >= 0 && impact < 40 && (
        <div
          style={{
            position: 'absolute',
            left: STAMP.x - 300,
            top: STAMP.y - 300,
            width: 600,
            height: 600,
            borderRadius: RADIUS.pill,
            boxShadow: `inset 0 0 0 3px rgba(61,220,132,${0.6 * (1 - impact / 40)})`,
            transform: `scale(${lerp(0.4, 1.4, impact / 40)})`,
          }}
        />
      )}
      <div data-cover="stamp"
        style={{
          position: 'absolute',
          left: s.x - s.w / 2,
          top: s.y - s.h / 2,
          opacity: s.opacity,
          transform: `rotate(${s.rot}deg) scale(${s.scale})`,
        }}
      >
        <Surface width={s.w} height={s.h} radius="xl" level="card" fill={fill} tint={border}>
          {verdictOut < 1 && (
            <div style={{ opacity: 1 - verdictOut }}>
              <Verdict f={f} />
            </div>
          )}
          {approvalIn > 0 && (
            <div style={{ position: 'absolute', inset: 0, opacity: approvalIn }}>
              <Approval f={f} />
            </div>
          )}
        </Surface>
      </div>
      {f >= ALLOW - 130 && (
        <CrewCursor
          name="Robin"
          color={C.label}
          frame={f}
          stops={[
            { f: ALLOW - 130, x: CARD.x + 620, y: CARD.y + 520 },
            { f: ALLOW - 30, x: ALLOW_AT.x - 20, y: ALLOW_AT.y + 4 },
            { f: ALLOW, x: ALLOW_AT.x - 22, y: ALLOW_AT.y + 6, click: true },
            { f: ALLOW + 34, x: ALLOW_AT.x + 150, y: ALLOW_AT.y + 130 },
          ]}
          opacity={tween(f, ALLOW - 130, ALLOW - 115)}
        />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ the audit log */

const LOG: [string, string, string][] = [
  ['nova', 'sql.query', 'checkout_events'],
  ['nova', 'notebook.run', 'plot rate by hour'],
  ['iris', 'computer.open', 'Safari · acme.dev'],
  ['iris', 'computer.click', 'Pay €49.99'],
  ['iris', 'computer.screenshot', 'evidence-1.png'],
  ['quill', 'debug.break', 'currency.ts:14'],
  ['quill', 'fs.write', 'checkout/currency.ts'],
  ['quill', 'shell.run', 'bun test (sandbox)'],
  ['reviewer', 'review.pass', 'score 0.97'],
  ['quill', 'approval.ask', 'deploy to production'],
]

/**
 * "Logged": the audit log, far behind the approval card and out of focus, scrolling. When Robin allows, the matching
 * line lights. Texture, not reading matter, so the overlap check leaves it alone.
 */
export function AuditLog(props: { f: number }) {
  const f = props.f
  if (f < BEAT.trust || f > BEAT.recede + 80) return null
  const show = tween(f, BEAT.trust + 20, BEAT.trust + 90)
  const scroll = (f - BEAT.trust) * 0.35
  const rows = Array.from({ length: 26 }, (_, i) => i)
  return (
    <div style={{ position: 'absolute', left: B.x + 60, top: B.y + 40, width: B.w - 120, height: B.h - 60, overflow: 'hidden', opacity: show * 0.5, filter: 'blur(1.5px)' }}>
      <div style={{ position: 'absolute', left: 0, top: -scroll, width: '100%' }}>
        {rows.map((i) => {
          const [who, tool, what] = LOG[i % LOG.length] as [string, string, string]
          const id = 2021 + i
          const lit = id === 2047 && f >= ALLOW + 6
          const color = lit ? C.accent : C.label4
          return (
            <div key={i} style={{ display: 'flex', gap: SPACE[8], height: 32, alignItems: 'center' }}>
              <T role="mono" deco color={color} style={{ width: 80 }}>
                {`#${id}`}
              </T>
              <T role="mono" deco color={color} style={{ width: 120 }}>
                {`23:${String(41 + Math.floor(i / 3)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`}
              </T>
              <T role="mono" deco color={lit ? C.accent : (CREW[who as CrewName]?.color ?? C.judge)} style={{ width: 120 }}>
                {lit ? 'Robin' : who}
              </T>
              <T role="mono" deco color={color} style={{ width: 260 }}>
                {lit ? 'approval.allow' : tool}
              </T>
              <T role="mono" deco color={color}>
                {lit ? 'deploy to production' : what}
              </T>
            </div>
          )
        })}
      </div>
    </div>
  )
}
