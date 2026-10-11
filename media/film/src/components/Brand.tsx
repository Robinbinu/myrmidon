import claude from '@lobehub/icons-static-svg/icons/claude-color.svg'
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg'
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg'
import grok from '@lobehub/icons-static-svg/icons/grok.svg'
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg'
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg'
import openai from '@lobehub/icons-static-svg/icons/openai.svg'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import zai from '@lobehub/icons-static-svg/icons/zai.svg'
import { AtSign, MessageCircle, Smartphone } from 'lucide-react'
import type { CSSProperties } from 'react'
import { CHANNEL_LOGOS, FALLBACK_LOGO } from '../../../../apps/web/src/client/channel-logos.ts'
import { RADIUS } from '../design.ts'

/** A logo file; `mono` logos are one-colour shapes drawn in the text colour, as the app draws them. */
interface Logo {
  readonly src: string
  readonly mono?: boolean
}

/**
 * Model makers, matched on the names their models go by: the same files and rules as the app's ProviderGlyph
 * (apps/web/src/client/ui/ProviderGlyph.tsx), for the makers the film shows.
 */
const MAKERS: [RegExp, Logo][] = [
  [/claude/i, { src: claude }],
  [/gemini|gemma/i, { src: gemini }],
  [/deepseek/i, { src: deepseek }],
  [/grok/i, { src: grok, mono: true }],
  [/qwen/i, { src: qwen }],
  [/mistral/i, { src: mistral }],
  [/kimi|moonshot/i, { src: kimi }],
  [/glm|zhipu|\bzai\b/i, { src: zai, mono: true }],
  // Before Llama, which "ollama" also spells.
  [/ollama|local/i, { src: ollama, mono: true }],
  [/llama|\bmeta\b/i, { src: meta }],
  [/codex/i, { src: codex }],
  [/gpt|openai|chatgpt/i, { src: openai, mono: true }],
  [/copilot/i, { src: githubcopilot, mono: true }],
  [/openrouter|api key/i, { src: openrouter, mono: true }],
]

/** The logo of a model's maker (Claude, OpenAI, Gemini…), or nothing for a name no maker claims. */
export function ModelMark(props: { model: string; size: number; style?: CSSProperties }) {
  const logo = MAKERS.find(([re]) => re.test(props.model))?.[1]
  if (!logo) return null
  const size = props.size
  if (logo.mono)
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          flexShrink: 0,
          width: size,
          height: size,
          background: 'currentColor',
          mask: `url("${logo.src}") center / contain no-repeat`,
          WebkitMask: `url("${logo.src}") center / contain no-repeat`,
          ...props.style,
        }}
      />
    )
  return <img src={logo.src} alt="" aria-hidden width={size} height={size} style={{ flexShrink: 0, ...props.style }} />
}


const ICONS = { mail: AtSign, sms: Smartphone, chat: MessageCircle, hash: MessageCircle, webhook: MessageCircle }

/** A messaging app's mark on its brand colour, as a rounded tile: the app's ChannelLogo, from its own logo table. */
export function ChannelMark(props: { id: string; size: number; style?: CSSProperties }) {
  const logo = CHANNEL_LOGOS[props.id] ?? FALLBACK_LOGO
  const size = props.size
  const inner = Math.round(size * 0.58)
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: Math.min(RADIUS.lg, Math.round(size * 0.26)),
        background: logo.color,
        color: '#ffffff',
        ...props.style,
      }}
    >
      {'path' in logo ? (
        <svg viewBox="0 0 24 24" width={inner} height={inner} fill="currentColor" aria-hidden>
          <path d={logo.path} />
        </svg>
      ) : 'letters' in logo ? (
        <span style={{ fontWeight: 700, lineHeight: 1, fontSize: Math.round(size * 0.52), letterSpacing: '-0.02em' }}>
          {logo.letters}
        </span>
      ) : (
        (() => {
          const Icon = ICONS[logo.icon]
          return <Icon size={inner} strokeWidth={2.2} />
        })()
      )}
    </span>
  )
}
