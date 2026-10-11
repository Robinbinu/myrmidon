import type { ReactNode } from 'react'
import { noise } from '../anim.ts'
import { Icon, type IconName } from '../components/Icon.tsx'
import { LedScreen } from '../components/Led.tsx'
import { C, CREW, FONT, MONO } from '../theme.ts'
import { Headline, Panel, Poster } from './kit.tsx'

/** The live waveform: Alex speaking, loudest in the middle of the phrase. */
function Wave(props: { width: number; height: number }) {
  const n = 64
  const bw = props.width / n
  return (
    <svg width={props.width} height={props.height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="wave" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={C.eyeLight} />
          <stop offset="0.5" stopColor={C.eyeTop} />
          <stop offset="1" stopColor={C.eyeBottom} />
        </linearGradient>
      </defs>
      {Array.from({ length: n }, (_, i) => {
        const env = Math.sin((i / (n - 1)) * Math.PI) ** 1.4
        const amp = 0.12 + 0.88 * env * (0.55 + 0.45 * Math.abs(noise(i * 0.55, 3)))
        const h = Math.max(6, amp * props.height)
        return (
          <rect
            key={i}
            x={i * bw + bw * 0.22}
            y={(props.height - h) / 2}
            width={bw * 0.56}
            height={h}
            rx={bw * 0.28}
            fill="url(#wave)"
            opacity={0.35 + 0.65 * env}
          />
        )
      })}
    </svg>
  )
}

function Caption(props: { who: string; color: string; children: ReactNode; live?: boolean; dim?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 16, opacity: props.dim ? 0.5 : 1 }}>
      <span style={{ width: 96, flexShrink: 0, fontSize: 17, fontWeight: 650, color: props.color, paddingTop: 3 }}>{props.who}</span>
      <span style={{ fontSize: 22, lineHeight: 1.4, color: C.label, letterSpacing: '-0.005em' }}>
        {props.children}
        {props.live && <span style={{ display: 'inline-block', width: 2.5, height: 24, marginLeft: 4, verticalAlign: -4, background: C.accent }} />}
      </span>
    </div>
  )
}

function Round(props: { icon: IconName; bg: string; color?: string }) {
  return (
    <span style={{ width: 62, height: 62, borderRadius: 99, display: 'grid', placeItems: 'center', background: props.bg, boxShadow: `inset 0 0 0 1px ${C.separator}` }}>
      <Icon name={props.icon} size={26} color={props.color ?? C.label} />
    </span>
  )
}

function CallWindow() {
  return (
    <Panel style={{ left: 88, top: 64, width: 800, height: 772 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 62,
          padding: '0 24px',
          borderBottom: `1px solid ${C.separator}`,
          background: '#0e0e11',
          fontSize: 19,
          fontWeight: 600,
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 99, background: C.ok, boxShadow: `0 0 10px ${C.ok}` }} />
        On a call with Myrmidon
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 500, color: C.ok }}>04:12</span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 392,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 26,
          background: 'radial-gradient(500px 260px at 50% 45%, rgba(255,164,28,0.12) 0%, transparent 70%)',
        }}
      >
        <LedScreen cell={17} eyes={{ look: [0, -1] }} status="LISTENING" statusColor={C.ok} readout="VOICE · LOCAL" />
        <Wave width={560} height={64} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 36px 0', borderTop: `1px solid ${C.separator}`, height: 210, paddingTop: 20 }}>
        <Caption who="Alex" color={C.label2} dim>
          Did the staging deploy go through?
        </Caption>
        <Caption who="Myrmidon" color={C.wink}>
          Yes. <span style={{ color: CREW.quill.color, fontWeight: 600 }}>quill</span> ran the tests and all 64 pass. Promote it?
        </Caption>
        <Caption who="Alex" color={C.label2} live>
          Go ahead, and text me the link
        </Caption>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 22, paddingTop: 2 }}>
        <Round icon="mic" bg={C.control} />
        <Round icon="monitor" bg={C.control} />
        <Round icon="phone" bg="#e5484d" color="#fff" />
      </div>
    </Panel>
  )
}

function SideCard(props: { top: number; icon: IconName; title: ReactNode; children: ReactNode }) {
  return (
    <Panel tone="raised" style={{ left: 960, top: props.top, width: 556 }}>
      <div style={{ display: 'flex', gap: 18, padding: '22px 24px' }}>
        <div style={{ width: 48, height: 48, borderRadius: 13, display: 'grid', placeItems: 'center', background: C.accentSoft, flexShrink: 0 }}>
          <Icon name={props.icon} size={25} color={C.accent} />
        </div>
        <div style={{ flex: 1, fontFamily: FONT }}>
          <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: '-0.01em', lineHeight: 1.25 }}>{props.title}</div>
          <div style={{ marginTop: 12 }}>{props.children}</div>
        </div>
      </div>
    </Panel>
  )
}

const chip = {
  fontFamily: MONO,
  fontSize: 15,
  padding: '6px 11px',
  borderRadius: 8,
  color: C.label2,
  background: C.fillStrong,
  boxShadow: `inset 0 0 0 1px ${C.separator}`,
  whiteSpace: 'nowrap',
} as const

export function FeatureVoice() {
  return (
    <Poster glow={{ x: 490, y: 330, strength: 1.1, size: 1100 }}>
      <CallWindow />
      <Headline
        eyebrow="Voice"
        lead="Call your"
        accent="crew."
        sub="Talk it through hands-free, with live captions. Interrupt whenever you like."
        width={556}
        size={72}
        style={{ left: 960, top: 202 }}
      />
      <SideCard top={508} icon="phone" title="Or ring your Twilio number from any phone">
        <span style={{ fontFamily: MONO, fontSize: 20, color: C.wink, letterSpacing: '0.02em' }}>+1 (555) 010-4477</span>
        <span style={{ fontSize: 16, color: C.label3, marginLeft: 12 }}>approved callers only</span>
      </SideCard>
      <SideCard top={644} icon="mic" title="Local speech, or 12 cloud speech services">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ ...chip, color: C.wink, boxShadow: 'inset 0 0 0 1px rgba(255,179,26,0.35)' }}>on this Mac · free</span>
          <span style={chip}>ElevenLabs</span>
          <span style={chip}>Deepgram</span>
          <span style={chip}>OpenAI</span>
          <span style={chip}>+9 more</span>
        </div>
      </SideCard>
    </Poster>
  )
}
