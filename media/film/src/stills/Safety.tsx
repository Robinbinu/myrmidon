import type { ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon.tsx'
import { C, CREW, FONT, MONO } from '../theme.ts'
import { Btn, Headline, Panel, PanelHead, Poster, Segmented } from './kit.tsx'

function Presets() {
  return (
    <Panel style={{ left: 776, top: 70, width: 736, height: 236 }}>
      <PanelHead icon="shield" title="Permissions" right={<span style={{ fontSize: 16, fontWeight: 450, color: C.label4 }}>global</span>} />
      <div style={{ padding: '24px 26px' }}>
        <Segmented options={['Read only', 'Ask', 'Auto', 'Full access']} on={2} size={20} />
        <div style={{ fontSize: 18, color: C.label3, marginTop: 18, lineHeight: 1.4 }}>
          Agents edit and run commands in the sandbox; they ask before anything destructive.
        </div>
      </div>
    </Panel>
  )
}

const TOOLS: [IconName, string, 0 | 1 | 2][] = [
  ['file', 'Read files', 0],
  ['code', 'Edit files', 0],
  ['terminal', 'Run commands', 1],
  ['globe', 'Browse the web', 0],
  ['pointer', 'Use your Mac', 1],
  ['message', 'Send messages', 1],
  ['x', 'Delete outside the project', 2],
]

function Tri(props: { on: 0 | 1 | 2 }) {
  const look = [
    { c: C.ok, bg: C.okSoft },
    { c: C.accent, bg: C.accentSoft },
    { c: C.label2, bg: '#34343b' },
  ] as const
  return (
    <div style={{ display: 'inline-flex', padding: 3, gap: 2, borderRadius: 10, background: C.fillStrong, boxShadow: `inset 0 0 0 1px ${C.separator}` }}>
      {['Allow', 'Ask', 'Off'].map((o, i) => (
        <span
          key={o}
          style={{
            width: 64,
            textAlign: 'center',
            padding: '6px 0',
            borderRadius: 7,
            fontSize: 16,
            fontWeight: i === props.on ? 640 : 480,
            color: i === props.on ? look[i]?.c : C.label4,
            background: i === props.on ? look[i]?.bg : undefined,
            boxShadow: i === props.on ? `inset 0 0 0 1px ${look[i]?.c}55` : undefined,
          }}
        >
          {o}
        </span>
      ))}
    </div>
  )
}

function Tools() {
  return (
    <Panel style={{ left: 88, top: 420, width: 640, height: 430 }}>
      <PanelHead icon="layers" title="Tools" right={<span style={{ fontSize: 16, fontWeight: 450, color: C.label4 }}>per project</span>} />
      <div style={{ padding: '6px 24px' }}>
        {TOOLS.map(([icon, name, on], i) => (
          <div
            key={name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              height: 51,
              borderBottom: i < TOOLS.length - 1 ? `1px solid ${C.separator}` : undefined,
            }}
          >
            <Icon name={icon} size={20} color={C.label3} />
            <span style={{ flex: 1, fontSize: 19, fontWeight: 520 }}>{name}</span>
            <Tri on={on} />
          </div>
        ))}
      </div>
    </Panel>
  )
}

function EnvLine(props: { k: string; kind: string; tag: string }) {
  return (
    <div style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: C.termText }}>{props.k}</span>
      <span style={{ color: C.termMuted }}>=</span>
      <span style={{ color: C.wink, background: 'rgba(255,179,26,0.1)', borderRadius: 5, padding: '1px 5px' }}>
        [[secret:{props.kind}:{props.tag}]]
      </span>
    </div>
  )
}

function Secrets() {
  return (
    <Panel style={{ left: 776, top: 336, width: 736, height: 236 }}>
      <PanelHead icon="lock" title="Secrets" right={<span style={{ fontSize: 16, fontWeight: 450, color: C.label4 }}>what the model sees</span>} />
      <div style={{ padding: '18px 26px', fontFamily: MONO, fontSize: 18, lineHeight: 1.75, background: C.terminal, height: '100%' }}>
        <div style={{ color: C.termMuted }}>
          <span style={{ color: C.termGreen }}>$</span> cat .env
        </div>
        <EnvLine k="STRIPE_KEY" kind="api-key" tag="7KQ2M4ZP9XRA" />
        <EnvLine k="DB_PASSWORD" kind="password" tag="M3QX7B2KTN4D" />
        <div style={{ fontFamily: FONT, fontSize: 17, color: C.label3, marginTop: 10 }}>
          Models get a placeholder, never the key itself.
        </div>
      </div>
    </Panel>
  )
}

const STEPS: [string, ReactNode, string][] = [
  ['09:02', <><b style={{ color: CREW.quill.color }}>quill</b> edits 3 files</>, '#2031'],
  ['09:05', <>tests pass</>, '#2036'],
  ['09:11', <><b style={{ color: CREW.iris.color }}>iris</b> restyles cards</>, '#2042'],
  ['09:14', <>now</>, '#2047'],
]

function Rewind() {
  const x0 = 36
  const step = 192
  return (
    <Panel style={{ left: 776, top: 602, width: 736, height: 248 }}>
      <PanelHead icon="branch" title="Checkpoints" right={<span style={{ fontSize: 16, fontWeight: 450, color: C.label4 }}>every step logged</span>} />
      <div style={{ position: 'relative', height: 184 }}>
        <div style={{ position: 'absolute', left: x0, right: 40, top: 44, height: 2, background: C.separatorStrong }} />
        <div style={{ position: 'absolute', left: x0, width: step, top: 44, height: 2, background: C.accent, boxShadow: `0 0 10px ${C.glow}` }} />
        {STEPS.map(([time, what, ev], i) => {
          const x = x0 + i * step
          const pick = i === 1
          return (
            <div key={time} style={{ position: 'absolute', left: x, top: 0 }}>
              <span
                style={{
                  position: 'absolute',
                  left: pick ? -10 : -7,
                  top: pick ? 35 : 38,
                  width: pick ? 20 : 14,
                  height: pick ? 20 : 14,
                  borderRadius: 99,
                  background: pick ? C.accent : i === 3 ? C.label : C.control,
                  boxShadow: pick ? `0 0 0 5px rgba(255,179,26,0.2), 0 0 16px ${C.glow}` : `inset 0 0 0 2px ${C.label3}`,
                }}
              />
              <div style={{ position: 'absolute', left: -7, top: 70, width: 196 }}>
                <div style={{ fontFamily: MONO, fontSize: 15, color: pick ? C.wink : C.label3 }}>
                  {time} <span style={{ color: C.label4 }}>{ev}</span>
                </div>
                <div style={{ fontSize: 17, color: C.label2, marginTop: 5 }}>{what}</div>
              </div>
            </div>
          )
        })}
        <div style={{ position: 'absolute', left: x0 + step - 7, top: 132 }}>
          <Btn size={16} kind="primary" icon="branch">
            Rewind to here
          </Btn>
        </div>
      </div>
    </Panel>
  )
}

export function FeatureSafety() {
  return (
    <Poster glow={{ x: 400, y: 260, strength: 0.9, size: 1100 }}>
      <Presets />
      <Secrets />
      <Rewind />
      <Tools />
      <Headline
        eyebrow="Safety"
        lead="Sandboxed by default."
        accent="Every step on the record."
        breakAccent
        sub="Pick how much agents may do, tool by tool. Keys stay hidden, and any change can be rewound."
        width={640}
        size={56}
        style={{ left: 88, top: 86 }}
      />
    </Poster>
  )
}
