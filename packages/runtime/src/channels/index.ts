import type { ChannelKind } from './hub.ts'
import { TELEGRAM_API, TelegramAdapter } from './telegram.ts'

export * from './format.ts'
export * from './hub.ts'
export * from './store.ts'
export * from './telegram.ts'
export * from './types.ts'

/** Channels Myrmidon has built in; plugins add more later. */
export const BUILT_IN_CHANNELS: Readonly<Record<string, ChannelKind>> = {
  // MYR_TELEGRAM_API points at a self-hosted Bot API server (Telegram's own `telegram-bot-api`) instead.
  telegram: {
    label: 'Telegram',
    make: ({ token }) => new TelegramAdapter(token, process.env.MYR_TELEGRAM_API || TELEGRAM_API),
  },
}
