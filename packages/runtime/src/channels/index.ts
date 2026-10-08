import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { IrcAdapter } from './irc.ts'
import { NostrAdapter } from './nostr.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'
import { TwitchAdapter } from './twitch.ts'
import { X_API, XAdapter } from './x.ts'
import { ZALO_API, ZaloAdapter } from './zalo.ts'

export * from './format.ts'
export * from './hub.ts'
export * from './irc.ts'
export * from './nostr.ts'
export * from './store.ts'
export * from './telegram.ts'
export * from './twitch.ts'
export * from './types.ts'
export * from './x.ts'
export * from './zalo.ts'

/** Channels Myrmidon has built in; plugins add more with `ctx.channels.register`. */
export const BUILT_IN_CHANNELS: Readonly<Record<string, ChannelKind>> = {
  telegram: {
    label: 'Telegram',
    setup: channelCopy.setup.telegram,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' }],
    // MYR_TELEGRAM_API points at a self-hosted Bot API server (Telegram's own `telegram-bot-api`) instead.
    make: (values) => new TelegramAdapter(values.token ?? '', process.env.MYR_TELEGRAM_API || TELEGRAM_API),
  },
  irc: {
    label: 'IRC',
    setup: channelCopy.setup.irc,
    fields: [
      { key: 'server', label: 'Server', placeholder: 'irc.libera.chat' },
      {
        key: 'port',
        label: 'Port',
        placeholder: '6697',
        optional: true,
        hint: '6697 with TLS, 6667 without',
      },
      { key: 'tls', label: 'TLS', placeholder: 'on', optional: true, hint: 'on or off' },
      { key: 'nick', label: 'Nick', placeholder: 'mybot' },
      {
        key: 'password',
        label: 'Password',
        secret: true,
        optional: true,
        hint: 'SASL when the server offers it, else the server password',
      },
      { key: 'channels', label: 'Channels to join', placeholder: '#mychannel, #ops', optional: true },
    ],
    make: (values) => new IrcAdapter(values),
  },
  twitch: {
    label: 'Twitch',
    setup: channelCopy.setup.twitch,
    fields: [
      { key: 'username', label: "Bot's username", placeholder: 'mybot' },
      { key: 'token', label: 'OAuth token', secret: true, placeholder: 'oauth:…' },
      {
        key: 'channels',
        label: 'Channels to join',
        placeholder: 'mychannel',
        optional: true,
        hint: "the bot's own channel when empty",
      },
    ],
    make: (values) => new TwitchAdapter(values),
  },
  x: {
    label: 'X',
    setup: channelCopy.setup.x,
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'apiSecret', label: 'API key secret', secret: true },
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'accessSecret', label: 'Access token secret', secret: true },
      {
        key: 'replyTo',
        label: 'Answers publicly',
        placeholder: '@you, 123456789',
        hint: 'the X accounts whose mentions it answers; everyone else is ignored',
      },
    ],
    make: (values) => new XAdapter(values, process.env.MYR_X_API || X_API),
  },
  nostr: {
    label: 'Nostr',
    setup: channelCopy.setup.nostr,
    fields: [
      { key: 'privateKey', label: 'Private key', secret: true, placeholder: 'nsec1…' },
      {
        key: 'relays',
        label: 'Relays',
        placeholder: 'wss://relay.damus.io, wss://nos.lol',
        optional: true,
        hint: 'relay.damus.io and nos.lol when empty',
      },
    ],
    make: (values) => new NostrAdapter(values),
  },
  zalo: {
    label: 'Zalo',
    setup: channelCopy.setup.zalo,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: '12345689:abc-xyz' }],
    // MYR_ZALO_API points at another Bot API address (a proxy, a test server).
    make: (values) => new ZaloAdapter(values.token ?? '', process.env.MYR_ZALO_API || ZALO_API),
  },
}

/** The agents' tool for messaging the owner on a channel (OpenClaw's core `message` tool), as `channels_send`. */
export function channelSendTool(hub: ChannelHub): PluginToolDefinition {
  const t = prompts.channels.sendTool
  return {
    name: 'send',
    description: t.description,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: t.text },
        channel: { type: 'string', description: t.channel },
      },
      required: ['text'],
    },
    run: async (args) => {
      try {
        return t.sent(
          await hub.notify(
            String(args.text ?? ''),
            typeof args.channel === 'string' ? args.channel : undefined,
          ),
        )
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}
