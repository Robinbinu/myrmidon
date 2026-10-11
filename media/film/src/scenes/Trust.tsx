import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASE_IN_OUT, SPRING, clamp, lerp, quad, rand, sp, tween } from '../anim.ts'
import { Icon } from '../components/Icon.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { Cursor } from '../components/Ui.tsx'
import { C, CREW, FONT, MONO } from '../theme.ts'

const WORDS = ['Sandboxed.', 'Logged.', 'Yours.']
const WORD_AT = [16, 52, 88]
const RISE = 168
const CARD_AT = 184
const TAP = 286

const ACTS: [string, string, string][] = [
  ['nova', 'browser.open', 'northwind.com/pricing'],
  ['nova', 'browser.read', 'contoso.io/pricing'],
  ['lead', 'task.assign', 'quill · build /pricing'],
  ['quill', 'fs.write', 'app/pricing/page.tsx'],
  ['quill', 'shell.run', 'bun test (sandbox)'],
  ['iris', 'computer.drag', 'Pricing cards › Pro'],
  ['iris', 'computer.click', 'Export'],
  ['judge', 'review.pass', 'score 0.96'],
  ['quill', 'git.commit', 'worktree quill/pricing'],
  ['lead', 'budget.check', '$1.84 of $5'],
  ['nova', 'cite.add', '[3] fabrikam.app'],
  ['quill', 'net.blocked', 'unknown host (sandbox)'],
  ['lead', 'approval.ask', 'deploy → production'],
]

const colorFor = (who: string) =>
  who === 'lead' ? C.accent : who === 'judge' ? C.judge : (CREW[who as keyof typeof CREW]?.color ?? C.label3)

/** The append-only event log, scrolling up behind everything. */
function EventLog(props: { frame: number }) {
  const rowH = 46
  const rows = 40
  const scroll = props.frame * 0.9
  return (
    <div
      style={{
        position: 'absolute',
        left: 180,
        right: 180,
        top: 0,
        bottom: 0,
        overflow: 'hidden',
        maskImage: 'linear-gradient(180deg, transparent 0%, black 22%, black 78%, transparent 100%)',
        opacity: 0.42,
      }}
    >
      <div style={{ position: 'absolute', left: 0, right: 0, top: 1080 - scroll - rows * rowH * 0.4 }}>
        {Array.from({ length: rows }, (_, i) => {
          const a = ACTS[i % ACTS.length] ?? ACTS[0]
          if (!a) return null
          const seq = 2007 + i
          const hash = Math.floor(rand(i) * 0xffffff).toString(16).padStart(6, '0')
          return (
            <div key={seq} style={{ height: rowH, display: 'flex', alignItems: 'center', gap: 28, fontFamily: MONO, fontSize: 21, color: C.label4, whiteSpace: 'nowrap' }}>
              <span style={{ width: 70 }}>#{seq}</span>
              <span style={{ width: 110 }}>21:{String(4 + Math.floor(i / 6)).padStart(2, '0')}:{String((i * 7) % 60).padStart(2, '0')}</span>
              <span style={{ width: 80, color: colorFor(a[0]) }}>{a[0]}</span>
              <span style={{ width: 210, color: C.label3 }}>{a[1]}</span>
              <span style={{ flex: 1 }}>{a[2]}</span>
              <span>sha {hash}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Trust(props: { dur: number }) {
  const frame = useCurrentFrame()
  const rise = tween(frame, RISE, RISE + 34, 0, 1, EASE_IN_OUT)
  const card = sp(frame, CARD_AT, SPRING.smooth)
  const allowed = frame >= TAP + 4
  const allowedT = sp(frame, TAP + 4, SPRING.pop)

  // Alex's pointer: in from the lower right, onto Allow.
  const allow: [number, number] = [1250, 650]
  const approach = quad(tween(frame, CARD_AT + 30, TAP - 6, 0, 1, EASE_IN_OUT), [1560, 1060], [1450, 760], allow)
  const leave = tween(frame, TAP + 10, TAP + 44, 0, 1, EASE_IN_OUT)
  const cur = [lerp(approach[0], 1500, leave), lerp(approach[1], 900, leave)]
  const press = frame >= TAP - 4 && frame < TAP + 6 ? 1 : 0
  const ring = tween(frame, TAP, TAP + 26)

  return (
    <Shot dur={props.dur}>
      <Stage glow={{ x: 960, y: lerp(540, 640, rise), strength: 0.5, size: 1400 }}>
        <EventLog frame={frame} />
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse 760px 300px at 50% ${lerp(50, 24, rise)}%, rgba(5,5,6,0.92) 0%, rgba(5,5,6,0.6) 55%, transparent 100%)`,
          }}
        />
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            transform: `translateY(${lerp(0, -300, rise)}px) scale(${lerp(1, 0.62, rise)})`,
          }}
        >
          <div style={{ display: 'flex', gap: 46, fontFamily: FONT, fontSize: 132, fontWeight: 700, letterSpacing: '-0.045em', color: C.label }}>
            {WORDS.map((w, i) => {
              const t = sp(frame, WORD_AT[i] ?? 0, SPRING.snappy)
              return (
                <span
                  key={w}
                  style={{
                    display: 'inline-block',
                    opacity: clamp(t * 1.4, 0, 1),
                    transform: `translateY(${(1 - t) * 60}px)`,
                    filter: t < 0.95 ? `blur(${(1 - t) * 14}px)` : undefined,
                    color: i === 2 ? C.accent : C.label,
                  }}
                >
                  {w}
                </span>
              )
            })}
          </div>
        </AbsoluteFill>

        {card > 0.001 && (
          <div
            style={{
              position: 'absolute',
              left: 960 - 430,
              top: 430 + (1 - card) * 640,
              width: 860,
              borderRadius: 30,
              padding: '34px 38px',
              background: 'linear-gradient(180deg, #19191d 0%, #131316 100%)',
              boxShadow: `0 0 0 1px ${allowed ? 'rgba(61,220,132,0.5)' : 'rgba(255,255,255,0.12)'}, 0 60px 120px -30px rgba(0,0,0,0.95)`,
              fontFamily: FONT,
              color: C.label,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ width: 64, height: 64, borderRadius: 18, display: 'grid', placeItems: 'center', background: allowed ? C.okSoft : C.accentSoft, color: allowed ? C.ok : C.accent }}>
                <Icon name={allowed ? 'check' : 'shield'} size={34} stroke={2} />
              </div>
              <div>
                <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em' }}>Publish to production?</div>
                <div style={{ fontSize: 22, color: C.label3, marginTop: 6 }}>
                  <span style={{ color: CREW.quill.color, fontWeight: 600 }}>quill</span> wants to deploy{' '}
                  <span style={{ fontFamily: MONO, color: C.label2 }}>acme.dev/pricing</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 26, fontFamily: MONO, fontSize: 18, color: C.label2 }}>
              {['3 files changed', '18 tests passed', 'reviewed 0.96'].map((t) => (
                <span key={t} style={{ padding: '8px 14px', borderRadius: 10, background: C.fill, boxShadow: `inset 0 0 0 1px ${C.separator}` }}>
                  {t}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, marginTop: 30, height: 64 }}>
              {allowed ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    fontSize: 24,
                    fontWeight: 600,
                    color: C.ok,
                    opacity: allowedT,
                    transform: `translateY(${(1 - allowedT) * 12}px)`,
                  }}
                >
                  <Icon name="check" size={26} stroke={2.4} />
                  Allowed by Alex · logged as <span style={{ fontFamily: MONO }}>#2047</span>
                </div>
              ) : (
                <>
                  <div style={{ width: 170, borderRadius: 16, display: 'grid', placeItems: 'center', fontSize: 25, fontWeight: 600, background: C.control, color: C.label2 }}>Deny</div>
                  <div
                    style={{
                      width: 190,
                      borderRadius: 16,
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 25,
                      fontWeight: 700,
                      background: C.accent,
                      color: '#1a1204',
                      transform: `scale(${1 - press * 0.06})`,
                      boxShadow: '0 10px 30px -8px rgba(255,179,26,0.6)',
                    }}
                  >
                    Allow
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {ring > 0 && ring < 1 && (
          <div
            style={{
              position: 'absolute',
              left: allow[0] - 20 - ring * 50,
              top: allow[1] - 20 - ring * 50,
              width: 40 + ring * 100,
              height: 40 + ring * 100,
              borderRadius: 999,
              border: `2px solid rgba(255,179,26,${1 - ring})`,
            }}
          />
        )}
        {frame >= CARD_AT + 30 && frame < TAP + 70 && (
          <Cursor
            color={C.user}
            size={46}
            press={press}
            label="Alex"
            tilt={-8}
            style={{ left: cur[0], top: cur[1], opacity: 1 - tween(frame, TAP + 24, TAP + 50) }}
          />
        )}
      </Stage>
    </Shot>
  )
}
