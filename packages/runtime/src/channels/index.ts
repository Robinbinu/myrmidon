import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'

export * from './format.ts'
export * from './hub.ts'
export * from './store.ts'
export * from './telegram.ts'
export * from './types.ts'

/** Channels Myrmidon has built in; plugins add more with `ctx.channels.register`. */
export const BUILT_IN_CHANNELS: Readonly<Record<string, ChannelKind>> = {
  telegram: {
    label: 'Telegram',
    setup: channelCopy.setup.telegram,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' }],
    // MYR_TELEGRAM_API points at a self-hosted Bot API server (Telegram's own `telegram-bot-api`) instead.
    make: (values) => new TelegramAdapter(values.token ?? '', process.env.MYR_TELEGRAM_API || TELEGRAM_API),
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
