import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { SPRING, clamp, lerp, sp, tween } from '../anim.ts'
import { Caption } from '../components/Caption.tsx'
import { Icon } from '../components/Icon.tsx'
import { LedScreen } from '../components/Led.tsx'
import { Shot, Stage } from '../components/Stage.tsx'
import { C, FONT, MONO } from '../theme.ts'

const CHANNELS = ['Telegram', 'WhatsApp', 'Slack', 'Discord', 'iMessage', 'Signal', 'Teams', 'Email', 'SMS', 'Matrix', 'Voice calls', '+20 more']
const MODELS = ['Claude', 'GPT', 'Gemini', 'Llama', 'Qwen', 'DeepSeek', 'Mistral', 'Grok', 'Kimi', 'GLM', 'Local models', 'Any API key']
const DOTS = ['#ffb31a', '#7fdcff', '#5ee6a8', '#ff8fc0', '#b69cff', '#ff8a4c', '#dcdce4', '#4d7cff', '#f25c8a', '#2ed3a0', '#ffcf5c', '#9a9aa5']

const SWAP = 172
const CENTER = { x: 960, y: 600 }
const R = { x: 780, y: 260 }

function Chip(props: { label: string; model: boolean; color: string; more: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 72,
        padding: '0 28px 0 22px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        background: props.more ? C.accent : 'linear-gradient(180deg, #1c1c21 0%, #141418 100%)',
        boxShadow: props.more ? '0 10px 30px -8px rgba(255,179,26,0.5)' : '0 0 0 1px rgba(255,255,255,0.12), 0 20px 40px -16px rgba(0,0,0,0.9)',
        fontFamily: props.model ? MONO : FONT,
        fontSize: props.model ? 28 : 30,
        fontWeight: props.more ? 700 : 600,
        letterSpacing: props.model ? 0 : '-0.02em',
        color: props.more ? '#1a1204' : C.label,
      }}
    >
      {!props.more &&
        (props.model ? (
          <span style={{ width: 14, height: 14, borderRadius: 4, background: props.color, boxShadow: `0 0 12px ${props.color}88` }} />
        ) : (
          <Icon name="message" size={26} color={props.color} stroke={2} />
        ))}
      {props.label}
    </div>
  )
}

export function Reach(props: { dur: number }) {
  const frame = useCurrentFrame()
  const appear = sp(frame, 0, SPRING.smooth)
  const spin = frame * 0.0065
  return (
    <Shot dur={props.dur}>
      <Stage glow={{ x: CENTER.x, y: CENTER.y, strength: 1.1, size: 1100 }}>
        {CHANNELS.map((ch, i) => {
          const a = (i / CHANNELS.length) * Math.PI * 2 + spin + (1 - appear) * -1.2
          const depth = Math.sin(a)
          const r = lerp(0.3, 1, sp(frame, i * 2, SPRING.smooth))
          const x = CENTER.x + Math.cos(a) * R.x * r
          const y = CENTER.y + depth * R.y * r
          const near = (depth + 1) / 2
          const flipAt = SWAP + i * 2
          const flip = tween(frame, flipAt, flipAt + 16)
          const model = flip >= 0.5
          const flipScale = Math.abs(Math.cos(flip * Math.PI))
          const label = model ? (MODELS[i] ?? '') : ch
          return (
            <div
              key={ch}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                zIndex: depth > 0 ? 3 : 1,
                transform: `translate(-50%, -50%) scale(${lerp(0.62, 1.08, near) * r}) scaleY(${flipScale})`,
                opacity: lerp(0.32, 1, near) * clamp(r * 1.5 - 0.3, 0, 1),
                filter: near < 0.35 ? `blur(${(0.35 - near) * 8}px)` : undefined,
              }}
            >
              <Chip label={label} model={model} color={DOTS[i] ?? C.accent} more={i === CHANNELS.length - 1 && !model} />
            </div>
          )
        })}
        <div
          style={{
            position: 'absolute',
            left: CENTER.x - 290,
            top: CENTER.y - 170,
            width: 580,
            zIndex: 2,
            transform: `scale(${lerp(0.8, 1, appear)})`,
          }}
        >
          <LedScreen
            cell={26}
            eyes={{ mood: frame > SWAP - 10 && frame < SWAP + 40 ? 'wide' : 'happy' }}
            status="ONLINE"
            statusColor={C.ok}
            readout={frame < SWAP ? 'ANY CHANNEL' : 'ANY MODEL'}
          />
        </div>
        <AbsoluteFill style={{ top: 76, height: 'auto', alignItems: 'center', zIndex: 4 }}>
          <Caption text="Reach it from *anywhere.*" start={14} end={SWAP - 12} size={80} />
        </AbsoluteFill>
        <AbsoluteFill style={{ top: 76, height: 'auto', alignItems: 'center', zIndex: 4 }}>
          <Caption text="Use the subscriptions *you already pay for.*" start={SWAP + 10} end={props.dur + 20} size={76} stagger={3} />
        </AbsoluteFill>
      </Stage>
    </Shot>
  )
}
