import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { SPRING, clamp, noise, sp, tween } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon } from '../components/Icon.tsx'
import { LogoTile } from '../components/Led.tsx'
import { Phone } from '../components/Phone.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { Dot } from '../components/Ui.tsx'
import { C, FONT, MONO } from '../theme.ts'

const ACCEPT = 100
const LINE1: [number, number] = [136, 262]
const LINE2: [number, number] = [290, 476]
const LINES = [LINE1, LINE2]
const PAGE_AT = 150

/** How loud the agent is speaking: syllables while a line is being said, silence between. */
function voice(frame: number): number {
  const on = LINES.some(([a, b]) => frame >= a && frame < b - 40)
  if (!on) return 0.04
  const syll = (Math.sin(frame / 3.1) + 1) / 2
  return clamp(0.25 + 0.75 * syll * (0.6 + 0.4 * noise(frame / 8, 4)), 0, 1)
}

function LivePage(props: { t: number }) {
  return (
    <div
      style={{
        width: 820,
        height: 440,
        borderRadius: 20,
        overflow: 'hidden',
        background: '#f5f5f7',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 50px 100px -30px rgba(0,0,0,0.95)',
        fontFamily: FONT,
        opacity: clamp(props.t * 1.5, 0, 1),
        transform: `translateY(${(1 - props.t) * 60}px) rotate(${(1 - props.t) * 3}deg)`,
      }}
    >
      <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', background: '#1a1a1e' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <span key={c} style={{ width: 11, height: 11, borderRadius: 9, background: c }} />
        ))}
        <div style={{ marginLeft: 14, flex: 1, height: 30, borderRadius: 8, background: '#2a2a30', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
          <Icon name="lock" size={14} color={C.label3} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.label2 }}>acme.dev/pricing</span>
        </div>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginLeft: 10,
            padding: '5px 12px',
            borderRadius: 99,
            background: 'rgba(61,220,132,0.16)',
            color: C.ok,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '0.08em',
          }}
        >
          <Dot color={C.ok} size={8} /> LIVE
        </span>
      </div>
      <div style={{ padding: '30px 40px', color: '#1d1d1f' }}>
        <div style={{ fontSize: 34, fontWeight: 760, letterSpacing: '-0.035em' }}>Simple pricing</div>
        <div style={{ fontSize: 17, color: '#6e6e73', marginTop: 4 }}>Start free. Upgrade when your team does.</div>
        <div style={{ display: 'flex', gap: 18, marginTop: 26 }}>
          {[
            ['Starter', '$0'],
            ['Pro', '$39'],
            ['Team', '$89'],
          ].map(([tier, price]) => {
            const pro = tier === 'Pro'
            return (
              <div
                key={tier}
                style={{
                  flex: 1,
                  height: 196,
                  borderRadius: 16,
                  padding: 20,
                  position: 'relative',
                  background: pro ? '#1d1d1f' : '#ffffff',
                  color: pro ? '#fff' : '#1d1d1f',
                  boxShadow: pro ? `0 0 0 3px ${C.accent}` : 'inset 0 0 0 1px rgba(0,0,0,0.1)',
                }}
              >
                {pro && (
                  <span style={{ position: 'absolute', top: -13, left: 18, fontSize: 12, fontWeight: 800, padding: '4px 10px', borderRadius: 99, background: C.accent, color: '#1a1204' }}>
                    MOST POPULAR
                  </span>
                )}
                <div style={{ fontSize: 18, opacity: 0.7 }}>{tier}</div>
                <div style={{ fontSize: 44, fontWeight: 780, letterSpacing: '-0.04em', marginTop: 4 }}>
                  {price}
                  <span style={{ fontSize: 17, fontWeight: 500, opacity: 0.6 }}> /mo</span>
                </div>
                {[0.85, 0.65].map((w) => (
                  <div key={w} style={{ height: 7, width: `${w * 100}%`, borderRadius: 4, background: pro ? '#3a3a40' : '#e5e5ea', marginTop: 14 }} />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function Call(props: { dur: number }) {
  const frame = useCurrentFrame()
  const phoneIn = sp(frame, 0, SPRING.smooth)
  const ringing = frame < ACCEPT
  const buzz = ringing && frame % 50 < 24 ? Math.sin(frame * 2.2) * 2.2 : 0
  const accepted = sp(frame, ACCEPT, SPRING.pop)
  const page = sp(frame, PAGE_AT, SPRING.smooth)
  const v = voice(frame)
  const secs = Math.max(0, Math.floor((frame - ACCEPT) / 60))
  const tap = tween(frame, ACCEPT - 10, ACCEPT + 20)

  return (
    <Shot dur={props.dur}>
      <Stage glow={{ x: 600, y: 420, strength: 0.9 + (ringing ? 0.3 * Math.sin(frame / 8) : v * 0.5), size: 1000 }}>
        <div
          style={{
            position: 'absolute',
            left: 600 - 220,
            top: 540 - 453 + (1 - phoneIn) * 600,
            transform: `rotate(${buzz}deg)`,
          }}
        >
          <Phone width={440} screenBg="radial-gradient(120% 60% at 50% 18%, #3a2608 0%, #120d06 45%, #08080a 100%)">
            <div style={{ position: 'absolute', top: 150, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ position: 'relative', width: 150, height: 150 }}>
                {ringing &&
                  [0, 1, 2].map((k) => {
                    const r = ((frame + k * 20) % 60) / 60
                    return (
                      <div
                        key={k}
                        style={{
                          position: 'absolute',
                          inset: -r * 70,
                          borderRadius: 999,
                          border: `2px solid rgba(255,179,26,${0.5 * (1 - r)})`,
                        }}
                      />
                    )
                  })}
                <LogoTile size={150} glow={0.6 + v} eyes={{ mood: ringing ? 'open' : v > 0.55 ? 'squint' : frame > LINE2[1] - 30 ? 'happy' : 'open', blink: frame % 170 > 163 }} />
              </div>
              <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 34 }}>Myrmidon</div>
              <div style={{ fontFamily: ringing ? FONT : MONO, fontSize: 20, color: ringing ? C.label3 : C.ok, marginTop: 8 }}>
                {ringing ? 'incoming call…' : `00:${String(secs).padStart(2, '0')}`}
              </div>
            </div>
            {/* The live waveform. */}
            <div
              style={{
                position: 'absolute',
                top: 520,
                left: 40,
                right: 40,
                height: 110,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                opacity: accepted,
              }}
            >
              {Array.from({ length: 26 }, (_, i) => {
                const centre = 1 - Math.abs(i - 12.5) / 14
                const h = 6 + v * 100 * centre * (0.45 + 0.55 * Math.abs(noise(frame / 4 + i * 0.7, i)))
                return <span key={i} style={{ width: 7, height: h, borderRadius: 4, background: `linear-gradient(180deg, ${C.eyeTop}, ${C.eyeBottom})` }} />
              })}
            </div>
            <div style={{ position: 'absolute', bottom: 78, left: 0, right: 0, display: 'flex', justifyContent: ringing ? 'space-around' : 'center', padding: '0 50px', gap: 40 }}>
              {ringing ? (
                <>
                  <div style={{ width: 86, height: 86, borderRadius: 99, background: '#ff3b30', display: 'grid', placeItems: 'center', transform: 'rotate(135deg)' }}>
                    <Icon name="phone" size={38} color="#fff" fill="#fff" stroke={0} />
                  </div>
                  <div style={{ width: 86, height: 86, borderRadius: 99, background: '#34c759', display: 'grid', placeItems: 'center', transform: `scale(${1 + Math.sin(frame / 5) * 0.04})` }}>
                    <Icon name="phone" size={38} color="#fff" fill="#fff" stroke={0} />
                  </div>
                </>
              ) : (
                <>
                  {(['mic', 'monitor'] as const).map((n) => (
                    <div key={n} style={{ width: 76, height: 76, borderRadius: 99, background: 'rgba(255,255,255,0.12)', display: 'grid', placeItems: 'center', opacity: accepted }}>
                      <Icon name={n} size={32} color="#fff" />
                    </div>
                  ))}
                  <div style={{ width: 76, height: 76, borderRadius: 99, background: '#ff3b30', display: 'grid', placeItems: 'center', transform: 'rotate(135deg)', opacity: accepted }}>
                    <Icon name="phone" size={32} color="#fff" fill="#fff" stroke={0} />
                  </div>
                </>
              )}
            </div>
            {tap > 0 && tap < 1 && (
              <div
                style={{
                  position: 'absolute',
                  right: 50 + 43 - 50 * tap,
                  bottom: 78 + 43 - 50 * tap,
                  width: 100 * tap,
                  height: 100 * tap,
                  borderRadius: 999,
                  background: `rgba(255,255,255,${0.35 * (1 - tap)})`,
                }}
              />
            )}
          </Phone>
        </div>

        <div style={{ position: 'absolute', left: 1000, top: 120 }}>{page > 0.001 && <LivePage t={page} />}</div>

        <AbsoluteFill style={{ left: 1000, top: 420, width: 860, height: 'auto' }}>
          <Caption text="Then it *calls you back.*" start={14} end={PAGE_AT - 24} size={84} align="left" />
        </AbsoluteFill>
        <div
          style={{
            position: 'absolute',
            left: 1000,
            top: 640,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontFamily: MONO,
            fontSize: 18,
            letterSpacing: '0.16em',
            color: C.label3,
            opacity: tween(frame, LINE1[0] - 20, LINE1[0]),
          }}
        >
          <Dot color={C.accent} size={9} pulse={v} /> MYRMIDON · ON THE CALL
        </div>
        <AbsoluteFill style={{ left: 1000, top: 690, width: 840, height: 'auto' }}>
          <Caption text="“Pricing page is *live.*”" start={LINE1[0]} end={LINE1[1]} size={72} align="left" />
        </AbsoluteFill>
        <AbsoluteFill style={{ left: 1000, top: 690, width: 840, height: 'auto' }}>
          <Caption text="“You're *$10 below* the average competitor.”" start={LINE2[0]} end={props.dur + 20} size={68} align="left" width={840} stagger={3} />
        </AbsoluteFill>
      </Stage>
    </Shot>
  )
}
