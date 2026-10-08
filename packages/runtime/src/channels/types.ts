/**
 * What a messaging platform implements to be a channel (after OpenClaw's `ChannelPlugin` and Hermes's
 * `BasePlatformAdapter`): receiving, sending, editing and typing. Everything platforms share — who may talk, which
 * chat a message belongs to, progress, chunking, dedupe — is the hub's (`hub.ts`).
 */

/** A conversation on the platform: a direct chat with one person, or a group. */
export interface ChannelChat {
  readonly id: string
  readonly kind: 'dm' | 'group'
  readonly title?: string
}

export interface ChannelSender {
  readonly id: string
  readonly name: string
  readonly handle?: string
}

/** A message that arrived. */
export interface Inbound {
  /** The platform's id for it, unique within the chat (for dropping redeliveries). */
  readonly messageId: string
  readonly chat: ChannelChat
  readonly sender: ChannelSender
  /** Its text, with the bot's own @mention removed; a caption for media. */
  readonly text: string
  /** In a group: the bot was @mentioned, replied to, or sent a command. Always true in a direct chat. */
  readonly mentioned: boolean
  /** It carried something other than text that this channel cannot take yet (a photo, a voice note). */
  readonly unsupported?: boolean
  readonly time: string
}

/** A message to send: Markdown, which the adapter renders for its platform. */
export interface OutMessage {
  readonly text: string
}

/** A sent message, so it can be edited later. */
export interface SentRef {
  readonly chat: string
  readonly id: string
}

/** What the hub gives a running adapter. */
export interface AdapterIO {
  /** Hands a message to the hub; it resolves once the message is recorded (not handled), so polling can go on. */
  receive(message: Inbound): Promise<void>
  /** A small value the adapter keeps across restarts (Telegram's polling offset). */
  get(key: string): string | undefined
  set(key: string, value: string): void
  /** How the connection is doing, for Settings and `myrmidon doctor`. */
  status(status: AdapterStatus): void
  log(message: string): void
}

export type AdapterStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'on'; readonly account: string }
  /** It keeps trying (a network error, another program polling the same bot). */
  | { readonly state: 'retrying'; readonly error: string }
  /** It gave up until the person changes something (a refused token). */
  | { readonly state: 'error'; readonly error: string }

export interface ChannelAdapter {
  readonly id: string
  readonly label: string
  /** The longest message it can send, and how long to wait between edits of one message. */
  readonly limits: { readonly text: number; readonly editMs: number }
  /** Checks its credentials and says which account they are (e.g. `@mybot`); throws with the reason otherwise. */
  check(): Promise<string>
  /** Starts receiving; resolves once started. */
  start(io: AdapterIO): Promise<void>
  stop(): Promise<void>
  send(chat: string, message: OutMessage): Promise<SentRef>
  edit(ref: SentRef, message: OutMessage): Promise<void>
  typing(chat: string): Promise<void>
}

/** Makes a platform's adapter from its saved settings (the token). */
export type AdapterFactory = (config: { readonly token: string }) => ChannelAdapter
