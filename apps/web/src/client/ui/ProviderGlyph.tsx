import { cn } from './primitives.tsx'

interface Mark {
  readonly letter: string
  readonly bg: string
  readonly fg: string
}

/** Model families, matched on the names their models go by, so a model hosted elsewhere still shows its maker. */
const FAMILIES: [RegExp, Mark][] = [
  [/claude|anthropic/i, { letter: 'A', bg: '#d97757', fg: '#ffffff' }],
  [/gemini|gemma|google/i, { letter: 'G', bg: '#4285f4', fg: '#ffffff' }],
  [/deepseek/i, { letter: 'D', bg: '#4d6bfe', fg: '#ffffff' }],
  [/grok|xai/i, { letter: 'X', bg: '#16161a', fg: '#ffffff' }],
  [/qwen|alibaba/i, { letter: 'Q', bg: '#615ced', fg: '#ffffff' }],
  [/llama|meta/i, { letter: 'M', bg: '#0668e1', fg: '#ffffff' }],
  [/mistral|codestral/i, { letter: 'M', bg: '#fa520f', fg: '#ffffff' }],
  [/kimi|moonshot/i, { letter: 'K', bg: '#27272a', fg: '#ffffff' }],
  [/glm|zhipu/i, { letter: 'Z', bg: '#3859ff', fg: '#ffffff' }],
  [/gpt|openai|codex/i, { letter: 'O', bg: '#10a37f', fg: '#ffffff' }],
]

/** A small rounded mark for a model's maker, so a list of models scans by family at a glance. */
export function ProviderGlyph(props: { model: string; size?: number; className?: string }) {
  const mark = FAMILIES.find(([re]) => re.test(props.model))?.[1]
  const size = props.size ?? 18
  const letter = mark?.letter ?? (props.model.replace(/^.*\//, '')[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-[5px] font-semibold leading-none shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)]',
        !mark && 'bg-fill-strong text-fg-2',
        props.className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        ...(mark ? { background: mark.bg, color: mark.fg } : {}),
      }}
    >
      {letter}
    </span>
  )
}
