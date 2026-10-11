import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASE_IN_OUT, SPRING, clamp, lerp, quad, sp, tween, typed } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon } from '../components/Icon.tsx'
import { LedScreen, LogoTile } from '../components/Led.tsx'
import { Phone } from '../components/Phone.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { Composer, MacWindow } from '../components/Ui.tsx'
import { C, FONT } from '../theme.ts'

export const ASK = "Launch our pricing page tonight. Check what competitors charge. Call me when it's live."

const TYPE_START = 44
const TYPE_CPS = 46
const SENT = 162
const WIN_IN = 196
const LIFT = 232
const LAND = 292
const POSTED = 330

const PHONE_X = 560
const PHONE_W = 430
const WIN = { x: 905, y: 200, w: 940, h: 690 }
/** Where the composer sits on screen, inside the window. */
const COMPOSER_AT = { x: WIN.x + 80, y: WIN.y + 52 + 380 }

function Bubble(props: { text: string; mine?: boolean; width?: number; size?: number }) {
  return (
    <div
      style={{
        maxWidth: props.width ?? 300,
        padding: '14px 18px',
        borderRadius: 24,
        borderBottomRightRadius: props.mine ? 8 : 24,
        borderBottomLeftRadius: props.mine ? 24 : 8,
        background: props.mine ? C.accent : '#1f1f24',
        color: props.mine ? '#1a1204' : C.label,
        fontSize: props.size ?? 23,
        lineHeight: 1.32,
        fontWeight: props.mine ? 520 : 440,
        letterSpacing: '-0.01em',
        fontFamily: FONT,
      }}
    >
      {props.text}
    </div>
  )
}

export function Ask(props: { dur: number }) {
  const frame = useCurrentFrame()
  const phoneIn = sp(frame, 0, SPRING.smooth)
  const draft = frame < SENT ? typed(ASK, frame, TYPE_START, TYPE_CPS) : ''
  const sentIn = sp(frame, SENT, SPRING.pop)
  const winIn = sp(frame, WIN_IN, SPRING.smooth)

  // The flight: the bubble lifts off the phone and arcs into the window's composer.
  const fly = tween(frame, LIFT + 8, LAND, 0, 1, EASE_IN_OUT)
  const lift = sp(frame, LIFT, SPRING.snappy)
  const bubbleHome: [number, number] = [444, 760]
  const [bx, by] = quad(fly, bubbleHome, [1000, 120], [COMPOSER_AT.x + 10, COMPOSER_AT.y + 4])
  const landed = frame >= LAND
  const landFlash = tween(frame, LAND, LAND + 40)
  const posted = sp(frame, POSTED, SPRING.pop)

  const mascotEyes =
    frame < WIN_IN + 40
      ? { look: [0, 0] as const }
      : frame < LAND
        ? { look: [Math.round(lerp(-2, 0, fly)), 1] as const }
        : frame < POSTED + 10
          ? { mood: 'wide' as const }
          : { mood: 'happy' as const }

  return (
    <Shot dur={props.dur}>
      <Stage glow={{ x: lerp(PHONE_X, 1300, winIn), y: 560, strength: 0.9, size: 1100 }}>
        {/* The phone, Alex's messenger open on a chat with Myrmidon. */}
        <div
          style={{
            position: 'absolute',
            left: PHONE_X - PHONE_W / 2,
            top: 540 - (PHONE_W * 2.06) / 2 + (1 - phoneIn) * 500,
            transform: `rotate(${(1 - phoneIn) * -6 - winIn * 2}deg)`,
          }}
        >
          <Phone width={PHONE_W}>
            <div
              style={{
                position: 'absolute',
                top: 52,
                left: 0,
                right: 0,
                height: 92,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '0 22px',
                borderBottom: `1px solid ${C.separator}`,
                background: 'rgba(20,20,24,0.9)',
              }}
            >
              <span style={{ color: C.accent, fontSize: 34, fontWeight: 300, marginRight: 4 }}>‹</span>
              <LogoTile size={52} />
              <div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>Myrmidon</div>
                <div style={{ fontSize: 16, color: C.ok }}>online</div>
              </div>
              <div style={{ flex: 1 }} />
              <Icon name="phone" size={26} color={C.accent} />
            </div>
            <div
              style={{
                position: 'absolute',
                top: 160,
                left: 18,
                right: 18,
                bottom: 120,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                gap: 12,
                overflow: 'hidden',
              }}
            >
              <div style={{ alignSelf: 'center', fontSize: 15, color: C.label4, marginBottom: 6 }}>Yesterday</div>
              <div style={{ alignSelf: 'flex-end' }}>
                <Bubble mine text="Summarise the support inbox?" />
              </div>
              <div style={{ alignSelf: 'flex-start' }}>
                <Bubble text="Done. 3 refunds, 1 bug. Filed it." />
              </div>
              <div style={{ alignSelf: 'center', fontSize: 15, color: C.label4, margin: '6px 0' }}>Today 6:12 PM</div>
              <div style={{ alignSelf: 'flex-start' }}>
                <Bubble text="Evening, Alex. Both overnight runs are done." />
              </div>
              <div style={{ alignSelf: 'flex-end' }}>
                <Bubble mine text="Nice. Next one's big." />
              </div>
              {frame >= SENT && (
                <div
                  style={{
                    alignSelf: 'flex-end',
                    transform: `translateY(${(1 - sentIn) * 60}px) scale(${lerp(0.8, 1, sentIn)})`,
                    transformOrigin: '100% 100%',
                    opacity: frame >= LIFT + 8 ? 0.25 : 1,
                  }}
                >
                  <Bubble mine text={ASK} />
                </div>
              )}
            </div>
            <div
              style={{
                position: 'absolute',
                left: 16,
                right: 16,
                bottom: 30,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 10,
              }}
            >
              <div
                style={{
                  flex: 1,
                  minHeight: 54,
                  padding: '13px 18px',
                  borderRadius: 27,
                  boxShadow: `inset 0 0 0 1.5px ${C.separatorStrong}`,
                  fontSize: 21,
                  lineHeight: 1.3,
                  color: draft ? C.label : C.label4,
                }}
              >
                {draft || 'Message'}
                {frame >= TYPE_START - 20 && frame < SENT && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 2,
                      height: 24,
                      marginLeft: 2,
                      verticalAlign: '-4px',
                      background: C.accent,
                      opacity: Math.floor(frame / 20) % 2 === 0 || draft.length < ASK.length ? 1 : 0,
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: 99,
                  display: 'grid',
                  placeItems: 'center',
                  background: draft ? C.accent : C.control,
                  color: '#1a1204',
                  transform: `scale(${frame >= SENT - 6 && frame < SENT + 4 ? 0.86 : 1})`,
                }}
              >
                <Icon name="arrowUp" size={26} stroke={2.4} />
              </div>
            </div>
          </Phone>
        </div>

        {/* The app, on the Mac. */}
        {winIn > 0.001 && (
          <div
            style={{
              position: 'absolute',
              left: WIN.x + (1 - winIn) * 900,
              top: WIN.y,
              opacity: clamp(winIn * 1.6, 0, 1),
            }}
          >
            <MacWindow width={WIN.w} height={WIN.h} title="Myrmidon">
              <div style={{ position: 'absolute', top: 34, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
                <LedScreen
                  cell={15}
                  eyes={mascotEyes}
                  status={frame >= POSTED ? 'PLANNING' : 'READY'}
                  statusColor={frame >= POSTED ? C.accent : C.ok}
                  readout={frame >= POSTED ? '3 TASKS' : 'HI ALEX'}
                />
              </div>
              <div
                style={{
                  position: 'absolute',
                  top: 300,
                  left: 0,
                  right: 0,
                  textAlign: 'center',
                  fontSize: 30,
                  fontWeight: 620,
                  letterSpacing: '-0.02em',
                  color: C.label,
                  opacity: 1 - posted,
                }}
              >
                What should the crew do tonight?
              </div>
              {frame >= POSTED && (
                <div
                  style={{
                    position: 'absolute',
                    top: 248,
                    right: 80,
                    transform: `translateY(${(1 - posted) * 120}px)`,
                    opacity: clamp(posted * 2, 0, 1),
                  }}
                >
                  <div
                    style={{
                      maxWidth: 620,
                      padding: '14px 20px',
                      borderRadius: 20,
                      background: '#2a2a31',
                      fontSize: 22,
                      lineHeight: 1.35,
                      color: C.label,
                    }}
                  >
                    {ASK}
                  </div>
                </div>
              )}
              <div style={{ position: 'absolute', left: 80, top: 380 }}>
                <Composer
                  width={780}
                  text={landed && frame < POSTED ? ASK.slice(0, 44) + '…' : ''}
                  glow={0.5 + landFlash * (1 - landFlash) * 3}
                  placeholder="Describe what you want done…"
                  caret={frame < LAND || frame >= POSTED}
                />
              </div>
            </MacWindow>
          </div>
        )}

        {/* The message in flight. */}
        {frame >= LIFT && frame < LAND + 2 && (
          <div
            style={{
              position: 'absolute',
              left: bx,
              top: by,
              transform: `translate(0, -50%) scale(${lerp(1 + 0.06 * lift, 0.8, fly)}) rotate(${Math.sin(fly * Math.PI) * -5}deg)`,
              transformOrigin: '0 50%',
              filter: `drop-shadow(0 ${20 * lift}px ${30 * lift}px rgba(0,0,0,0.6)) drop-shadow(0 0 ${24 * Math.sin(fly * Math.PI)}px rgba(255,179,26,0.6))`,
              opacity: 1 - tween(frame, LAND - 6, LAND + 2),
            }}
          >
            <Bubble mine text={ASK} />
          </div>
        )}

        <AbsoluteFill style={{ left: 940, top: 430, width: 900, height: 'auto' }}>
          <Caption text="Text it like *a teammate.*" start={30} end={WIN_IN - 10} size={84} align="left" />
        </AbsoluteFill>
      </Stage>
    </Shot>
  )
}
