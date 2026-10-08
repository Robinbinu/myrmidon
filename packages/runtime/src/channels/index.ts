import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import { DingTalkAdapter } from './dingtalk.ts'
import { DiscordAdapter } from './discord.ts'
import { EmailAdapter } from './email.ts'
import { FEISHU_API, FeishuAdapter, LARK_API } from './feishu.ts'
import { GoogleChatAdapter } from './googlechat.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { IMessageAdapter } from './imessage.ts'
import { IrcAdapter } from './irc.ts'
import { LineAdapter } from './line.ts'
import { MatrixAdapter } from './matrix.ts'
import { MattermostAdapter } from './mattermost.ts'
import { TeamsAdapter } from './msteams.ts'
import { NextcloudTalkAdapter } from './nextcloud-talk.ts'
import { NostrAdapter } from './nostr.ts'
import { NTFY_SERVER, NtfyAdapter } from './ntfy.ts'
import { QQAdapter } from './qq.ts'
import { SignalAdapter } from './signal.ts'
import { SIMPLEX_URL, SimplexAdapter } from './simplex.ts'
import { SlackAdapter } from './slack.ts'
import { SmsAdapter, TWILIO_API } from './sms.ts'
import { SynologyChatAdapter } from './synology-chat.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'
import { TlonAdapter } from './tlon.ts'
import { TwitchAdapter } from './twitch.ts'
import { WebhookAdapter } from './webhook.ts'
import { WeComAdapter } from './wecom.ts'
import { WeixinAdapter } from './weixin.ts'
import { WhatsAppAdapter } from './whatsapp.ts'
import { WhatsAppCloudAdapter } from './whatsapp-cloud.ts'
import { X_API, XAdapter } from './x.ts'
import { ZALO_API, ZaloAdapter } from './zalo.ts'

export * from './dingtalk.ts'
export * from './discord.ts'
export * from './email.ts'
export * from './feishu.ts'
export * from './format.ts'
export * from './googlechat.ts'
export * from './hub.ts'
export * from './imessage.ts'
export * from './irc.ts'
export * from './jwt.ts'
export * from './line.ts'
export * from './matrix.ts'
export * from './mattermost.ts'
export * from './msteams.ts'
export * from './nextcloud-talk.ts'
export * from './nostr.ts'
export * from './ntfy.ts'
export * from './qq.ts'
export * from './signal.ts'
export * from './simplex.ts'
export * from './slack.ts'
export * from './sms.ts'
export * from './store.ts'
export * from './synology-chat.ts'
export * from './telegram.ts'
export * from './tlon.ts'
export * from './twitch.ts'
export * from './types.ts'
export * from './webhook.ts'
export * from './wecom.ts'
export * from './weixin.ts'
export * from './whatsapp.ts'
export * from './whatsapp-cloud.ts'
export * from './x.ts'
export * from './zalo.ts'

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
    defaults: { dm: 'allowlist' },
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
    defaults: { dm: 'allowlist' },
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
  msteams: {
    label: 'Microsoft Teams',
    setup: channelCopy.setup.msteams,
    fields: [
      { key: 'appId', label: 'App ID', placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'password', label: 'Client secret', secret: true },
      {
        key: 'tenant',
        label: 'Tenant ID',
        optional: true,
        hint: channelCopy.hints.msteamsTenant,
      },
    ],
    make: (values) => new TeamsAdapter(values.appId ?? '', values.password ?? '', values.tenant ?? ''),
  },
  googlechat: {
    label: 'Google Chat',
    setup: channelCopy.setup.googlechat,
    fields: [
      {
        key: 'serviceAccount',
        label: 'Service account key',
        secret: true,
        placeholder: '{"type": "service_account", …}',
        hint: channelCopy.hints.googlechatKey,
      },
      {
        key: 'audience',
        label: 'Project number',
        optional: true,
        placeholder: '123456789012',
        hint: channelCopy.hints.googlechatAudience,
      },
    ],
    make: (values) => new GoogleChatAdapter(values.serviceAccount ?? '', values.audience ?? ''),
  },
  line: {
    label: 'LINE',
    setup: channelCopy.setup.line,
    fields: [
      { key: 'token', label: 'Channel access token', secret: true },
      { key: 'secret', label: 'Channel secret', secret: true },
    ],
    make: (values) => new LineAdapter(values.token ?? '', values.secret ?? ''),
  },
  feishu: {
    label: 'Feishu / Lark',
    setup: channelCopy.setup.feishu,
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_a1b2c3…' },
      { key: 'appSecret', label: 'App Secret', secret: true },
      {
        key: 'region',
        label: 'Region',
        placeholder: 'feishu',
        hint: 'feishu for feishu.cn (the default), lark for larksuite.com',
        optional: true,
      },
      {
        key: 'verificationToken',
        label: 'Verification Token',
        secret: true,
        optional: true,
        hint: 'Only for events sent by webhook instead of the long connection',
      },
      {
        key: 'encryptKey',
        label: 'Encrypt Key',
        secret: true,
        optional: true,
        hint: 'Only for events sent by webhook: they are then signed and encrypted',
      },
    ],
    make: (v) =>
      new FeishuAdapter(
        {
          appId: v.appId ?? '',
          appSecret: v.appSecret ?? '',
          ...(v.verificationToken ? { verificationToken: v.verificationToken } : {}),
          ...(v.encryptKey ? { encryptKey: v.encryptKey } : {}),
        },
        v.region?.trim().toLowerCase() === 'lark' ? LARK_API : FEISHU_API,
      ),
  },
  dingtalk: {
    label: 'DingTalk',
    setup: channelCopy.setup.dingtalk,
    fields: [
      { key: 'clientId', label: 'Client ID (AppKey)', placeholder: 'dingxxxxxxxx' },
      { key: 'clientSecret', label: 'Client Secret (AppSecret)', secret: true },
      {
        key: 'robotCode',
        label: 'Robot code',
        optional: true,
        hint: 'Leave empty: it is the Client ID for most robots',
      },
    ],
    make: (v) =>
      new DingTalkAdapter({
        clientId: v.clientId ?? '',
        clientSecret: v.clientSecret ?? '',
        ...(v.robotCode ? { robotCode: v.robotCode } : {}),
      }),
  },
  wecom: {
    label: 'WeCom',
    setup: channelCopy.setup.wecom,
    fields: [
      { key: 'corpId', label: 'Corp ID', placeholder: 'ww…' },
      { key: 'agentId', label: 'AgentId', placeholder: '1000002' },
      { key: 'secret', label: 'Secret', secret: true },
      { key: 'token', label: 'Token', secret: true, hint: 'From the app’s Receive Messages settings' },
      { key: 'aesKey', label: 'EncodingAESKey', secret: true, hint: '43 characters, from the same settings' },
    ],
    make: (v) =>
      new WeComAdapter({
        corpId: v.corpId ?? '',
        agentId: v.agentId ?? '',
        secret: v.secret ?? '',
        token: v.token ?? '',
        aesKey: v.aesKey ?? '',
      }),
  },
  // Nothing to type: turning it on shows a code to scan with WeChat.
  weixin: {
    label: 'WeChat',
    setup: channelCopy.setup.weixin,
    fields: [],
    make: () => new WeixinAdapter(),
  },
  qq: {
    label: 'QQ',
    setup: channelCopy.setup.qq,
    fields: [
      { key: 'appId', label: 'App ID', placeholder: '102xxxxxx' },
      { key: 'secret', label: 'AppSecret', secret: true },
      {
        key: 'markdown',
        label: 'Markdown',
        placeholder: 'on',
        optional: true,
        hint: 'off if the bot lacks QQ’s Markdown permission (then approvals are typed)',
      },
    ],
    make: (v) =>
      new QQAdapter({
        appId: v.appId ?? '',
        secret: v.secret ?? '',
        markdown: v.markdown?.trim().toLowerCase() !== 'off',
      }),
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
    defaults: { groups: 'open' },
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
    defaults: { groups: 'open' },
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
