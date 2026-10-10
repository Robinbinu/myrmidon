import { createHash, randomBytes } from 'node:crypto'
import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import type { ChatSummary } from './chat.ts'
import {
  SHARE_CODE_LENGTH,
  SHARE_INVITE_MS,
  SHARE_MAX_GUESTS,
  SHARE_MAX_INVITES,
  SHARE_NAME_CHARS,
} from './config.ts'
import { prompts } from './prompts.ts'

/**
 * Sharing one chat live with other people, after omp's collab (`/collab`, src/collab/host.ts): the host stays the
 * authority and guests never reach each other; a link lets its guest watch, or watch and write; whatever a guest
 * writes carries their name; the host sees who is in and can end it. Unlike omp there is no relay: guests reach this
 * Myrmidon itself, over the address its devices use (docs/remote.md), and see only the shared chat.
 *
 * Everything is kept in memory: a restart ends every share, and its guests are invited again.
 */

/** `view`: the guest watches; `write`: the guest may also write into the chat (every outside step then asks). */
export type ShareAccess = 'view' | 'write'

export interface ShareInvite {
  readonly id: string
  readonly chatId: string
  readonly access: ShareAccess
  readonly createdAt: string
  readonly expiresAt: string
}

export interface ChatGuest {
  readonly id: string
  readonly chatId: string
  readonly name: string
  readonly access: ShareAccess
  readonly joinedAt: string
}

/** No look-alike characters (0/O, 1/I/L), so a code read aloud or retyped survives (as pairing codes). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** A name as a guest typed it, safe to show: one line, no control characters, cut short. */
export function guestName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  return clean.slice(0, SHARE_NAME_CHARS).trim() || 'Guest'
}

export class ChatShares {
  /** Open invites by code. */
  private readonly _invites = new Map<string, ShareInvite>()
  /** Guests by the hash of their token; the token itself is never kept. */
  private readonly _guests = new Map<string, ChatGuest>()

  constructor(private readonly _now: () => number = Date.now) {}

  /** A single-use invite to `chatId`; the code is the secret, returned once. */
  invite(chatId: string, access: ShareAccess): { invite: ShareInvite; code: string } {
    this._prune()
    if (this.invites(chatId).length >= SHARE_MAX_INVITES)
      throw new Error(`A chat can have at most ${SHARE_MAX_INVITES} open invites. Withdraw one first.`)
    const bytes = randomBytes(SHARE_CODE_LENGTH)
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')
    const now = this._now()
    const invite: ShareInvite = {
      id: `inv-${randomBytes(6).toString('hex')}`,
      chatId,
      access,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SHARE_INVITE_MS).toISOString(),
    }
    this._invites.set(code, invite)
    return { invite, code }
  }

  /** A chat's open invites, oldest first. */
  invites(chatId: string): ShareInvite[] {
    this._prune()
    return [...this._invites.values()].filter((i) => i.chatId === chatId)
  }

  /** Withdraws one invite of `chatId`; false when there is none by that id. */
  withdraw(chatId: string, id: string): boolean {
    for (const [code, invite] of this._invites)
      if (invite.id === id && invite.chatId === chatId) return this._invites.delete(code)
    return false
  }

  /**
   * Spends an invite: the guest it makes and their token (shown once, kept only as a hash). `wrong` for a code that is
   * wrong, used or expired; `full` when the chat already has as many guests as it may (the invite stays open).
   */
  join(code: string, name: unknown): { guest: ChatGuest; token: string } | 'wrong' | 'full' {
    this._prune()
    const key = typeof code === 'string' ? code.trim().toUpperCase() : ''
    const invite = this._invites.get(key)
    if (!invite) return 'wrong'
    if (this.guests(invite.chatId).length >= SHARE_MAX_GUESTS) return 'full'
    this._invites.delete(key)
    const token = randomBytes(32).toString('base64url')
    const guest: ChatGuest = {
      id: `gst-${randomBytes(6).toString('hex')}`,
      chatId: invite.chatId,
      name: guestName(name),
      access: invite.access,
      joinedAt: new Date(this._now()).toISOString(),
    }
    this._guests.set(hash(token), guest)
    return { guest, token }
  }

  /** The guest a token belongs to, while they are still in. */
  find(token: string | undefined): ChatGuest | undefined {
    return token ? this._guests.get(hash(token)) : undefined
  }

  /** Who is in a chat, in the order they joined. */
  guests(chatId: string): ChatGuest[] {
    return [...this._guests.values()].filter((g) => g.chatId === chatId)
  }

  /** Takes one guest out (removed by the person, or leaving); the guest who was removed, if any. */
  remove(chatId: string, id: string): ChatGuest | undefined {
    for (const [key, guest] of this._guests)
      if (guest.id === id && guest.chatId === chatId) {
        this._guests.delete(key)
        return guest
      }
    return undefined
  }

  /** Stops sharing a chat: every invite withdrawn, every guest out. The guests who were in. */
  stop(chatId: string): ChatGuest[] {
    for (const [code, invite] of this._invites) if (invite.chatId === chatId) this._invites.delete(code)
    const out = this.guests(chatId)
    for (const [key, guest] of this._guests) if (guest.chatId === chatId) this._guests.delete(key)
    return out
  }

  private _prune() {
    const now = this._now()
    for (const [code, invite] of this._invites)
      if (Date.parse(invite.expiresAt) <= now) this._invites.delete(code)
  }
}

/** What a guest's message says to the agents: who wrote it, marked as not the person. */
export const guestMessage = (name: string, text: string) => prompts.share.guest(name, text)

/**
 * The chat as a guest sees it in the list: its title, whether it works or waits, and its rounds' requests. Not its
 * project, crew, permissions, folders or where the person filed it.
 */
export function guestSummary(chat: ChatSummary) {
  return {
    chatId: chat.chatId,
    title: chat.title,
    updatedAt: chat.updatedAt,
    status: chat.status,
    ...(chat.awaiting ? { awaiting: true } : {}),
    ...(chat.approving ? { approving: true } : {}),
    ...(chat.failed ? { failed: true } : {}),
    rounds: chat.rounds.map((r) => ({
      colonyId: r.colonyId,
      round: r.round,
      status: r.status,
      request: r.request,
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    })),
  }
}

type Created = EventPayloads['colony/created']

/**
 * A round's log as a guest receives it: the conversation and whether the round runs, nothing else. What agents ran and
 * read, files, approvals, the person's memory and project, a round's history and a voice call's transcript stay
 * with the person; the events kept are pared to what the chat shows.
 */
export function guestEvents(events: readonly MyrEvent[]): MyrEvent[] {
  const out: MyrEvent[] = []
  for (const e of events) {
    const payload = guestPayload(e)
    if (payload !== undefined) out.push({ ...e, payload })
  }
  return out
}

function guestPayload(e: MyrEvent): unknown {
  switch (e.type) {
    case 'colony/created':
    case 'round/started': {
      const p = e.payload as Created
      const shown: Created = {
        name: p.name,
        mission: p.chat?.request ?? '',
        pattern: p.pattern,
        agents: [],
        acceptance: [],
        budget: { wallMs: p.budget?.wallMs ?? 0 },
        unsafeNoSandbox: false,
        ...(p.tier ? { tier: p.tier } : {}),
        ...(p.askAll ? { askAll: true } : {}),
        ...(p.chat ? { chat: { chatId: p.chat.chatId, round: p.chat.round, request: p.chat.request } } : {}),
      }
      return shown
    }
    case 'colony/started':
      return {}
    case 'colony/stopped':
    case 'colony/failed':
    case 'colony/completed':
    case 'chat/renamed':
    case 'chat/reply':
      return e.payload
    case 'chat/user': {
      const p = e.payload as EventPayloads['chat/user']
      return {
        text: p.text,
        ...(p.mode ? { mode: p.mode } : {}),
        ...(p.to?.length ? { to: p.to } : {}),
        ...(p.voice ? { voice: true } : {}),
        ...(p.answers ? { answers: p.answers } : {}),
      }
    }
    default:
      return undefined
  }
}
