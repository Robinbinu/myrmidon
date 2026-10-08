import type { PluginToolDefinition } from '../plugin-host.ts'
import { prompts } from '../prompts.ts'
import { channelCopy } from './copy.ts'
import { DingTalkAdapter } from './dingtalk.ts'
import { FEISHU_API, FeishuAdapter, LARK_API } from './feishu.ts'
import type { ChannelHub, ChannelKind } from './hub.ts'
import { QQAdapter } from './qq.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'
import { WeComAdapter } from './wecom.ts'
import { WeixinAdapter } from './weixin.ts'

export * from './dingtalk.ts'
export * from './feishu.ts'
export * from './format.ts'
export * from './hub.ts'
export * from './qq.ts'
export * from './store.ts'
export * from './telegram.ts'
export * from './types.ts'
export * from './wecom.ts'
export * from './weixin.ts'

/** Channels Myrmidon has built in; plugins add more with `ctx.channels.register`. */
export const BUILT_IN_CHANNELS: Readonly<Record<string, ChannelKind>> = {
  telegram: {
    label: 'Telegram',
    setup: channelCopy.setup.telegram,
    fields: [{ key: 'token', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' }],
    // MYR_TELEGRAM_API points at a self-hosted Bot API server (Telegram's own `telegram-bot-api`) instead.
    make: (values) => new TelegramAdapter(values.token ?? '', process.env.MYR_TELEGRAM_API || TELEGRAM_API),
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
