import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import { EmailAdapter } from './email.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { MattermostAdapter } from './mattermost.ts'
import { NTFY_SERVER, NtfyAdapter } from './ntfy.ts'
import { SmsAdapter, TWILIO_API } from './sms.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'

export * from './email.ts'
export * from './format.ts'
export * from './hub.ts'
export * from './mattermost.ts'
export * from './ntfy.ts'
export * from './sms.ts'
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
  mattermost: {
    label: 'Mattermost',
    setup: channelCopy.setup.mattermost,
    fields: [
      { key: 'url', label: 'Server address', placeholder: 'https://chat.example.com' },
      { key: 'token', label: 'Bot token', secret: true },
    ],
    make: (values) => new MattermostAdapter(values.url ?? '', values.token ?? ''),
  },
  email: {
    label: 'Email',
    setup: channelCopy.setup.email,
    fields: [
      { key: 'address', label: 'Its email address', placeholder: 'myrmidon@example.com' },
      { key: 'imapHost', label: 'IMAP server', placeholder: 'imap.gmail.com' },
      { key: 'imapPort', label: 'IMAP port', placeholder: '993', optional: true },
      { key: 'smtpHost', label: 'SMTP server', placeholder: 'smtp.gmail.com' },
      {
        key: 'smtpPort',
        label: 'SMTP port',
        placeholder: '587',
        optional: true,
        hint: '465 for TLS from the start',
      },
      { key: 'user', label: 'Username', optional: true, hint: 'Leave empty to use the address' },
      {
        key: 'password',
        label: 'Password',
        secret: true,
        hint: 'An app password where the provider offers them',
      },
      { key: 'mailbox', label: 'Mailbox', placeholder: 'INBOX', optional: true },
      {
        key: 'authserv',
        label: 'Your mail server in Authentication-Results',
        placeholder: 'mx.google.com',
        optional: true,
        hint: "Only results from this server count; empty trusts the topmost one (the receiving server's)",
      },
      {
        key: 'verify',
        label: 'Check senders',
        placeholder: 'on',
        optional: true,
        hint: 'Type off to accept mail your server did not verify (only for a mailbox no one else can write to)',
      },
    ],
    make: (values) =>
      new EmailAdapter({
        imapHost: values.imapHost ?? '',
        imapPort: Number(values.imapPort) || 993,
        smtpHost: values.smtpHost ?? '',
        smtpPort: Number(values.smtpPort) || 587,
        user: values.user || values.address || '',
        password: values.password ?? '',
        address: values.address ?? '',
        mailbox: values.mailbox || 'INBOX',
        ...(values.authserv ? { authserv: values.authserv } : {}),
        verify: values.verify?.trim().toLowerCase() !== 'off',
      }),
  },
  sms: {
    label: 'SMS (Twilio)',
    setup: channelCopy.setup.sms,
    fields: [
      { key: 'sid', label: 'Account SID', placeholder: 'AC…' },
      { key: 'token', label: 'Auth token', secret: true },
      { key: 'number', label: 'Twilio number', placeholder: '+15551234567' },
    ],
    // MYR_TWILIO_API points at another Twilio API host (a regional edge, or a stand-in for tests).
    make: (values) =>
      new SmsAdapter(
        values.sid ?? '',
        values.token ?? '',
        values.number ?? '',
        process.env.MYR_TWILIO_API || TWILIO_API,
      ),
  },
  ntfy: {
    label: 'ntfy',
    setup: channelCopy.setup.ntfy,
    fields: [
      { key: 'server', label: 'Server', placeholder: NTFY_SERVER, optional: true },
      {
        key: 'topic',
        label: 'Topic',
        secret: true,
        hint: 'Long and random: anyone who knows it can read and write it',
      },
      {
        key: 'token',
        label: 'Access token',
        secret: true,
        optional: true,
        hint: 'tk_… or user:password, for a protected topic',
      },
    ],
    make: (values) => new NtfyAdapter(values.server || NTFY_SERVER, values.topic ?? '', values.token ?? ''),
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
