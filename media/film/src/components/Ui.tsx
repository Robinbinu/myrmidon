import type { CSSProperties, ReactNode } from 'react'
import { C, CREW, type CrewName, FONT, MONO } from '../theme.ts'
import { Icon, type IconName } from './Icon.tsx'

/** Dark or light text on a fill, whichever has more contrast (the app's inkOn). */
export function inkOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const ch = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * ch(((n >> 16) & 255) / 255) + 0.7152 * ch(((n >> 8) & 255) / 255) + 0.0722 * ch((n & 255) / 255)
  return (lum + 0.05) / 0.0534 > 1.05 / (lum + 0.05) ? '#0b0b0d' : '#ffffff'
}

/** A macOS window in the app's dark material: hairline border, traffic lights, a title. */
export function MacWindow(props: {
  width: number
  height: number
  title?: ReactNode
  children?: ReactNode
  style?: CSSProperties
  right?: ReactNode
}) {
  return (
    <div
      style={{
        width: props.width,
        height: props.height,
        borderRadius: 18,
        background: C.content,
        boxShadow:
          '0 0 0 1px rgba(255,255,255,0.09), inset 0 1px 0 rgba(255,255,255,0.05), 0 50px 120px -30px rgba(0,0,0,0.95), 0 20px 40px -20px rgba(0,0,0,0.8)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT,
        color: C.label,
        ...props.style,
      }}
    >
      <div
        style={{
          height: 52,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 20px',
          borderBottom: `1px solid ${C.separator}`,
          background: '#0e0e11',
        }}
      >
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: 99, background: c, opacity: 0.9 }} />
        ))}
        <div style={{ marginLeft: 18, fontSize: 18, fontWeight: 560, color: C.label2, flex: 1 }}>{props.title}</div>
        {props.right}
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>{props.children}</div>
    </div>
  )
}

/** A rounded tag: a status, a chip, a label. */
export function Pill(props: {
  children: ReactNode
  color?: string
  bg?: string
  border?: string
  size?: number
  icon?: IconName
  mono?: boolean
  style?: CSSProperties
}) {
  const size = props.size ?? 18
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size * 0.4,
        height: size * 1.9,
        padding: `0 ${size * 0.72}px`,
        borderRadius: 999,
        fontFamily: props.mono ? MONO : FONT,
        fontSize: size,
        fontWeight: 540,
        whiteSpace: 'nowrap',
        color: props.color ?? C.label2,
        background: props.bg ?? C.fill,
        boxShadow: `inset 0 0 0 1px ${props.border ?? C.separatorStrong}`,
        ...props.style,
      }}
    >
      {props.icon && <Icon name={props.icon} size={size * 1.05} />}
      {props.children}
    </span>
  )
}

const BODIES = {
  gumdrop: {
    draw: (fill: string) => (
      <path d="M50 8C57 8 62 14 67 24L87 66C93 80 86 93 70 93H30C14 93 7 80 13 66L33 24C38 14 43 8 50 8Z" fill={fill} />
    ),
    eyeY: 60,
    eyeGap: 20,
  },
  ball: { draw: (fill: string) => <circle cx="50" cy="54" r="40" fill={fill} />, eyeY: 50, eyeGap: 20 },
  flower: {
    draw: (fill: string) => (
      <g fill={fill}>
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <circle key={a} cx={50 + 24 * Math.cos((a * Math.PI) / 180)} cy={54 + 24 * Math.sin((a * Math.PI) / 180)} r="17" />
        ))}
        <circle cx="50" cy="54" r="27" />
      </g>
    ),
    eyeY: 53,
    eyeGap: 20,
  },
} as const

/** A worker's character (the app's AgentCharacter): its body in its colour, with ink capsule eyes. */
export function Crewmate(props: {
  who: CrewName
  size: number
  blink?: boolean
  look?: readonly [number, number]
  happy?: boolean
  style?: CSSProperties
}) {
  const c = CREW[props.who]
  const body = BODIES[c.form]
  const xs = [50 - body.eyeGap / 2, 50 + body.eyeGap / 2]
  const [lx, ly] = props.look ?? [0, 0]
  const h = props.blink ? 2 : 12
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 100 100" style={{ display: 'block', overflow: 'visible', ...props.style }}>
      {body.draw(c.color)}
      {props.happy ? (
        <g fill="none" stroke={C.ink} strokeWidth="4" strokeLinecap="round">
          {xs.map((x) => (
            <path key={x} d={`M${x - 5} ${body.eyeY + 2}Q${x} ${body.eyeY - 5} ${x + 5} ${body.eyeY + 2}`} />
          ))}
        </g>
      ) : (
        <g fill={C.ink}>
          {xs.map((x) => (
            <rect key={x} x={x - 3.5 + lx} y={body.eyeY - h / 2 + ly} width="7" height={h} rx="3.5" />
          ))}
        </g>
      )}
    </svg>
  )
}

/** A collaborator's cursor (the app's CrewCursor arrowhead) with its name tag. */
export function Cursor(props: {
  color: string
  label?: ReactNode
  size?: number
  press?: number
  labelScale?: number
  tilt?: number
  style?: CSSProperties
}) {
  const size = props.size ?? 34
  const ink = inkOn(props.color)
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, ...props.style }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{
          position: 'absolute',
          left: -size * 0.1,
          top: -size * 0.1,
          transform: `rotate(${props.tilt ?? 0}deg) scale(${1 - (props.press ?? 0) * 0.12})`,
          transformOrigin: '10% 10%',
          filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.5))',
        }}
      >
        <path
          d="M3.6 2.4c-.8-.3-1.5.4-1.2 1.2l6.5 16.6c.3.8 1.4.8 1.7 0l2.6-6.6 6.6-2.6c.8-.3.8-1.4 0-1.7L3.6 2.4Z"
          fill={props.color}
          stroke="rgba(0,0,0,0.3)"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
      {props.label && (
        <div
          style={{
            position: 'absolute',
            left: size * 0.78,
            top: size * 0.82,
            transform: `scale(${props.labelScale ?? 1})`,
            transformOrigin: '0 0',
            whiteSpace: 'nowrap',
            fontFamily: FONT,
            fontSize: size * 0.56,
            fontWeight: 600,
            lineHeight: 1,
            padding: `${size * 0.2}px ${size * 0.34}px`,
            borderRadius: 999,
            color: ink,
            background: props.color,
            boxShadow: '0 6px 16px -6px rgba(0,0,0,0.7)',
          }}
        >
          {props.label}
        </div>
      )}
    </div>
  )
}

/** The crew's cursor tag, "nova · researcher · Claude", with the parts set apart. */
export function CrewTag(props: { who: CrewName }) {
  const c = CREW[props.who]
  return (
    <span>
      {c.name}
      <span style={{ opacity: 0.62, fontWeight: 500 }}> · {c.role} · {c.model}</span>
    </span>
  )
}

/** The composer: the one box everything starts from. */
export function Composer(props: {
  width: number
  text?: string
  placeholder?: string
  caret?: boolean
  glow?: number
  style?: CSSProperties
  scale?: number
}) {
  const glow = props.glow ?? 1
  return (
    <div
      style={{
        width: props.width,
        padding: '26px 28px 20px',
        borderRadius: 26,
        background: 'linear-gradient(180deg, #141417 0%, #0f0f12 100%)',
        boxShadow: `0 0 0 1.5px rgba(255,179,26,${0.25 + 0.5 * glow}), 0 0 0 7px rgba(255,179,26,${0.07 * glow}), 0 0 60px rgba(255,164,28,${0.22 * glow}), 0 40px 80px -30px rgba(0,0,0,0.9)`,
        fontFamily: FONT,
        ...props.style,
      }}
    >
      <div style={{ fontSize: 27, minHeight: 38, color: props.text ? C.label : C.label4, letterSpacing: '-0.01em' }}>
        {props.text || props.placeholder || 'Describe what you want done…'}
        {props.caret && (
          <span
            style={{
              display: 'inline-block',
              width: 2.5,
              height: 30,
              marginLeft: 3,
              verticalAlign: '-5px',
              background: C.accent,
            }}
          />
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
        <Icon name="paperclip" size={22} color={C.label3} />
        <Pill size={17} icon="sparkle">Auto model</Pill>
        <Pill size={17} icon="users">Crew</Pill>
        <Pill size={17} icon="folder">acme/site</Pill>
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 14,
            display: 'grid',
            placeItems: 'center',
            background: props.text ? C.accent : C.control,
            color: props.text ? '#1a1204' : C.label3,
          }}
        >
          <Icon name="arrowUp" size={22} stroke={2.2} />
        </div>
      </div>
    </div>
  )
}

/** A small status dot, glowing when live. */
export function Dot(props: { color: string; size?: number; pulse?: number }) {
  const size = props.size ?? 10
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 99,
        background: props.color,
        boxShadow: `0 0 0 ${(props.pulse ?? 0) * size * 0.8}px ${props.color}33, 0 0 ${size}px ${props.color}aa`,
        flexShrink: 0,
      }}
    />
  )
}
