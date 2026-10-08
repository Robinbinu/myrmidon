import { Hash, Mail, MessageSquare, MessageSquareText, Webhook } from 'lucide-react'
import { CHANNEL_LOGOS, FALLBACK_LOGO } from '../channel-logos.ts'
import { cn } from './primitives.tsx'

const ICONS = { mail: Mail, sms: MessageSquareText, hash: Hash, webhook: Webhook, chat: MessageSquare }

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
        <span className="font-semibold leading-none" style={{ fontSize: Math.round(size * 0.48) }}>
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
