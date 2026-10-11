import type { ReactNode } from 'react'
import { Icon } from '../components/Icon.tsx'
import { LogoTile } from '../components/Led.tsx'
import { C, MONO } from '../theme.ts'
import { Btn, Headline, Panel, Poster } from './kit.tsx'

type Line = { from: 'robin' | 'bot'; text: ReactNode }

/** One app's view of the same conversation, labelled by name only (no marks): when, and two lines of it. */
const SURFACES: { app: string; color: string; where: string; time: string; lines: Line[]; x: number; y: number; rot: number }[] = [
  {
    app: 'Telegram',
    color: '#26A5E4',
    where: 'on the train',
    time: '08:02',
    lines: [
      { from: 'robin', text: 'Can the crew draft the Q3 investor update?' },
      { from: 'bot', text: 'On it. nova is pulling the numbers.' },
    ],
    x: 70,
    y: 372,
    rot: -2.5,
  },
  {
    app: 'Slack',
    color: '#E01E5A',
    where: '#launch',
    time: '10:15',
    lines: [
      { from: 'bot', text: 'Draft is ready: 4 pages.' },
      { from: 'robin', text: 'Add churn by plan, please.' },
    ],
    x: 365,
    y: 338,
    rot: 1.2,
  },
  {
    app: 'WhatsApp',
    color: '#25D366',
    where: 'at lunch',
    time: '12:40',
    lines: [
      { from: 'robin', text: 'How is it going?' },
      { from: 'bot', text: 'Churn chart in. quill fixed two totals.' },
    ],
    x: 660,
    y: 380,
    rot: -1,
  },
  {
    app: 'iMessage',
    color: '#34DA50',
    where: 'on the bus',
    time: '17:05',
    lines: [
      { from: 'robin', text: 'Send me the PDF?' },
      { from: 'bot', text: <span style={{ fontFamily: MONO, fontSize: 16 }}>Q3-update.pdf</span> },
    ],
    x: 955,
    y: 340,
    rot: 2,
  },
  {
    app: 'Email',
    color: '#c8c8d0',
    where: 'robin@acme.dev',
    time: '17:06',
    lines: [
      { from: 'bot', text: 'Re: Q3 update, final' },
      { from: 'bot', text: 'Attached, with the sources nova used.' },
    ],
    x: 1250,
    y: 376,
    rot: -1.6,
  },
]

function Bubble(props: Line) {
  const me = props.from === 'robin'
  return (
    <div style={{ display: 'flex', justifyContent: me ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: 236,
          padding: '9px 13px',
          borderRadius: 16,
          borderBottomRightRadius: me ? 5 : 16,
          borderBottomLeftRadius: me ? 16 : 5,
          fontSize: 17,
          lineHeight: 1.3,
          color: me ? '#141416' : C.label,
          background: me ? C.user : C.fillStrong,
          boxShadow: me ? undefined : `inset 0 0 0 1px ${C.separator}`,
        }}
      >
        {props.text}
      </div>
    </div>
  )
}

function Surface(props: (typeof SURFACES)[number]) {
  return (
    <Panel
      tone="raised"
      radius={20}
      style={{ left: props.x, top: props.y, width: 280, transform: `rotate(${props.rot}deg)` }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 52,
          padding: '0 16px',
          borderBottom: `1px solid ${C.separator}`,
          background: '#141418',
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 99, background: props.color, boxShadow: `0 0 10px ${props.color}88` }} />
        <span style={{ fontSize: 18, fontWeight: 650 }}>{props.app}</span>
        <span style={{ fontSize: 15, color: C.label4, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap' }}>{props.where}</span>
        <span style={{ fontFamily: MONO, fontSize: 14, color: C.label3 }}>{props.time}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 14, minHeight: 150 }}>
        {props.lines.map((l, i) => (
          <Bubble key={i} {...l} />
        ))}
      </div>
    </Panel>
  )
}

/** The pairing request a stranger's first message raises: nothing reaches the crew until Robin approves the code. */
function Pairing() {
  return (
    <Panel
      tone="raised"
      style={{
        left: 800 - 390,
        top: 640,
        width: 780,
        boxShadow:
          '0 0 0 1px rgba(255,179,26,0.45), 0 0 0 8px rgba(255,179,26,0.06), 0 0 80px -10px rgba(255,164,28,0.35), 0 60px 120px -20px rgba(0,0,0,1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '24px 28px' }}>
        <LogoTile size={64} glow={0.6} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 26, fontWeight: 650, letterSpacing: '-0.015em' }}>New sender · approve 4F7K?</div>
          <div style={{ fontSize: 17, color: C.label3, marginTop: 6 }}>
            <span style={{ fontFamily: MONO, color: C.label2 }}>+44 7700 900418</span> on WhatsApp got this code
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['4', 'F', '7', 'K'].map((ch) => (
            <span
              key={ch}
              style={{
                width: 46,
                height: 58,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 10,
                fontFamily: MONO,
                fontSize: 32,
                fontWeight: 600,
                color: C.wink,
                background: '#0b0b0d',
                boxShadow: 'inset 0 0 0 1px rgba(255,179,26,0.3)',
                textShadow: `0 0 14px ${C.glow}`,
              }}
            >
              {ch}
            </span>
          ))}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '16px 28px',
          borderTop: `1px solid ${C.separator}`,
          background: '#141418',
        }}
      >
        <Icon name="lock" size={19} color={C.label3} />
        <span style={{ fontSize: 17, color: C.label3, flex: 1 }}>Everyone else is turned away.</span>
        <Btn size={17}>Block</Btn>
        <Btn size={17} kind="primary" icon="check">
          Approve 4F7K
        </Btn>
      </div>
    </Panel>
  )
}

export function FeatureChannels() {
  return (
    <Poster glow={{ x: 800, y: 560, strength: 1, size: 1500 }}>
      {/* The one thread running through every app. */}
      <svg width={1600} height={900} style={{ position: 'absolute', inset: 0 }}>
        <path
          d="M 120 470 C 330 420, 420 420, 505 440 S 760 500, 800 480 S 1000 420, 1100 440 S 1330 490, 1500 470"
          fill="none"
          stroke={C.accent}
          strokeOpacity={0.5}
          strokeWidth={2}
          strokeDasharray="2 10"
          strokeLinecap="round"
        />
      </svg>
      {SURFACES.map((s) => (
        <Surface key={s.app} {...s} />
      ))}
      <Pairing />
      <Headline
        eyebrow="Channels"
        lead="Talk to it from"
        accent="30 apps."
        sub="Telegram, WhatsApp, Slack, iMessage, Discord, email and more: one conversation that follows you around. Approved people only."
        align="center"
        width={1100}
        size={68}
        style={{ left: 250, top: 64 }}
      />
    </Poster>
  )
}

