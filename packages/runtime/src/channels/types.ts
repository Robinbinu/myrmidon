/**
 * What a messaging platform implements to be a channel (after OpenClaw's `ChannelPlugin` and Hermes's
 * `BasePlatformAdapter`): receiving, sending, editing, buttons, files and typing. Everything platforms share — who
 * may talk, which chat a message belongs to, progress, approvals, chunking, dedupe, delivery — is the hub's
 * (`hub.ts`).
 */

/** A conversation on the platform: a direct chat with one person, or a group (and a thread or topic in it). */
export interface ChannelChat {
  readonly id: string
  readonly kind: 'dm' | 'group'
  readonly title?: string
  /** A thread or forum topic inside the chat, which is a conversation of its own. */
  readonly thread?: string
}

export interface ChannelSender {
  readonly id: string
  readonly name: string
  readonly handle?: string
}

/** A file that came with a message; read on demand, since most are never needed. */
export interface InboundFile {
  readonly kind: 'image' | 'voice' | 'audio' | 'video' | 'document'
  readonly name: string
  readonly mimeType: string
  readonly size?: number
  read(): Promise<Uint8Array>
}

/** Someone pressed a button the hub sent. */
export interface ButtonPress {
  /** The platform's id for acknowledging the press. */
  readonly id: string
  /** The button's data, as the hub set it. */
  readonly data: string
  /** The message the button was on. */
  readonly message?: SentRef
}

/** A message that arrived (or a button press). */
export interface Inbound {
  /** The platform's id for it, unique within the chat (for dropping redeliveries). */
  readonly messageId: string
  readonly chat: ChannelChat
  readonly sender: ChannelSender
  /** Its text, with the bot's own @mention removed; a caption for media. */
  readonly text: string
  /** In a group: the bot was @mentioned, replied to, or sent a command. Always true in a direct chat. */
  readonly mentioned: boolean
  readonly files?: readonly InboundFile[]
  readonly press?: ButtonPress
  /** It carried something this channel cannot take (a sticker, a location). */
  readonly unsupported?: boolean
  readonly time: string
}

export interface Button {
  readonly label: string
  /** Short: Telegram allows 64 bytes. */
  readonly data: string
}

/** A message to send: Markdown, which the adapter renders for its platform, with optional rows of buttons. */
export interface OutMessage {
  readonly text: string
  readonly buttons?: readonly (readonly Button[])[]
}

export interface OutFile {
  readonly name: string
  readonly mimeType: string
  readonly data: Uint8Array
  readonly caption?: string
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
  /** Where the platform should send webhooks for this channel, when the gateway has a public address. */
  readonly webhookUrl?: string
}

export type AdapterStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'on'; readonly account: string }
  /** It keeps trying (a network error, another program polling the same bot). */
  | { readonly state: 'retrying'; readonly error: string }
  /** It gave up until the person changes something (a refused token). */
  | { readonly state: 'error'; readonly error: string }
  /**
   * It needs the person to link it by scanning a code with their phone (WhatsApp's linked devices): `qr` is the
   * code's content (printed in the terminal), `image` the same as a PNG data URL (shown in Settings).
   */
  | { readonly state: 'linking'; readonly qr: string; readonly image: string; readonly hint?: string }

export interface ChannelAdapter {
  readonly id: string
  readonly label: string
  /** The longest message it can send, how long to wait between edits of one message, the largest file. */
  readonly limits: { readonly text: number; readonly editMs: number; readonly file?: number }
  /** What it can do beyond text; the hub falls back to typed commands and file names. */
  readonly can: { readonly buttons: boolean; readonly files: boolean; readonly edit: boolean }
  /** Checks its credentials and says which account they are (e.g. `@mybot`); throws with the reason otherwise. */
  check(): Promise<string>
  /** Starts receiving; resolves once started. */
  start(io: AdapterIO): Promise<void>
  stop(): Promise<void>
  send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef>
  edit(ref: SentRef, message: OutMessage): Promise<void>
  typing(chat: ChannelChat | string): Promise<void>
  sendFile?(chat: ChannelChat | string, file: OutFile): Promise<SentRef>
  /** Acknowledges a button press, with a short note the platform may show. */
  answerPress?(press: ButtonPress, note?: string): Promise<void>
  /** Handles a webhook from the platform (signature checked here); for platforms that push instead of polling. */
  webhook?(req: Request): Promise<Response>
}

/** One setting a platform needs, shown in Settings → Channels and asked for by `myrmidon channels <id>`. */
export interface ChannelField {
  readonly key: string
  readonly label: string
  /** Kept out of every listing; typed hidden in the CLI. */
  readonly secret?: boolean
  readonly placeholder?: string
  readonly hint?: string
  readonly optional?: boolean
}

/** A channel's settings by field key (a bot token, a server address…). */
export type ChannelValues = Readonly<Record<string, string>>

/** Makes a platform's adapter from its saved settings. */
export type AdapterFactory = (values: ChannelValues) => ChannelAdapter

/** Where a chat id and thread meet, for the platforms' send functions. */
export const chatIdOf = (chat: ChannelChat | string) => (typeof chat === 'string' ? chat : chat.id)
export const threadOf = (chat: ChannelChat | string) => (typeof chat === 'string' ? undefined : chat.thread)
