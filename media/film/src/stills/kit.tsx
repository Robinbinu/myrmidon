import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill } from 'remotion'
import { Icon, type IconName } from '../components/Icon.tsx'
import { LogoTile } from '../components/Led.tsx'
import { Stage } from '../components/Stage.tsx'
import { C, FONT, MONO } from '../theme.ts'

/** The README posters' size: 16:9, drawn at 1600 px so their type still reads when GitHub shows them ~900 px wide. */
export const PW = 1600
export const PH = 900

/**
 * A faint film grain over the whole still. The posters are mostly near-black gradients, which band once encoded as
 * WebP; a little noise dithers the steps away.
 */
export function Grain(props: { opacity?: number }) {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity: props.opacity ?? 0.05, mixBlendMode: 'overlay' }}>
      <svg width="100%" height="100%" aria-hidden>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  )
}

/** A poster's stage: the film's dot-grid black with its amber pool of light, and the grain on top. */
export function Poster(props: { children: ReactNode; glow?: { x: number; y: number; strength?: number; size?: number } }) {
  return (
    <Stage glow={props.glow} drift={0}>
      {props.children}
      <Grain />
    </Stage>
  )
}

/**
 * The small brand line over each headline: the mark, then the feature's name in amber mono. The name itself only
 * appears as a title in its dot-matrix form (DotWord), which would not read this small, so the mark stands for it.
 */
export function Eyebrow(props: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        fontFamily: MONO,
        fontSize: 20,
        fontWeight: 500,
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        color: C.wink,
        ...props.style,
      }}
    >
      <LogoTile size={40} glow={0.7} />
      <span>{props.children}</span>
    </div>
  )
}

/** Headline and its one-line sub, the type every poster leads with. `lead` is white, `accent` amber. */
export function Headline(props: {
  eyebrow: string
  lead: ReactNode
  accent?: ReactNode
  sub: ReactNode
  size?: number
  align?: 'left' | 'center'
  width?: number
  style?: CSSProperties
  /** Break before the amber half. */
  breakAccent?: boolean
}) {
  const size = props.size ?? 68
  const center = props.align === 'center'
  return (
    <div
      style={{
        position: 'absolute',
        fontFamily: FONT,
        color: C.label,
        width: props.width,
        display: 'flex',
        flexDirection: 'column',
        alignItems: center ? 'center' : 'flex-start',
        textAlign: center ? 'center' : 'left',
        ...props.style,
      }}
    >
      <Eyebrow>{props.eyebrow}</Eyebrow>
      <div
        style={{
          marginTop: 30,
          fontSize: size,
          fontWeight: 680,
          letterSpacing: '-0.045em',
          lineHeight: 1.02,
          textWrap: 'balance',
        }}
      >
        {props.lead}
        {props.accent && (
          <>
            {props.breakAccent ? <br /> : ' '}
            <span style={{ color: C.wink }}>{props.accent}</span>
          </>
        )}
      </div>
      <div
        style={{
          marginTop: 22,
          fontSize: Math.round(size * 0.38),
          fontWeight: 430,
          letterSpacing: '-0.012em',
          lineHeight: 1.35,
          color: C.label3,
          maxWidth: props.width ? props.width - 20 : 760,
          textWrap: 'pretty',
        }}
      >
        {props.sub}
      </div>
    </div>
  )
}

/** A raised panel in the app's dark material: content fill, a hairline, a top highlight and a long soft shadow. */
export function Panel(props: { children?: ReactNode; style?: CSSProperties; radius?: number; tone?: 'content' | 'raised' | 'window' }) {
  const bg = props.tone === 'raised' ? C.raised : props.tone === 'window' ? C.window : C.content
  return (
    <div
      style={{
        position: 'absolute',
        borderRadius: props.radius ?? 22,
        background: bg,
        boxShadow:
          '0 0 0 1px rgba(255,255,255,0.09), inset 0 1px 0 rgba(255,255,255,0.05), 0 50px 110px -30px rgba(0,0,0,0.95), 0 18px 36px -18px rgba(0,0,0,0.8)',
        fontFamily: FONT,
        color: C.label,
        overflow: 'hidden',
        ...props.style,
      }}
    >
      {props.children}
    </div>
  )
}

/** A panel's title bar: an icon, a title, and whatever sits on the right. */
export function PanelHead(props: { icon?: IconName; title: ReactNode; right?: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        height: 64,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 24px',
        borderBottom: `1px solid ${C.separator}`,
        background: '#0e0e11',
        fontSize: 21,
        fontWeight: 600,
        color: C.label,
        ...props.style,
      }}
    >
      {props.icon && <Icon name={props.icon} size={22} color={C.label3} />}
      <span style={{ flex: 1 }}>{props.title}</span>
      {props.right}
    </div>
  )
}

/** A button in the app's three weights: amber primary, quiet secondary, and the destructive one. */
export function Btn(props: { children: ReactNode; kind?: 'primary' | 'secondary' | 'danger' | 'ok'; size?: number; icon?: IconName; style?: CSSProperties }) {
  const size = props.size ?? 19
  const kind = props.kind ?? 'secondary'
  const look = {
    primary: { background: C.accent, color: '#1a1204', boxShadow: '0 8px 24px -10px rgba(255,179,26,0.7)' },
    secondary: { background: C.control, color: C.label, boxShadow: `inset 0 0 0 1px ${C.separatorStrong}` },
    danger: { background: 'rgba(255,99,105,0.12)', color: C.bad, boxShadow: 'inset 0 0 0 1px rgba(255,99,105,0.35)' },
    ok: { background: C.okSoft, color: C.ok, boxShadow: 'inset 0 0 0 1px rgba(61,220,132,0.35)' },
  }[kind]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: size * 0.45,
        height: size * 2.1,
        padding: `0 ${size * 0.95}px`,
        borderRadius: size * 0.55,
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...look,
        ...props.style,
      }}
    >
      {props.icon && <Icon name={props.icon} size={size * 1.05} stroke={2} />}
      {props.children}
    </span>
  )
}

/** The app's segmented control: a track with the chosen option raised off it. */
export function Segmented(props: { options: string[]; on: number; size?: number; style?: CSSProperties }) {
  const size = props.size ?? 19
  return (
    <div
      style={{
        display: 'inline-flex',
        padding: 4,
        gap: 2,
        borderRadius: size * 0.7,
        background: C.fillStrong,
        boxShadow: `inset 0 0 0 1px ${C.separator}`,
        fontFamily: FONT,
        ...props.style,
      }}
    >
      {props.options.map((o, i) => (
        <span
          key={o}
          style={{
            padding: `${size * 0.42}px ${size * 0.85}px`,
            borderRadius: size * 0.5,
            fontSize: size,
            fontWeight: i === props.on ? 620 : 500,
            color: i === props.on ? C.label : C.label3,
            background: i === props.on ? '#34343b' : 'transparent',
            boxShadow: i === props.on ? '0 1px 0 rgba(255,255,255,0.08) inset, 0 4px 10px -4px rgba(0,0,0,0.8)' : undefined,
            whiteSpace: 'nowrap',
          }}
        >
          {o}
        </span>
      ))}
    </div>
  )
}

/** A switch, on in amber. */
export function Toggle(props: { on: boolean; size?: number }) {
  const h = props.size ?? 26
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: h * 1.7,
        height: h,
        borderRadius: 99,
        background: props.on ? C.accent : C.control,
        boxShadow: props.on ? undefined : `inset 0 0 0 1px ${C.separatorStrong}`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: props.on ? h * 1.7 - h + 3 : 3,
          width: h - 6,
          height: h - 6,
          borderRadius: 99,
          background: props.on ? '#1a1204' : C.label3,
        }}
      />
    </span>
  )
}

/** A monospace inline chip, for paths, commands and keys. */
export function Code(props: { children: ReactNode; size?: number; color?: string; bg?: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: props.size ?? 18,
        padding: '3px 9px',
        borderRadius: 7,
        color: props.color ?? C.label2,
        background: props.bg ?? C.fillStrong,
        boxShadow: `inset 0 0 0 1px ${C.separator}`,
        whiteSpace: 'nowrap',
        ...props.style,
      }}
    >
      {props.children}
    </span>
  )
}
