import type { ReactNode } from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASE_IN_OUT, SPRING, clamp, lerp, noise, quad, sp, tween } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon, type IconName } from '../components/Icon.tsx'
import { type EyeState, LedScreen } from '../components/Led.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { Crewmate, CrewTag, Cursor, Dot, Pill } from '../components/Ui.tsx'
import { C, CREW, type CrewName, FONT, MONO } from '../theme.ts'

/* ------------------------------------------------------------------ timing and layout */

const SPAWN = [104, 122, 140] as const
const SPLIT = 206
/** Panel-local time starts here. */
const P0 = 250
const PANEL = { w: 572, h: 872, top: 168, xs: [76, 674, 1272] as const }
const ORDER: CrewName[] = ['nova', 'quill', 'iris']

/** Where each crewmate's cursor waits around the lead's screen after spawning. */
const SPAWN_SPOT: Record<CrewName, [number, number]> = {
  nova: [170, 470],
  quill: [770, 880],
  iris: [1350, 300],
}

const COMPETITORS = [
  { name: 'Northwind', domain: 'northwind.com', price: 45 },
  { name: 'Contoso', domain: 'contoso.io', price: 59 },
  { name: 'Fabrikam', domain: 'fabrikam.app', price: 43 },
]
/** Panel-local frame each competitor's tab opens. */
const VISIT = [16, 132, 248]

const CODE: { text: ReactNode; add?: boolean }[] = [
  { text: <><K>export const</K> plans = [</>, add: true },
  { text: <>  {'{'} name: <S>'Starter'</S>, price: <N>0</N> {'}'},</>, add: true },
  { text: <>  {'{'} name: <S>'Pro'</S>, price: <N>39</N>, best: <N>true</N> {'}'},</>, add: true },
  { text: <>  {'{'} name: <S>'Team'</S>, price: <N>89</N> {'}'},</>, add: true },
  { text: <>]</>, add: true },
  { text: <> </> },
  { text: <><K>export default function</K> <F>Pricing</F>() {'{'}</>, add: true },
  { text: <>  <K>return</K> (</>, add: true },
  { text: <>    {'<'}<F>PlanGrid</F> plans={'{'}plans{'}'}</>, add: true },
  { text: <>      note=<S>"$10 below the average"</S> /{'>'}</>, add: true },
  { text: <>  )</>, add: true },
  { text: <>{'}'}</>, add: true },
]
const LINE_EVERY = 13

const TESTS = [
  'renders three plans',
  'Pro is highlighted',
  'prices match research',
  'monthly / yearly toggle',
  'checkout link per plan',
  'headings in order',
  'cards stack on mobile',
  'currency formats',
  'note says $10 below avg',
  'no layout shift',
  'dark mode contrast',
  'keyboard reachable',
  'loads under 1s',
  'social image present',
  'canonical URL set',
  'sitemap has /pricing',
  'flags default off',
  'snapshot matches',
]
const TEST_START = 214
const TEST_EVERY = 10

function K(p: { children: ReactNode }) {
  return <span style={{ color: '#c678dd' }}>{p.children}</span>
}
function S(p: { children: ReactNode }) {
  return <span style={{ color: '#9be37a' }}>{p.children}</span>
}
function N(p: { children: ReactNode }) {
  return <span style={{ color: '#ffb31a' }}>{p.children}</span>
}
function F(p: { children: ReactNode }) {
  return <span style={{ color: '#61afef' }}>{p.children}</span>
}

/* ------------------------------------------------------------------ panel chrome */

function Card(props: { x: number; y: number; w: number; h: number; children: ReactNode; bg?: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: props.x,
        top: props.y,
        width: props.w,
        height: props.h,
        borderRadius: 16,
        background: props.bg ?? C.raised,
        boxShadow: `inset 0 0 0 1px ${C.separator}`,
        overflow: 'hidden',
      }}
    >
      {props.children}
    </div>
  )
}

function PanelShell(props: { who: CrewName; p: number; chip: string; chipIcon: IconName; children: ReactNode; done?: boolean }) {
  const c = CREW[props.who]
  const pulse = (Math.sin(props.p / 7) + 1) / 2
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 26,
        background: 'linear-gradient(180deg, #121215 0%, #0d0d10 100%)',
        boxShadow: `0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.05), 0 40px 80px -30px rgba(0,0,0,0.9)`,
        overflow: 'hidden',
        fontFamily: FONT,
        color: C.label,
      }}
    >
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: c.color, opacity: 0.85 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '22px 24px 0' }}>
        <Crewmate who={props.who} size={46} blink={Math.floor(props.p / 7) % 31 === 3} look={[Math.round(noise(props.p / 40, 3) * 3), 0]} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 27, fontWeight: 680, letterSpacing: '-0.02em' }}>{c.name}</div>
          <div style={{ fontFamily: MONO, fontSize: 16, color: C.label3, marginTop: 3 }}>
            {c.role} · {c.model}
          </div>
        </div>
        <Pill size={16} color={props.done ? C.ok : C.accent} bg={props.done ? C.okSoft : C.accentSoft} border="transparent">
          <Dot color={props.done ? C.ok : C.accent} size={9} pulse={props.done ? 0 : pulse} />
          {props.done ? 'done' : 'working'}
        </Pill>
      </div>
      <div style={{ position: 'absolute', left: 24, top: 96 }}>
        <Pill size={15} icon={props.chipIcon} mono>
          {props.chip}
        </Pill>
      </div>
      <div style={{ position: 'absolute', left: 0, top: 46, right: 0, bottom: 0 }}>{props.children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ nova: research in a browser */

function Research(props: { p: number }) {
  const { p } = props
  const current = VISIT.reduce((acc, v, i) => (p >= v ? i : acc), 0)
  const site = COMPETITORS[current] ?? COMPETITORS[0]
  const load = tween(p, (VISIT[current] ?? 0) + 2, (VISIT[current] ?? 0) + 22)
  const select = (i: number) => p >= (VISIT[i] ?? 0) + 62 && p < (VISIT[i] ?? 0) + 112
  const avgIn = sp(p, 392, SPRING.pop)
  return (
    <>
      <Card x={20} y={110} w={532} h={340}>
        <div style={{ display: 'flex', height: 40, alignItems: 'flex-end', gap: 4, padding: '0 10px', background: '#141418' }}>
          {COMPETITORS.map((c, i) => (
            <div
              key={c.name}
              style={{
                padding: '8px 14px',
                fontSize: 15,
                borderRadius: '10px 10px 0 0',
                background: i === current ? C.raised : 'transparent',
                color: i === current ? C.label : C.label4,
                opacity: p >= (VISIT[i] ?? 0) - 4 ? 1 : 0.35,
              }}
            >
              {c.name}
            </div>
          ))}
        </div>
        <div style={{ margin: '8px 12px', height: 34, borderRadius: 10, background: C.fill, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
          <Icon name="lock" size={15} color={C.label3} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.label2 }}>{site?.domain}/pricing</span>
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 84, height: 3, background: CREW.nova.color, transformOrigin: '0 0', transform: `scaleX(${load})`, opacity: load < 1 ? 1 : 0 }} />
        <div style={{ padding: '14px 20px', opacity: lerp(0.15, 1, load) }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{site?.name} pricing</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
            {['Basic', 'Pro', 'Business'].map((tier, i) => {
              const price = i === 1 ? site?.price : i === 0 ? 0 : (site?.price ?? 0) * 2 + 9
              const hot = i === 1 && select(current)
              return (
                <div
                  key={tier}
                  style={{
                    flex: 1,
                    height: 164,
                    borderRadius: 12,
                    padding: 14,
                    background: '#1d1d22',
                    boxShadow: hot ? `0 0 0 2px ${CREW.nova.color}` : `inset 0 0 0 1px ${C.separator}`,
                  }}
                >
                  <div style={{ fontSize: 15, color: C.label3 }}>{tier}</div>
                  <div
                    style={{
                      fontSize: 30,
                      fontWeight: 700,
                      marginTop: 6,
                      display: 'inline-block',
                      padding: '0 4px',
                      marginLeft: -4,
                      borderRadius: 4,
                      background: hot ? `${CREW.nova.color}55` : 'transparent',
                    }}
                  >
                    ${price}
                  </div>
                  {[0.8, 0.6, 0.7].map((w) => (
                    <div key={w} style={{ height: 7, width: `${w * 100}%`, borderRadius: 4, background: '#2c2c33', marginTop: 12 }} />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </Card>

      <Card x={20} y={472} w={532} h={334}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px 0', gap: 10 }}>
          <Icon name="search" size={20} color={CREW.nova.color} />
          <span style={{ fontSize: 21, fontWeight: 650 }}>Competitor pricing</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.label3 }}>
            {COMPETITORS.filter((_, i) => p >= (VISIT[i] ?? 0) + 100).length} sources
          </span>
        </div>
        <div style={{ display: 'flex', fontFamily: MONO, fontSize: 14, color: C.label4, padding: '18px 20px 8px', letterSpacing: '0.08em' }}>
          <span style={{ flex: 1.4 }}>COMPANY</span>
          <span style={{ flex: 1 }}>PRO PLAN</span>
          <span style={{ width: 70, textAlign: 'right' }}>SOURCE</span>
        </div>
        {COMPETITORS.map((c, i) => {
          const t = sp(p, (VISIT[i] ?? 0) + 100, SPRING.pop)
          if (t <= 0.001) return null
          return (
            <div
              key={c.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 52,
                margin: '0 10px',
                padding: '0 10px',
                borderTop: `1px solid ${C.separator}`,
                fontSize: 21,
                opacity: clamp(t * 1.5, 0, 1),
                transform: `translateX(${(1 - t) * -30}px)`,
                background: p < (VISIT[i] ?? 0) + 130 ? `${CREW.nova.color}14` : 'transparent',
              }}
            >
              <span style={{ flex: 1.4, fontWeight: 560 }}>{c.name}</span>
              <span style={{ flex: 1, fontFamily: MONO }}>${c.price}/mo</span>
              <span style={{ width: 70, display: 'flex', justifyContent: 'flex-end' }}>
                <span style={{ fontFamily: MONO, fontSize: 14, padding: '3px 8px', borderRadius: 6, color: CREW.nova.color, background: `${CREW.nova.color}22` }}>
                  [{i + 1}]
                </span>
              </span>
            </div>
          )
        })}
        {avgIn > 0.001 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 60,
              margin: '6px 10px 0',
              padding: '0 10px',
              borderRadius: 10,
              background: C.accentSoft,
              fontSize: 22,
              fontWeight: 650,
              opacity: clamp(avgIn * 1.5, 0, 1),
              transform: `scale(${lerp(0.9, 1, avgIn)})`,
            }}
          >
            <span style={{ flex: 1.4 }}>Average</span>
            <span style={{ flex: 1, fontFamily: MONO, color: C.accent }}>$49/mo</span>
            <span style={{ width: 70, textAlign: 'right', fontFamily: MONO, fontSize: 15, color: C.label3 }}>3 cited</span>
          </div>
        )}
      </Card>

      {/* The price, copied from the page into the table. */}
      {VISIT.map((v, i) => {
        const t = tween(p, v + 72, v + 100, 0, 1, EASE_IN_OUT)
        if (t <= 0 || t >= 1) return null
        const [x, y] = quad(t, [262, 284], [420, 420], [300, 620 + i * 52])
        return (
          <div
            key={v}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              fontFamily: MONO,
              fontSize: 20,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 8,
              color: '#0b0b0d',
              background: CREW.nova.color,
              boxShadow: '0 8px 20px -6px rgba(0,0,0,0.7)',
              transform: `scale(${1 + Math.sin(t * Math.PI) * 0.15})`,
            }}
          >
            ${COMPETITORS[i]?.price}
          </div>
        )
      })}
    </>
  )
}

function novaCursor(p: number): [number, number, number] {
  let pos: [number, number] = [300, 760]
  let press = 0
  for (const [i, v] of VISIT.entries()) {
    if (p < v) break
    const from: [number, number] = i === 0 ? [300, 760] : [300, 640 + (i - 1) * 52]
    const t = tween(p, v + 26, v + 58, 0, 1, EASE_IN_OUT)
    pos = quad(t, from, [200, 300], [266, 290])
    if (p >= v + 60 && p < v + 70) press = 1
    if (p >= v + 72) pos = quad(tween(p, v + 72, v + 100, 0, 1, EASE_IN_OUT), [266, 290], [430, 430], [300, 640 + i * 52])
  }
  if (p > 380) pos = quad(tween(p, 380, 410, 0, 1, EASE_IN_OUT), pos, [330, 760], [380, 790])
  return [pos[0], pos[1], press]
}

/* ------------------------------------------------------------------ quill: code and tests in a worktree */

function Code(props: { p: number }) {
  const { p } = props
  const shown = clamp(Math.floor(p / LINE_EVERY), 0, CODE.length)
  const passed = clamp(Math.floor((p - TEST_START) / TEST_EVERY) + 1, 0, TESTS.length)
  const allGreen = passed === TESTS.length
  const badge = sp(p, TEST_START + TESTS.length * TEST_EVERY + 6, SPRING.pop)
  return (
    <>
      <Card x={20} y={110} w={532} h={420} bg="#0c0c0f">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, padding: '0 16px', background: '#141418', borderBottom: `1px solid ${C.separator}` }}>
          <Icon name="file" size={16} color={C.label3} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.label2 }}>app/pricing/page.tsx</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.ok }}>+{Math.min(shown, 11) * 4 - (shown > 5 ? 4 : 0)}</span>
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.bad }}>−3</span>
        </div>
        <div style={{ paddingTop: 10 }}>
          {CODE.slice(0, shown).map((line, i) => {
            const t = tween(p, i * LINE_EVERY, i * LINE_EVERY + 8)
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  height: 29,
                  alignItems: 'center',
                  fontFamily: MONO,
                  fontSize: 17,
                  whiteSpace: 'pre',
                  background: line.add ? `rgba(61,220,132,${0.1 * t})` : 'transparent',
                  boxShadow: line.add ? `inset 3px 0 0 rgba(61,220,132,${0.7 * t})` : undefined,
                  opacity: t,
                }}
              >
                <span style={{ width: 44, textAlign: 'right', paddingRight: 14, color: C.label4 }}>{i + 12}</span>
                <span style={{ color: C.termText }}>{line.text}</span>
              </div>
            )
          })}
        </div>
      </Card>
      <Card x={20} y={550} w={532} h={256} bg={C.terminal}>
        <div style={{ padding: '16px 18px', fontFamily: MONO, fontSize: 17, color: C.termText }}>
          <div style={{ color: p >= TEST_START - 20 ? C.termText : C.termMuted }}>
            <span style={{ color: C.termGreen }}>$</span> bun test
            {p >= TEST_START - 20 && p < TEST_START && <span style={{ color: C.termMuted }}> …</span>}
          </div>
          <div style={{ height: 5 * 27, overflow: 'hidden', marginTop: 8, position: 'relative' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
              {TESTS.slice(0, passed).map((name, i) => (
                <div key={name} style={{ height: 27, display: 'flex', gap: 10, opacity: tween(p, TEST_START + i * TEST_EVERY, TEST_START + i * TEST_EVERY + 6) }}>
                  <span style={{ color: C.ok }}>✓</span>
                  <span>{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 60,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '0 18px',
            borderTop: `1px solid ${C.separator}`,
            background: allGreen ? 'rgba(61,220,132,0.12)' : '#101013',
            fontFamily: MONO,
            fontSize: 24,
          }}
        >
          <span style={{ color: passed > 0 ? C.ok : C.termMuted, fontWeight: 600, transform: `scale(${1 + badge * 0.06 * (1 - badge) * 4})` }}>
            ✓ {passed} passed
          </span>
          <span style={{ color: C.termMuted }}>0 failed</span>
          <div style={{ flex: 1 }} />
          <div style={{ height: 6, width: 150, borderRadius: 3, background: '#222228', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(passed / TESTS.length) * 100}%`, background: C.ok }} />
          </div>
        </div>
      </Card>
    </>
  )
}

function quillCursor(p: number): [number, number, number] {
  const shown = clamp(Math.floor(p / LINE_EVERY), 0, CODE.length - 1)
  const lineX = [300, 420, 470, 420, 90, 90, 450, 230, 400, 470, 120, 100][shown] ?? 200
  const typing: [number, number] = [lineX + 20 + noise(p / 6, 5) * 4, 110 + 54 + shown * 29 + 18]
  if (p < TEST_START - 30) return [typing[0], typing[1], 0]
  const t = tween(p, TEST_START - 30, TEST_START - 6, 0, 1, EASE_IN_OUT)
  const [x, y] = quad(t, typing, [400, 560], [190, 590])
  return [x, y, p >= TEST_START - 6 && p < TEST_START ? 1 : 0]
}

/* ------------------------------------------------------------------ iris: driving the Mac */

const CANVAS = { x: 36, y: 244 }
const GRAB = 72
const DROP = 128
const SWATCH = 196
const EXPORT = 276

function Design(props: { p: number }) {
  const { p } = props
  const drag = tween(p, GRAB + 6, DROP, 0, 1, EASE_IN_OUT)
  const settle = sp(p, DROP, SPRING.pop)
  const proDy = lerp(46, 0, drag) + (p >= DROP ? (1 - settle) * -4 : 0)
  const proRot = lerp(4, 0, drag)
  const amber = p >= SWATCH + 6
  const popular = sp(p, SWATCH + 8, SPRING.pop)
  const toast = sp(p, EXPORT + 10, SPRING.pop)
  const edge = 0.65 + 0.35 * Math.sin(p / 11)
  return (
    <div
      style={{
        position: 'absolute',
        left: 20,
        top: 110,
        width: 532,
        height: 696,
        borderRadius: 16,
        overflow: 'hidden',
        background: 'radial-gradient(120% 80% at 30% 0%, #2a2140 0%, #121019 55%, #0b0b10 100%)',
      }}
    >
      <div style={{ height: 30, display: 'flex', alignItems: 'center', gap: 18, padding: '0 14px', fontSize: 14, color: C.label2, background: 'rgba(0,0,0,0.35)' }}>
        <span style={{ fontWeight: 700 }}>Design</span>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO }}>9:42</span>
      </div>
      {/* The app window being driven. */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          top: 54,
          width: 500,
          height: 560,
          borderRadius: 12,
          background: '#16161a',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.1), 0 30px 60px -20px rgba(0,0,0,0.9)',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 36, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', background: '#1c1c21', fontSize: 14, color: C.label3 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{ width: 10, height: 10, borderRadius: 9, background: c, opacity: 0.85 }} />
          ))}
          <span style={{ marginLeft: 10 }}>Pricing cards</span>
        </div>
        <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px', borderBottom: `1px solid ${C.separator}`, color: C.label3 }}>
          {(['pointer', 'layers', 'code', 'sparkle'] as const).map((n) => (
            <Icon key={n} name={n} size={18} />
          ))}
          <div style={{ flex: 1 }} />
          <div
            style={{
              height: 28,
              padding: '0 14px',
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              fontSize: 14,
              fontWeight: 600,
              color: p >= EXPORT && p < EXPORT + 8 ? '#1a1204' : C.accent,
              background: p >= EXPORT && p < EXPORT + 8 ? C.accent : 'transparent',
              boxShadow: `inset 0 0 0 1px ${C.accent}`,
            }}
          >
            Export
          </div>
        </div>
        <div style={{ position: 'absolute', left: 0, top: 80, width: 390, bottom: 0, backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1.2px)', backgroundSize: '16px 16px' }}>
          {p >= GRAB + 30 && p < DROP + 26 && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: 100, height: 1.5, background: '#ff4f9a', opacity: tween(p, GRAB + 30, GRAB + 40) * (1 - tween(p, DROP + 10, DROP + 26)) }} />
          )}
          {['Starter', 'Pro', 'Team'].map((tier, i) => {
            const pro = i === 1
            const price = ['$0', '$39', '$89'][i]
            return (
              <div
                key={tier}
                style={{
                  position: 'absolute',
                  left: 15 + i * 124,
                  top: 100 + (pro ? proDy : 0),
                  width: 112,
                  height: 176,
                  borderRadius: 12,
                  padding: '14px 12px',
                  background: pro && amber ? 'linear-gradient(180deg, #2a2210 0%, #1d1d22 70%)' : '#1f1f25',
                  boxShadow: pro && amber ? `0 0 0 2px ${C.accent}, 0 10px 30px -10px rgba(255,179,26,0.5)` : pro && p >= GRAB && p < DROP + 8 ? `0 0 0 2px ${CREW.iris.color}` : `inset 0 0 0 1px ${C.separatorStrong}`,
                  transform: `rotate(${pro ? proRot : 0}deg)`,
                }}
              >
                {pro && popular > 0.01 && (
                  <div style={{ position: 'absolute', top: -26, left: 8, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: C.accent, color: '#1a1204', transform: `scale(${popular})` }}>
                    MOST POPULAR
                  </div>
                )}
                <div style={{ fontSize: 16, color: C.label3 }}>{tier}</div>
                <div style={{ fontSize: 30, fontWeight: 700, marginTop: 4, color: pro && amber ? C.accent : C.label }}>{price}</div>
                {[0.9, 0.7, 0.8].map((w) => (
                  <div key={w} style={{ height: 6, width: `${w * 100}%`, borderRadius: 3, background: '#33333b', marginTop: 12 }} />
                ))}
              </div>
            )
          })}
        </div>
        <div style={{ position: 'absolute', left: 390, top: 80, right: 0, bottom: 0, borderLeft: `1px solid ${C.separator}`, padding: '14px 12px', fontSize: 13, color: C.label3 }}>
          <div>Fill</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {['#3a3a42', C.accent, CREW.iris.color, CREW.nova.color].map((c, i) => (
              <span key={c} style={{ width: 20, height: 20, borderRadius: 6, background: c, boxShadow: i === 1 && amber ? `0 0 0 2px #16161a, 0 0 0 3.5px ${C.accent}` : undefined }} />
            ))}
          </div>
          <div style={{ marginTop: 22 }}>Align</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {[0, 1, 2].map((k) => (
              <span key={k} style={{ width: 22, height: 22, borderRadius: 5, boxShadow: `inset 0 0 0 1px ${C.separatorStrong}` }} />
            ))}
          </div>
        </div>
      </div>
      {toast > 0.01 && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 34,
            transform: `translate(-50%, ${(1 - toast) * 40}px)`,
            opacity: clamp(toast * 1.5, 0, 1),
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 18px',
            borderRadius: 14,
            background: 'rgba(30,30,36,0.95)',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.1), 0 20px 40px -10px rgba(0,0,0,0.8)',
            fontSize: 17,
          }}
        >
          <Icon name="check" size={18} color={C.ok} stroke={2.4} />
          Exported <span style={{ fontFamily: MONO, color: C.label2 }}>pricing-cards.svg</span> → quill
        </div>
      )}
      {/* The amber edge that says an agent has the Mac. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 16,
          boxShadow: `inset 0 0 0 3px rgba(255,179,26,${0.85 * edge}), inset 0 0 40px rgba(255,164,28,${0.45 * edge})`,
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'absolute', top: 38, left: '50%', transform: 'translateX(-50%)' }}>
        <Pill size={14} color="#1a1204" bg={C.accent} border="transparent">
          <Dot color="#1a1204" size={7} /> iris is using this Mac
        </Pill>
      </div>
    </div>
  )
}

function irisCursor(p: number): [number, number, number] {
  const grab: [number, number] = [CANVAS.x + 15 + 124 + 56, CANVAS.y + 80 + 100 + 46 + 40]
  const drop: [number, number] = [grab[0], grab[1] - 46]
  const swatch: [number, number] = [36 + 16 + 390 + 12 + 26 + 10 - 16, 110 + 54 + 80 + 14 + 26 + 10]
  const exportBtn: [number, number] = [20 + 16 + 500 - 14 - 34, 110 + 54 + 36 + 22]
  const start: [number, number] = [420, 760]
  if (p < GRAB) return [...quad(tween(p, 20, GRAB - 4, 0, 1, EASE_IN_OUT), start, [250, 700], grab), 0]
  if (p < DROP + 4) {
    const t = tween(p, GRAB + 6, DROP, 0, 1, EASE_IN_OUT)
    return [lerp(grab[0], drop[0], t), lerp(grab[1], drop[1], t), 1]
  }
  if (p < SWATCH + 8) {
    const t = tween(p, DROP + 16, SWATCH - 4, 0, 1, EASE_IN_OUT)
    return [...quad(t, drop, [380, 430], swatch), p >= SWATCH ? 1 : 0]
  }
  const t = tween(p, SWATCH + 30, EXPORT - 4, 0, 1, EASE_IN_OUT)
  const pos = quad(t, swatch, [520, 300], exportBtn)
  const away = tween(p, EXPORT + 40, EXPORT + 80, 0, 1, EASE_IN_OUT)
  return [lerp(pos[0], 330, away), lerp(pos[1], 560, away), p >= EXPORT && p < EXPORT + 8 ? 1 : 0]
}

/** One crewmate's panel of the triptych at panel-local frame `p`. */
export function CrewPanel(props: { who: CrewName; p: number; done: boolean }) {
  const { who, p } = props
  return (
    <PanelShell
      who={who}
      p={p}
      done={props.done}
      chip={who === 'nova' ? 'browser · 3 sites' : who === 'quill' ? 'worktree · quill/pricing' : 'computer use · this Mac'}
      chipIcon={who === 'nova' ? 'globe' : who === 'quill' ? 'branch' : 'monitor'}
    >
      <div style={{ position: 'absolute', inset: 0, top: -20 }}>
        {who === 'nova' && <Research p={p} />}
        {who === 'quill' && <Code p={p} />}
        {who === 'iris' && <Design p={p} />}
      </div>
    </PanelShell>
  )
}

/* ------------------------------------------------------------------ the scene */

const PANEL_CURSOR: Record<CrewName, (p: number) => [number, number, number]> = {
  nova: novaCursor,
  quill: quillCursor,
  iris: irisCursor,
}

function leadEyes(frame: number): EyeState {
  if (frame < 20) return { look: [0, 0] }
  if (frame < 44) return { look: [-2, 0] }
  if (frame < 52) return { look: [-2, 0], blink: true }
  if (frame < 72) return { look: [2, 0] }
  if (frame < 96) return { look: [0, -1] }
  if (frame < SPLIT) {
    const i = SPAWN.findLastIndex((s) => frame >= s)
    if (i < 0) return { mood: 'happy' }
    const who = ORDER[i] ?? 'nova'
    const [x, y] = SPAWN_SPOT[who]
    return { look: [clamp(Math.round((x - 960) / 260), -2, 2), clamp(Math.round((y - 560) / 260), -1, 1)] }
  }
  return { mood: 'happy' }
}

export function Crew(props: { dur: number }) {
  const frame = useCurrentFrame()
  const p = frame - P0
  const split = tween(frame, SPLIT, SPLIT + 40, 0, 1, EASE_IN_OUT)
  const screenIn = sp(frame, 0, SPRING.smooth)

  return (
    <Shot dur={props.dur}>
      <Stage glow={{ x: 960, y: lerp(560, 600, split), strength: lerp(1, 0.6, split), size: lerp(900, 1700, split) }}>
        {/* The lead's screen, thinking, then sending the crew out. */}
        {split < 1 && (
          <div
            style={{
              position: 'absolute',
              left: 960 - 333,
              top: 560 - 210,
              width: 666,
              transform: `translateY(${split * -420}px) scale(${lerp(0.92, 0.45, split) * lerp(0.9, 1, screenIn)})`,
              opacity: 1 - split,
            }}
          >
            <LedScreen cell={30} eyes={leadEyes(frame)} status={frame >= SPAWN[0] ? 'CREW OF 3' : 'PLANNING'} statusColor={C.accent} readout="LEAD" />
          </div>
        )}

        {/* The triptych, under a slow push-in. */}
        <AbsoluteFill style={{ transform: `scale(${lerp(1, 1.035, tween(frame, SPLIT + 40, props.dur, 0, 1, EASE_IN_OUT))})`, transformOrigin: '50% 62%' }}>
        {ORDER.map((who, i) => {
          const rise = sp(frame, SPLIT + 4 + i * 12, SPRING.smooth)
          if (rise <= 0.001) return null
          const pp = p - i * 4
          const done = who === 'nova' ? pp > 420 : who === 'quill' ? pp > TEST_START + TESTS.length * TEST_EVERY + 6 : pp > EXPORT + 30
          return (
            <div
              key={who}
              style={{
                position: 'absolute',
                left: PANEL.xs[i],
                top: PANEL.top + (1 - rise) * 700,
                width: PANEL.w,
                height: PANEL.h,
                opacity: clamp(rise * 1.4, 0, 1),
              }}
            >
              <CrewPanel who={who} p={pp} done={done} />
            </div>
          )
        })}

        {/* The crew's cursors: spawned from the screen, then at work in their panels. */}
        {ORDER.map((who, i) => {
          const born = sp(frame, SPAWN[i] ?? 0, SPRING.pop)
          if (born <= 0.001) return null
          const c = CREW[who]
          const out = sp(frame, SPAWN[i] ?? 0, SPRING.smooth)
          const spot = SPAWN_SPOT[who]
          const drift: [number, number] = [noise(frame / 50, i) * 14, noise(frame / 50, i + 10) * 10]
          let x = lerp(960, spot[0], out) + drift[0]
          let y = lerp(560, spot[1], out) + drift[1]
          const [px, py, press] = PANEL_CURSOR[who](p - i * 4)
          const panelX = (PANEL.xs[i] ?? 0) + px
          const panelY = PANEL.top + py + 26
          const go = tween(frame, SPLIT + 10, SPLIT + 52, 0, 1, EASE_IN_OUT)
          const [gx, gy] = quad(go, [x, y], [(x + panelX) / 2, Math.min(y, panelY) - 120], [panelX, panelY])
          x = gx
          y = gy
          const labelScale = lerp(1, 0.62, go)
          return (
            <Cursor
              key={who}
              color={c.color}
              size={lerp(46, 34, go)}
              press={press}
              tilt={-10 + noise(frame / 30, i + 20) * 6}
              label={go < 0.5 ? <CrewTag who={who} /> : c.name}
              labelScale={labelScale}
              style={{ left: x, top: y, transform: `scale(${born})`, opacity: clamp(born * 2, 0, 1) }}
            />
          )
        })}

        </AbsoluteFill>

        <AbsoluteFill style={{ top: 108, height: 'auto', alignItems: 'center' }}>
          <Caption text="Your lead plans. *A crew spawns.*" start={14} end={SPLIT - 8} size={76} />
        </AbsoluteFill>
        <AbsoluteFill style={{ top: 52, height: 'auto', alignItems: 'center' }}>
          <Caption text="Research. Code. Design. *In parallel.*" start={SPLIT + 30} end={SPLIT + 300} size={66} />
        </AbsoluteFill>
        <AbsoluteFill style={{ top: 52, height: 'auto', alignItems: 'center' }}>
          <Caption text="Each on the model *it's best at.*" start={SPLIT + 318} end={props.dur - 14} size={66} />
        </AbsoluteFill>
      </Stage>
    </Shot>
  )
}
