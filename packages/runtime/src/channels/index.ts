import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { NextcloudTalkAdapter } from './nextcloud-talk.ts'
import { SIMPLEX_URL, SimplexAdapter } from './simplex.ts'
import { SynologyChatAdapter } from './synology-chat.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'
import { TlonAdapter } from './tlon.ts'
import { WebhookAdapter } from './webhook.ts'

export * from './format.ts'
export * from './hub.ts'
export * from './nextcloud-talk.ts'
export * from './simplex.ts'
export * from './store.ts'
export * from './synology-chat.ts'
export * from './telegram.ts'
export * from './tlon.ts'
export * from './types.ts'
export * from './webhook.ts'

/** Channels Myrmidon has built in; plugins add more with `ctx.channels.register`. */
export const BUILT_IN_CHANNELS: Readonly<Record<string, ChannelKind>> = {
  telegram: {
    label: 'Telegram',
    setup: channelCopy.setup.telegram,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' }],
    // MYR_TELEGRAM_API points at a self-hosted Bot API server (Telegram's own `telegram-bot-api`) instead.
    make: (values) => new TelegramAdapter(values.token ?? '', process.env.MYR_TELEGRAM_API || TELEGRAM_API),
  },
  'synology-chat': {
    label: 'Synology Chat',
    setup: channelCopy.setup['synology-chat'],
    fields: [
      {
        key: 'incomingUrl',
        label: 'Incoming URL',
        secret: true,
        placeholder: 'https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot…',
        hint: "The bot's incoming URL; it carries the bot's token.",
      },
      {
        key: 'token',
        label: 'Outgoing token',
        secret: true,
        hint: "The token from the bot's outgoing URL settings.",
      },
    ],
    make: (values) => new SynologyChatAdapter(values.incomingUrl ?? '', values.token ?? ''),
  },
  'nextcloud-talk': {
    label: 'Nextcloud Talk',
    setup: channelCopy.setup['nextcloud-talk'],
    fields: [
      { key: 'url', label: 'Server address', placeholder: 'https://cloud.example.com' },
      { key: 'secret', label: 'Bot secret', secret: true, hint: 'The secret given to occ talk:bot:install.' },
      {
        key: 'name',
        label: 'Bot name',
        placeholder: 'Myrmidon',
        optional: true,
        hint: 'As installed; mentioned as @name in group conversations.',
      },
      {
        key: 'user',
        label: 'Nextcloud user',
        optional: true,
        hint: 'With an app password, tells one-to-one conversations from groups.',
      },
      { key: 'password', label: 'App password', secret: true, optional: true },
    ],
    make: (values) =>
      new NextcloudTalkAdapter(
        values.url ?? '',
        values.secret ?? '',
        values.user ?? '',
        values.password ?? '',
        values.name || undefined,
      ),
  },
  simplex: {
    label: 'SimpleX',
    setup: channelCopy.setup.simplex,
    fields: [{ key: 'url', label: 'WebSocket address', placeholder: SIMPLEX_URL, optional: true }],
    make: (values) => new SimplexAdapter(values.url || SIMPLEX_URL),
  },
  tlon: {
    label: 'Tlon',
    setup: channelCopy.setup.tlon,
    fields: [
      { key: 'url', label: 'Ship URL', placeholder: 'https://sampel-palnet.tlon.network' },
      { key: 'code', label: 'Access code', secret: true, placeholder: 'lidlut-tabwed-pillex-ridrup' },
    ],
    make: (values) => new TlonAdapter(values.url ?? '', values.code ?? ''),
  },
  webhook: {
    label: 'Webhook',
    setup: channelCopy.setup.webhook,
    fields: [
      {
        key: 'secret',
        label: 'Shared secret',
        secret: true,
        hint: 'At least 16 characters, e.g. openssl rand -hex 32.',
      },
      {
        key: 'callback',
        label: 'Callback URL',
        placeholder: 'https://example.com/myrmidon',
        hint: 'Where replies are POSTed.',
      },
      { key: 'name', label: 'Name', optional: true, placeholder: 'Home Assistant' },
    ],
    make: (values) => new WebhookAdapter(values.secret ?? '', values.callback ?? '', values.name),
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
