import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import { DiscordAdapter } from './discord.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { IMessageAdapter } from './imessage.ts'
import { MatrixAdapter } from './matrix.ts'
import { SignalAdapter } from './signal.ts'
import { SlackAdapter } from './slack.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'

export * from './discord.ts'
export * from './format.ts'
export * from './hub.ts'
export * from './imessage.ts'
export * from './matrix.ts'
export * from './signal.ts'
export * from './slack.ts'
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
  signal: {
    label: 'Signal',
    setup: channelCopy.setup.signal,
    fields: [
      { key: 'url', ...channelCopy.fields.signal.url, placeholder: 'http://127.0.0.1:8080' },
      { key: 'account', ...channelCopy.fields.signal.account, placeholder: '+15551234567' },
    ],
    make: (values) => new SignalAdapter(values.url ?? '', values.account ?? ''),
  },
  imessage: {
    label: 'iMessage',
    setup: channelCopy.setup.imessage,
    fields: [
      { key: 'url', ...channelCopy.fields.imessage.url, placeholder: 'http://192.168.1.20:1234' },
      { key: 'password', ...channelCopy.fields.imessage.password, secret: true },
      { key: 'name', ...channelCopy.fields.imessage.name, placeholder: 'Myrmidon', optional: true },
    ],
    make: (values) => new IMessageAdapter(values.url ?? '', values.password ?? '', values.name),
  },
  matrix: {
    label: 'Matrix',
    setup: channelCopy.setup.matrix,
    fields: [
      { key: 'homeserver', ...channelCopy.fields.matrix.homeserver, placeholder: 'https://matrix.org' },
      { key: 'token', ...channelCopy.fields.matrix.token, secret: true, placeholder: 'syt_…' },
      {
        key: 'userId',
        ...channelCopy.fields.matrix.userId,
        placeholder: '@myrbot:matrix.org',
        optional: true,
      },
    ],
    make: (values) => new MatrixAdapter(values.homeserver ?? '', values.token ?? '', values.userId),
  },
  discord: {
    label: 'Discord',
    setup: channelCopy.setup.discord,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: 'MTA…' }],
    make: (values) => new DiscordAdapter(values.token ?? ''),
  },
  slack: {
    label: 'Slack',
    setup: channelCopy.setup.slack,
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        secret: true,
        placeholder: 'xoxb-…',
        hint: channelCopy.fields.slackBot,
      },
      {
        key: 'appToken',
        label: 'App-level token',
        secret: true,
        placeholder: 'xapp-…',
        hint: channelCopy.fields.slackApp,
      },
    ],
    make: (values) => new SlackAdapter(values.botToken ?? '', values.appToken ?? ''),
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
