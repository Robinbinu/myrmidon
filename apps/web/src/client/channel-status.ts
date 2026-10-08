import { copy } from './copy.ts'

/** A channel's connection as `/api/channels` reports it. */
export type ChannelConnection =
  | { state: 'off' | 'connecting' }
  | { state: 'on'; account: string }
  | { state: 'retrying' | 'error'; error: string }
  | { state: 'linking'; qr: string; image: string; hint?: string }

/** What a channel's tile and sheet say: how it is connected while on; while off, whether it is set up at all. */
export function channelStatusText(c: { enabled: boolean; configured: boolean; status: ChannelConnection }) {
  const t = copy.settings.channels.status
  if (!c.configured) return t.notSetUp
  if (!c.enabled) return t.setUpOff
  const s = c.status
  return s.state === 'on'
    ? t.on(s.account)
    : s.state === 'retrying'
      ? t.retrying(s.error)
      : s.state === 'error'
        ? t.error(s.error)
        : s.state === 'linking'
          ? (s.hint ?? t.linking)
          : t[s.state]
}
