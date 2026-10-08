import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'
import { WhatsAppAdapter } from './whatsapp.ts'
import { WhatsAppCloudAdapter } from './whatsapp-cloud.ts'

export * from './format.ts'
export * from './hub.ts'
export * from './store.ts'
export * from './telegram.ts'
export * from './types.ts'
export * from './whatsapp.ts'
export * from './whatsapp-cloud.ts'

const cloud = channelCopy.fields.whatsappCloud

/** Channels Myrmidon has built in; plugins add more with `ctx.channels.register`. */
export const BUILT_IN_CHANNELS: Readonly<Record<string, ChannelKind>> = {
  telegram: {
    label: 'Telegram',
    setup: channelCopy.setup.telegram,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' }],
    // MYR_TELEGRAM_API points at a self-hosted Bot API server (Telegram's own `telegram-bot-api`) instead.
    make: (values) => new TelegramAdapter(values.token ?? '', process.env.MYR_TELEGRAM_API || TELEGRAM_API),
  },
  // Nothing to fill in: it links by QR code once switched on, and keeps its session in the channel's folder.
  whatsapp: {
    label: 'WhatsApp',
    setup: channelCopy.setup.whatsapp,
    fields: [],
    make: () => new WhatsAppAdapter(),
  },
  'whatsapp-cloud': {
    label: 'WhatsApp Cloud API',
    setup: channelCopy.setup['whatsapp-cloud'],
    fields: [
      {
        key: 'phoneNumberId',
        label: cloud.phoneNumberId,
        hint: cloud.phoneNumberIdHint,
        placeholder: '1234567890',
      },
      { key: 'token', label: cloud.token, secret: true, placeholder: 'EAA…' },
      { key: 'appSecret', label: cloud.appSecret, secret: true, hint: cloud.appSecretHint },
      { key: 'verifyToken', label: cloud.verifyToken, hint: cloud.verifyTokenHint },
    ],
    make: (values) =>
      new WhatsAppCloudAdapter({
        phoneNumberId: values.phoneNumberId ?? '',
        token: values.token ?? '',
        appSecret: values.appSecret ?? '',
        verifyToken: values.verifyToken ?? '',
      }),
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
