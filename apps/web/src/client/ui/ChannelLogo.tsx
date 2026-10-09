import { AtSign, Hash, MessageCircle, Smartphone, Webhook } from 'lucide-react'
import { CHANNEL_LOGOS, FALLBACK_LOGO } from '../channel-logos.ts'
import { cn } from './primitives.tsx'

const ICONS = { mail: AtSign, sms: Smartphone, hash: Hash, webhook: Webhook, chat: MessageCircle }

/** A messaging app's mark on its brand colour, as a rounded tile: in channel tiles, chat rows and status lists. */
export function ChannelLogo(props: { id: string; size?: number; className?: string; title?: string }) {
  const logo = CHANNEL_LOGOS[props.id] ?? FALLBACK_LOGO
  const size = props.size ?? 28
  const inner = Math.round(size * 0.58)
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center text-white', props.className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), background: logo.color }}
      title={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      {'path' in logo ? (
        <svg
          viewBox="0 0 24 24"
          width={inner}
          height={inner}
          fill="currentColor"
          role="img"
          aria-hidden="true"
        >
          <path d={logo.path} />
        </svg>
      ) : 'letters' in logo ? (
        // Bold and sized to the letters, so a monogram carries the weight of the marks beside it.
        <span
          className="font-bold leading-none tracking-tight"
          style={{ fontSize: Math.round(size * ([...logo.letters].length > 1 ? 0.42 : 0.52)) }}
        >
          {logo.letters}
        </span>
      ) : (
        (() => {
          const Icon = ICONS[logo.icon]
          return <Icon style={{ width: inner, height: inner }} strokeWidth={2.2} />
        })()
      )}
    </span>
  )
}
