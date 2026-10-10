import alibaba from '@lobehub/icons-static-svg/icons/alibaba-color.svg'
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg'
import antigravity from '@lobehub/icons-static-svg/icons/antigravity-color.svg'
import apple from '@lobehub/icons-static-svg/icons/apple.svg'
import assemblyai from '@lobehub/icons-static-svg/icons/assemblyai-color.svg'
import aws from '@lobehub/icons-static-svg/icons/aws-color.svg'
import azure from '@lobehub/icons-static-svg/icons/azure-color.svg'
import baseten from '@lobehub/icons-static-svg/icons/baseten.svg'
import bedrock from '@lobehub/icons-static-svg/icons/bedrock-color.svg'
import cerebras from '@lobehub/icons-static-svg/icons/cerebras-color.svg'
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg'
import cline from '@lobehub/icons-static-svg/icons/cline.svg'
import cloudflare from '@lobehub/icons-static-svg/icons/cloudflare-color.svg'
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg'
import cohere from '@lobehub/icons-static-svg/icons/cohere-color.svg'
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg'
import deepinfra from '@lobehub/icons-static-svg/icons/deepinfra-color.svg'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg'
import devin from '@lobehub/icons-static-svg/icons/devin-color.svg'
import doubao from '@lobehub/icons-static-svg/icons/doubao-color.svg'
import elevenlabs from '@lobehub/icons-static-svg/icons/elevenlabs.svg'
import fireworks from '@lobehub/icons-static-svg/icons/fireworks-color.svg'
import fishaudio from '@lobehub/icons-static-svg/icons/fishaudio.svg'
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg'
import google from '@lobehub/icons-static-svg/icons/google-color.svg'
import googlecloud from '@lobehub/icons-static-svg/icons/googlecloud-color.svg'
import grok from '@lobehub/icons-static-svg/icons/grok.svg'
import groq from '@lobehub/icons-static-svg/icons/groq.svg'
import huggingface from '@lobehub/icons-static-svg/icons/huggingface-color.svg'
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg'
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg'
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg'
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg'
import novita from '@lobehub/icons-static-svg/icons/novita-color.svg'
import nvidia from '@lobehub/icons-static-svg/icons/nvidia-color.svg'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg'
import openai from '@lobehub/icons-static-svg/icons/openai.svg'
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import sakana from '@lobehub/icons-static-svg/icons/sakana-color.svg'
import stepfun from '@lobehub/icons-static-svg/icons/stepfun-color.svg'
import together from '@lobehub/icons-static-svg/icons/together-color.svg'
import venice from '@lobehub/icons-static-svg/icons/venice-color.svg'
import vercel from '@lobehub/icons-static-svg/icons/vercel.svg'
import vertexai from '@lobehub/icons-static-svg/icons/vertexai-color.svg'
import volcengine from '@lobehub/icons-static-svg/icons/volcengine-color.svg'
import wafer from '@lobehub/icons-static-svg/icons/wafer.svg'
import wenxin from '@lobehub/icons-static-svg/icons/wenxin-color.svg'
import xai from '@lobehub/icons-static-svg/icons/xai.svg'
import xiaomimimo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg'
import zai from '@lobehub/icons-static-svg/icons/zai.svg'
import zenmux from '@lobehub/icons-static-svg/icons/zenmux.svg'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg'
import { cn } from './primitives.tsx'

/** A logo file; `mono` logos are one-colour shapes drawn in the text colour, so they read in both themes. */
interface Logo {
  readonly src: string
  readonly mono?: boolean
}

/** Model makers, matched on the names their models go by, so a model hosted elsewhere still shows its maker. */
const MAKERS: [RegExp, Logo][] = [
  [/claude/i, { src: claude }],
  [/anthropic/i, { src: anthropic, mono: true }],
  [/gemini|gemma/i, { src: gemini }],
  [/deepseek/i, { src: deepseek }],
  [/grok/i, { src: grok, mono: true }],
  [/\bxai\b|x-ai/i, { src: xai, mono: true }],
  [/qwen/i, { src: qwen }],
  [/mistral|codestral|magistral|devstral/i, { src: mistral }],
  [/kimi|moonshot/i, { src: kimi }],
  [/glm|zhipu|\bzai\b|z-ai/i, { src: zai, mono: true }],
  [/doubao|seed-/i, { src: doubao }],
  [/llama|\bmeta\b/i, { src: meta }],
  [/minimax/i, { src: minimax }],
  [/nemotron|nvidia/i, { src: nvidia }],
  [/cohere|command-r/i, { src: cohere }],
  [/ernie|wenxin/i, { src: wenxin }],
  [/codex/i, { src: codex }],
  [/gpt|openai|\bo[134]\b/i, { src: openai, mono: true }],
  [/apple/i, { src: apple, mono: true }],
  [/nova|amazon/i, { src: aws }],
  [/google/i, { src: google }],
]

/** Where models are served from, by provider id. */
const PROVIDERS: Record<string, Logo> = {
  anthropic: { src: claude },
  openai: { src: openai, mono: true },
  'openai-codex': { src: codex },
  google: { src: google },
  'google-antigravity': { src: antigravity },
  gemini: { src: gemini },
  'amazon-bedrock': { src: bedrock },
  'bedrock-mantle': { src: bedrock },
  ark: { src: volcengine },
  'baidu-ernie': { src: wenxin },
  deepseek: { src: deepseek },
  xai: { src: xai, mono: true },
  mistral: { src: mistral },
  moonshot: { src: kimi },
  openrouter: { src: openrouter, mono: true },
  ollama: { src: ollama, mono: true },
  apple: { src: apple, mono: true },
  qwen: { src: qwen },
  'qwen-vl': { src: qwen },
  'alibaba-coding-plan': { src: alibaba },
  'alibaba-token-plan': { src: alibaba },
  azure: { src: azure },
  baseten: { src: baseten, mono: true },
  cerebras: { src: cerebras },
  'cloudflare-ai-gateway': { src: cloudflare },
  'cline-pass': { src: cline, mono: true },
  cursor: { src: cursor, mono: true },
  deepinfra: { src: deepinfra },
  fireworks: { src: fireworks },
  'github-copilot': { src: githubcopilot, mono: true },
  'google-gemini-cli': { src: gemini },
  'google-vertex': { src: vertexai },
  groq: { src: groq, mono: true },
  huggingface: { src: huggingface },
  'kimi-code': { src: kimi },
  'lm-studio': { src: lmstudio, mono: true },
  meta: { src: meta },
  minimax: { src: minimax },
  'minimax-cn': { src: minimax },
  'minimax-code': { src: minimax },
  'minimax-code-cn': { src: minimax },
  novita: { src: novita },
  nvidia: { src: nvidia },
  'ollama-cloud': { src: ollama, mono: true },
  'opencode-go': { src: opencode, mono: true },
  'opencode-zen': { src: opencode, mono: true },
  qianfan: { src: wenxin },
  'qwen-portal': { src: qwen },
  sakana: { src: sakana },
  stepfun: { src: stepfun },
  together: { src: together },
  venice: { src: venice },
  'vercel-ai-gateway': { src: vercel, mono: true },
  'xai-oauth': { src: xai, mono: true },
  xiaomi: { src: xiaomimimo, mono: true },
  'xiaomi-token-plan-ams': { src: xiaomimimo, mono: true },
  'xiaomi-token-plan-cn': { src: xiaomimimo, mono: true },
  'xiaomi-token-plan-sgp': { src: xiaomimimo, mono: true },
  zai: { src: zai, mono: true },
  'zhipu-coding-plan': { src: zhipu },
  devin: { src: devin },
  zenmux: { src: zenmux, mono: true },
  'wafer-serverless': { src: wafer, mono: true },
  elevenlabs: { src: elevenlabs, mono: true },
  assemblyai: { src: assemblyai },
  'google-cloud': { src: googlecloud },
  aws: { src: aws },
  'fish-audio': { src: fishaudio, mono: true },
}

function Mark(props: { logo: Logo; size: number; className?: string }) {
  const { logo, size } = props
  if (logo.mono)
    return (
      <span
        aria-hidden
        className={cn('inline-block shrink-0 bg-current', props.className)}
        style={{
          width: size,
          height: size,
          mask: `url("${logo.src}") center / contain no-repeat`,
          WebkitMask: `url("${logo.src}") center / contain no-repeat`,
        }}
      />
    )
  return (
    <img
      src={logo.src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      className={cn('shrink-0', props.className)}
    />
  )
}

/** A letter on a quiet tile, for makers and providers without a logo. */
function Letter(props: { text: string; size: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-sm bg-fill-strong font-semibold leading-none text-fg-2',
        props.className,
      )}
      style={{ width: props.size, height: props.size, fontSize: Math.round(props.size * 0.55) }}
    >
      {(props.text.replace(/^.*\//, '')[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** The logo of a model's maker (Claude, OpenAI, Gemini, DeepSeek…), so a list of models scans by family. */
export function ProviderGlyph(props: { model: string; size?: number; className?: string }) {
  const size = props.size ?? 16
  // The whole ref counts, provider prefix included: models served through Codex show Codex's logo.
  const model = props.model
  const logo = MAKERS.find(([re]) => re.test(model))?.[1]
  return logo ? (
    <Mark logo={logo} size={size} {...(props.className ? { className: props.className } : {})} />
  ) : (
    <Letter text={model} size={size} {...(props.className ? { className: props.className } : {})} />
  )
}

/** The logo of the provider serving a group of models (Bedrock, Ark, OpenRouter…). */
export function ProviderLogo(props: { provider: string; size?: number; className?: string }) {
  const size = props.size ?? 14
  const logo = PROVIDERS[props.provider.toLowerCase()]
  return logo ? (
    <Mark logo={logo} size={size} {...(props.className ? { className: props.className } : {})} />
  ) : (
    <Letter text={props.provider} size={size} {...(props.className ? { className: props.className } : {})} />
  )
}
