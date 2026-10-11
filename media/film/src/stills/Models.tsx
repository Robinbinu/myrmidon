import { ModelMark } from '../components/Brand.tsx'
import { Icon } from '../components/Icon.tsx'
import { Crewmate } from '../components/Ui.tsx'
import { C, CREW, type CrewName, FONT, MONO } from '../theme.ts'
import { Headline, Panel, PanelHead, Poster } from './kit.tsx'

const levelColor = (left: number) => (left < 30 ? C.bad : left < 55 ? C.accent : C.ok)

/** The model chip's battery: what is left of the provider's tightest window. */
function Battery(props: { left: number; size?: number }) {
  const w = props.size ?? 30
  const h = w * 0.5
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <span style={{ position: 'relative', width: w, height: h, borderRadius: h * 0.28, boxShadow: `inset 0 0 0 1.5px ${C.label4}` }}>
        <span
          style={{
            position: 'absolute',
            left: 3,
            top: 3,
            bottom: 3,
            width: ((w - 6) * props.left) / 100,
            borderRadius: 2,
            background: levelColor(props.left),
          }}
        />
      </span>
      <span style={{ width: 2.5, height: h * 0.4, borderRadius: 1, background: C.label4 }} />
    </span>
  )
}

const PICK: { provider: string; model: string; how: string; left?: number; on?: boolean }[] = [
  { provider: 'Claude', model: 'Claude Opus', how: 'Max plan', left: 82, on: true },
  { provider: 'ChatGPT', model: 'Codex', how: 'Plus plan', left: 47 },
  { provider: 'Gemini', model: 'Gemini Pro', how: 'Google AI Pro', left: 73 },
  { provider: 'Copilot', model: 'Copilot', how: 'GitHub Copilot', left: 91 },
  { provider: 'Local', model: 'Qwen 3', how: 'on this Mac · free' },
  { provider: 'API key', model: 'Any model', how: 'OpenRouter, Groq, your own…' },
]

function Picker() {
  return (
    <Panel tone="raised" style={{ left: 88, top: 404, width: 660, height: 456 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 62, padding: '0 22px', borderBottom: `1px solid ${C.separator}` }}>
        <Icon name="search" size={20} color={C.label4} />
        <span style={{ fontSize: 19, color: C.label4, flex: 1 }}>Search models</span>
      </div>
      <div style={{ padding: 10 }}>
        {PICK.map((p) => (
          <div
            key={p.provider}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              height: 62,
              padding: '0 14px',
              borderRadius: 12,
              background: p.on ? C.accentSoft : undefined,
              boxShadow: p.on ? 'inset 0 0 0 1px rgba(255,179,26,0.3)' : undefined,
            }}
          >
            <span
              style={{
                width: 150,
                fontFamily: MONO,
                fontSize: 15,
                letterSpacing: '0.04em',
                color: p.on ? C.wink : C.label3,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: C.label }}>
                <ModelMark model={p.provider} size={26} />
                <span style={{ color: p.on ? C.wink : C.label3 }}>{p.provider}</span>
              </span>
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.label }}>{p.model}</div>
              <div style={{ fontSize: 15, color: C.label3, marginTop: 2 }}>{p.how}</div>
            </div>
            {p.left !== undefined ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: MONO, fontSize: 16, color: C.label2 }}>
                {p.left}%
                <Battery left={p.left} />
              </span>
            ) : (
              <Icon name={p.provider === 'Local' ? 'monitor' : 'zap'} size={20} color={C.label3} />
            )}
            <span style={{ width: 22 }}>{p.on && <Icon name="check" size={22} color={C.accent} stroke={2.2} />}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

const WINDOWS: [string, string, number, string][] = [
  ['Claude', '5-hour', 82, 'resets in 3 h'],
  ['Claude', 'weekly', 64, 'resets Mon'],
  ['ChatGPT', '5-hour', 47, 'resets in 52 min'],
  ['Gemini', 'daily', 23, 'resets at 00:00'],
  ['Copilot', 'monthly', 91, 'resets Nov 1'],
]

function Limits() {
  return (
    <Panel style={{ left: 836, top: 70, width: 680, height: 420 }}>
      <PanelHead icon="wallet" title="Plan limits" right={<span style={{ fontSize: 16, fontWeight: 450, color: C.label4 }}>Checked just now</span>} />
      <div style={{ padding: '10px 26px' }}>
        {WINDOWS.map(([who, win, left, reset]) => (
          <div key={who + win} style={{ height: 68, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <ModelMark model={who} size={24} style={{ alignSelf: 'center', color: C.label }} />
              <span style={{ fontSize: 19, fontWeight: 620 }}>{who}</span>
              <span style={{ fontSize: 17, color: C.label3 }}>· {win}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 16, color: levelColor(left), fontWeight: 600 }}>{left}% left</span>
              <span style={{ fontFamily: MONO, fontSize: 14, color: C.label4, width: 150, textAlign: 'right' }}>{reset}</span>
            </div>
            <div style={{ height: 8, borderRadius: 99, background: C.fillStrong, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${left}%`,
                  height: '100%',
                  borderRadius: 99,
                  background: `linear-gradient(90deg, ${levelColor(left)}aa, ${levelColor(left)})`,
                  boxShadow: `0 0 12px ${levelColor(left)}66`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

const ASSIGN: [CrewName, string, string][] = [
  ['nova', 'Claude Opus', 'Claude'],
  ['quill', 'Codex', 'ChatGPT'],
  ['iris', 'Gemini Pro', 'Gemini'],
]

function PerAgent() {
  return (
    <Panel style={{ left: 836, top: 530, width: 680, height: 330 }}>
      <PanelHead icon="users" title="A different model per agent" />
      <div style={{ padding: '8px 26px' }}>
        {ASSIGN.map(([who, model, provider], i) => (
          <div
            key={who}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              height: 84,
              borderBottom: i < ASSIGN.length - 1 ? `1px solid ${C.separator}` : undefined,
            }}
          >
            <Crewmate who={who} size={48} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 21, fontWeight: 640, color: CREW[who].color }}>{who}</div>
              <div style={{ fontSize: 16, color: C.label3, marginTop: 2 }}>{CREW[who].role}</div>
            </div>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                height: 42,
                padding: '0 16px',
                borderRadius: 99,
                fontFamily: FONT,
                fontSize: 18,
                fontWeight: 560,
                color: C.label,
                background: C.fill,
                boxShadow: `inset 0 0 0 1px ${C.separatorStrong}`,
              }}
            >
              <ModelMark model={model} size={24} />
              {model}
              <span style={{ color: C.label4, fontWeight: 450 }}>· {provider}</span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export function FeatureModels() {
  return (
    <Poster glow={{ x: 700, y: 520, strength: 0.9, size: 1500 }}>
      <Limits />
      <PerAgent />
      <Picker />
      <Headline
        eyebrow="Models"
        lead="Use the AI you"
        accent="already pay for."
        breakAccent
        sub="Sign in with Claude, ChatGPT, Gemini or Copilot, run local models, or add any API key. See what is left of each plan."
        width={660}
        size={64}
        style={{ left: 88, top: 78 }}
      />
    </Poster>
  )
}
