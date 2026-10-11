import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASE_IN_OUT, SPRING, clamp, lerp, quad, sp, tween } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon } from '../components/Icon.tsx'
import { LedScreen } from '../components/Led.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { Crewmate, Dot } from '../components/Ui.tsx'
import { C, CREW, type CrewName, FONT, MONO } from '../theme.ts'

type Who = CrewName | 'lead'

const COLS = ['To do', 'In progress', 'Review', 'Done']
/** Each task keeps its own lane and slides across the columns; `moves` are [frame, column]. */
const TASKS: { title: string; who: Who; moves: [number, number][] }[] = [
  { title: 'Collect competitor prices', who: 'nova', moves: [[0, 1], [36, 2], [92, 3]] },
  { title: 'Pick the launch price', who: 'lead', moves: [[0, 0], [28, 1], [118, 2], [168, 3]] },
  { title: 'Build the /pricing page', who: 'quill', moves: [[0, 1], [70, 2], [148, 3]] },
  { title: 'Write 18 tests', who: 'quill', moves: [[0, 2], [108, 3]] },
  { title: 'Polish pricing cards', who: 'iris', moves: [[0, 1], [98, 2], [184, 3]] },
  { title: 'Deploy acme.dev/pricing', who: 'quill', moves: [[0, 0], [200, 1], [252, 2]] },
]

const BOARD = { x: 76, y: 196, w: 1050, h: 800 }
const COL_W = (BOARD.w - 40 - 3 * 14) / 4
const LANE = 108

const MESSAGES: { from: Who; to: Who; text: string; at: number }[] = [
  { from: 'nova', to: 'quill', text: '@quill avg is $49. Pro at $39?', at: 24 },
  { from: 'quill', to: 'iris', text: '@iris Pro card says $39 now', at: 92 },
  { from: 'iris', to: 'quill', text: '@quill exported the cards', at: 160 },
  { from: 'quill', to: 'lead', text: '@lead ready for review', at: 228 },
]
const FLIGHT = 58

const NODES: Record<Who, [number, number]> = {
  lead: [1495, 470],
  nova: [1255, 690],
  quill: [1735, 690],
  iris: [1495, 905],
}

const STAMP = 296

const colorOf = (w: Who) => (w === 'lead' ? C.accent : CREW[w].color)

function Avatar(props: { who: Who; size: number; happy?: boolean }) {
  if (props.who === 'lead')
    return (
      <div style={{ width: props.size, height: props.size, borderRadius: props.size * 0.3, background: C.screen, display: 'grid', placeItems: 'center', boxShadow: '0 0 0 1px rgba(255,255,255,0.08)' }}>
        <LedScreen bezel={false} cols={7} rows={7} cell={props.size * 0.09} eyes={{ mood: props.happy ? 'happy' : 'open' }} />
      </div>
    )
  return <Crewmate who={props.who} size={props.size} happy={props.happy} />
}

function colAt(moves: [number, number][], frame: number): { from: number; to: number; t: number } {
  let from = moves[0]?.[1] ?? 0
  let to = from
  let at = 0
  for (const [f, c] of moves) {
    if (frame >= f) {
      from = to
      to = c
      at = f
    }
  }
  return { from, to, t: sp(frame, at, SPRING.snappy) }
}

export function Coord(props: { dur: number }) {
  const frame = useCurrentFrame()
  const budget = tween(frame, 14, 270, 0, 1.84, EASE_IN_OUT)
  const stampT = sp(frame, STAMP, SPRING.heavy)
  const impact = frame - (STAMP + 9)
  const shake = impact > 0 && impact < 40 ? Math.sin(impact * 1.6) * 10 * Math.exp(-impact / 8) : 0
  const dim = tween(frame, STAMP - 6, STAMP + 14) * 0.6
  const boardIn = sp(frame, 0, SPRING.smooth)

  const counts = COLS.map((_, ci) => TASKS.filter((t) => colAt(t.moves, frame).to === ci).length)

  return (
    <Shot dur={props.dur}>
      <Stage glow={{ x: 960, y: 620, strength: 0.7, size: 1500 }}>
        <AbsoluteFill
          style={{
            transform: `translate(${shake * 0.6}px, ${shake}px) scale(${lerp(1.02, 1, tween(frame, 0, 60)) * lerp(1, 1.03, tween(frame, 60, props.dur))})`,
            transformOrigin: '50% 60%',
          }}
        >
          {/* Task board. */}
          <div
            style={{
              position: 'absolute',
              left: BOARD.x,
              top: BOARD.y + (1 - boardIn) * 80,
              width: BOARD.w,
              height: BOARD.h,
              opacity: boardIn,
              borderRadius: 26,
              background: 'linear-gradient(180deg, #121215 0%, #0d0d10 100%)',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 40px 80px -30px rgba(0,0,0,0.9)',
              fontFamily: FONT,
              color: C.label,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '24px 26px 0' }}>
              <Icon name="check" size={24} color={C.accent} stroke={2.2} />
              <span style={{ fontSize: 26, fontWeight: 680, letterSpacing: '-0.02em' }}>Tasks</span>
              <span style={{ fontFamily: MONO, fontSize: 17, color: C.label3 }}>pricing launch</span>
            </div>
            <div style={{ position: 'absolute', left: 20, right: 20, top: 82, display: 'flex', gap: 14 }}>
              {COLS.map((name, ci) => (
                <div key={name} style={{ width: COL_W, height: BOARD.h - 102, borderRadius: 16, background: ci === 3 ? 'rgba(61,220,132,0.05)' : 'rgba(255,255,255,0.025)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 14px', fontSize: 18, fontWeight: 600, color: C.label2 }}>
                    <Dot color={[C.label4, C.accent, '#7fdcff', C.ok][ci] ?? C.label4} size={9} />
                    {name}
                    <span style={{ fontFamily: MONO, fontSize: 16, color: C.label4 }}>{counts[ci]}</span>
                  </div>
                </div>
              ))}
            </div>
            {TASKS.map((task, lane) => {
              const { from, to, t } = colAt(task.moves, frame)
              const x = 20 + lerp(from, to, t) * (COL_W + 14) + 8
              const lift = Math.sin(clamp(t, 0, 1) * Math.PI)
              const done = to === 3 && t > 0.6
              const waiting = lane === 5 && frame >= 262
              return (
                <div
                  key={task.title}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: 140 + lane * LANE - lift * 10,
                    width: COL_W - 16,
                    height: 94,
                    borderRadius: 14,
                    padding: '13px 14px',
                    background: '#1b1b20',
                    boxShadow: `inset 0 0 0 1px ${waiting ? C.accent : C.separatorStrong}, 0 ${8 + lift * 20}px ${20 + lift * 20}px -10px rgba(0,0,0,0.8)`,
                    transform: `rotate(${(to - from) * lift * 2.5}deg)`,
                  }}
                >
                  <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2, color: done ? C.label2 : C.label, height: 42 }}>{task.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <Avatar who={task.who} size={24} />
                    <span style={{ fontFamily: MONO, fontSize: 14, color: C.label3 }}>{task.who}</span>
                    <div style={{ flex: 1 }} />
                    {done && <Icon name="check" size={18} color={C.ok} stroke={2.4} />}
                    {waiting && (
                      <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 99, background: C.accent, color: '#1a1204' }}>NEEDS YOU</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Budget. */}
          <div
            style={{
              position: 'absolute',
              left: 1170,
              top: 196,
              width: 674,
              height: 128,
              borderRadius: 22,
              padding: '22px 26px',
              background: '#121215',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.08)',
              fontFamily: FONT,
              opacity: boardIn,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <Icon name="wallet" size={22} color={C.label3} />
              <span style={{ fontSize: 19, color: C.label3, fontWeight: 560 }}>Run budget</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 40, fontWeight: 600, color: C.label, letterSpacing: '-0.02em' }}>${budget.toFixed(2)}</span>
              <span style={{ fontFamily: MONO, fontSize: 22, color: C.label3 }}>of $5</span>
            </div>
            <div style={{ marginTop: 20, height: 12, borderRadius: 6, background: '#222228', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(budget / 5) * 100}%`, borderRadius: 6, background: `linear-gradient(90deg, ${C.eyeBottom}, ${C.eyeTop})`, boxShadow: '0 0 16px rgba(255,179,26,0.6)' }} />
            </div>
          </div>

          {/* The crew map: messages travel between them. */}
          <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
            {(
              [
                ['lead', 'nova'],
                ['lead', 'quill'],
                ['nova', 'quill'],
                ['nova', 'iris'],
                ['quill', 'iris'],
              ] as [Who, Who][]
            ).map(([a, b]) => (
              <line key={a + b} x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]} stroke="rgba(255,255,255,0.12)" strokeWidth={2} strokeDasharray="4 8" opacity={boardIn} />
            ))}
          </svg>
          {(Object.keys(NODES) as Who[]).map((who) => {
            const hit = MESSAGES.find((m) => m.to === who && frame >= m.at + FLIGHT && frame < m.at + FLIGHT + 18)
            const bounce = hit ? Math.sin(((frame - hit.at - FLIGHT) / 18) * Math.PI) * 0.18 : 0
            const [x, y] = NODES[who]
            return (
              <div key={who} style={{ position: 'absolute', left: x - 60, top: y - 46, width: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: boardIn, transform: `scale(${1 + bounce})` }}>
                <div style={{ borderRadius: 99, boxShadow: hit ? `0 0 0 6px ${colorOf(who)}33` : undefined }}>
                  <Avatar who={who} size={92} happy={frame > STAMP + 20} />
                </div>
                <div style={{ marginTop: 8, fontSize: 18, fontWeight: 650, fontFamily: FONT, color: colorOf(who) }}>{who}</div>
              </div>
            )
          })}
          {MESSAGES.map((m) => {
            const t = tween(frame, m.at, m.at + FLIGHT, 0, 1, EASE_IN_OUT)
            if (frame < m.at || frame > m.at + FLIGHT + 10) return null
            const a = NODES[m.from]
            const b = NODES[m.to]
            const ctrl: [number, number] = [(a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.25, (a[1] + b[1]) / 2 - 70]
            const [x, y] = quad(t, a, ctrl, b)
            const grow = sp(frame, m.at, SPRING.pop)
            const fade = 1 - tween(frame, m.at + FLIGHT - 4, m.at + FLIGHT + 10)
            const mention = m.text.split(' ')[0] ?? ''
            return (
              <div
                key={m.at}
                style={{
                  position: 'absolute',
                  left: x,
                  top: y - 112,
                  transform: `translateX(-50%) scale(${grow * lerp(1, 0.6, tween(frame, m.at + FLIGHT - 10, m.at + FLIGHT))})`,
                  opacity: fade,
                  whiteSpace: 'nowrap',
                  padding: '10px 16px',
                  borderRadius: 18,
                  borderBottomLeftRadius: 6,
                  background: '#24242a',
                  boxShadow: `0 0 0 1px ${colorOf(m.from)}66, 0 14px 30px -10px rgba(0,0,0,0.8)`,
                  fontFamily: FONT,
                  fontSize: 21,
                  fontWeight: 520,
                  color: C.label,
                }}
              >
                <span style={{ color: colorOf(m.to), fontWeight: 650 }}>{mention}</span>
                {m.text.slice(mention.length)}
              </div>
            )
          })}
        </AbsoluteFill>

        <AbsoluteFill style={{ top: 66, height: 'auto', alignItems: 'center' }}>
          <Caption text="They talk. *They check each other.*" start={10} end={STAMP - 14} size={72} />
        </AbsoluteFill>

        {/* The reviewer's stamp. */}
        <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} />
        {frame >= STAMP && (
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            <div
              style={{
                transform: `rotate(${lerp(-14, -4, stampT)}deg) scale(${lerp(2.6, 1, stampT)})`,
                opacity: clamp(stampT * 3, 0, 1),
                display: 'flex',
                alignItems: 'center',
                gap: 34,
                padding: '38px 54px',
                borderRadius: 34,
                background: 'rgba(20,24,8,0.92)',
                boxShadow: `0 0 0 4px ${C.judge}, 0 0 0 14px rgba(212,255,58,0.12), 0 0 120px rgba(212,255,58,0.25), 0 60px 120px -30px rgba(0,0,0,0.9)`,
                fontFamily: FONT,
              }}
            >
              <div style={{ padding: 18, borderRadius: 26, background: C.screen }}>
                <LedScreen bezel={false} cols={7} rows={7} cell={16} color={C.judge} eyes={{ mood: frame > STAMP + 60 ? 'happy' : 'open' }} />
              </div>
              <div>
                <div style={{ fontSize: 92, fontWeight: 760, color: C.judge, letterSpacing: '-0.04em', lineHeight: 1 }}>
                  Reviewed · 0.96
                </div>
                <div style={{ fontSize: 36, color: C.label2, marginTop: 16, letterSpacing: '-0.01em' }}>tests pass, sources checked</div>
              </div>
            </div>
          </AbsoluteFill>
        )}
        {impact > 0 && impact < 32 && (
          <div
            style={{
              position: 'absolute',
              left: 960 - 420 - impact * 12,
              top: 540 - 130 - impact * 4,
              width: 840 + impact * 24,
              height: 260 + impact * 8,
              borderRadius: 60 + impact * 3,
              transform: 'rotate(-4deg)',
              border: `2px solid rgba(212,255,58,${0.35 * (1 - impact / 32)})`,
            }}
          />
        )}
      </Stage>
    </Shot>
  )
}
