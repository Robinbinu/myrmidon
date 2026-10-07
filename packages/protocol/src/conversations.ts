import type { ColonyState } from './colony-state.ts'

/**
 * The crew's conversations, as people have them at work: one-to-one chats, group chats, and one team chat everyone is
 * in. Nothing here depends on how the crew is organised (a lead and workers, a swarm of peers, or an organisation that
 * hires and lets people go): the team is whoever is on the crew now, and a group is its members minus anyone who has
 * left the crew.
 */

/** The team chat's name; no group or agent may take it. */
export const TEAM_CHAT = 'team'

export type ConversationKind = 'direct' | 'group' | 'team'

export interface Conversation {
  /** `team`, `group:<name>`, or `direct:<a>+<b>` with the two names sorted. */
  readonly id: string
  readonly kind: ConversationKind
  /** The team chat's name, the group's name, or (one-to-one) the other person. */
  readonly name: string
  readonly members: readonly string[]
}

export interface ConversationLine {
  readonly id: string
  readonly seq: number
  readonly time: string
  readonly from: string
  readonly text: string
  readonly replyTo?: number
  /** Who the line @mentions (team and group chats). */
  readonly mentions: readonly string[]
  /** A message to someone (not the team chat): whether it has been read. */
  readonly read?: boolean
}

/** A group name: lowercase words joined by dashes, so it reads well after an @ and in a list. */
export const GROUP_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/

/** Everyone on the crew right now: agents that have joined and not been let go. */
export function crewOf(state: ColonyState): string[] {
  return Object.values(state.agents)
    .filter((a) => !a.dismissed)
    .map((a) => a.info.name)
}

/** A group's members who are still on the crew. */
export function groupMembers(state: ColonyState, name: string): string[] {
  const crew = new Set(crewOf(state))
  return (state.groups[name]?.members ?? []).filter((m) => crew.has(m))
}

export const directId = (a: string, b: string) => `direct:${[a, b].sort().join('+')}`

/** Who a message is to, read as a conversation: the team chat, a group, or a one-to-one chat. */
export function resolveConversation(state: ColonyState, from: string, to: string): Conversation {
  if (to === TEAM_CHAT) return { id: TEAM_CHAT, kind: 'team', name: TEAM_CHAT, members: crewOf(state) }
  if (state.groups[to])
    return { id: `group:${to}`, kind: 'group', name: to, members: groupMembers(state, to) }
  return { id: directId(from, to), kind: 'direct', name: to, members: [from, to] }
}

const MENTION = /@([a-z][\w-]*)/gi

export function mentionsIn(text: string, among: readonly string[]): string[] {
  const known = new Set(among)
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1] as string))].filter((m) => known.has(m))
}

/** Every line of one conversation, oldest first. */
export function linesOf(state: ColonyState, conversationId: string): ConversationLine[] {
  if (conversationId === TEAM_CHAT)
    return state.board.map((p) => ({
      id: p.id,
      seq: p.seq,
      time: p.time,
      from: p.agent,
      text: p.text,
      mentions: p.mentions,
      ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
    }))
  const group = conversationId.startsWith('group:') ? conversationId.slice(6) : undefined
  return state.mail
    .filter((m) =>
      group ? m.members && m.to === group : !m.members && directId(m.from, m.to) === conversationId,
    )
    .map((m) => ({
      id: m.id,
      seq: m.seq,
      time: m.time,
      from: m.from,
      read: m.delivered,
      text: m.subject && !m.subject.startsWith('Re: ') ? `[${m.subject}] ${m.body}` : m.body,
      mentions: group ? mentionsIn(m.body, m.members ?? []) : [],
      ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
    }))
}

/**
 * The conversations someone is in (everyone's when `agent` is left out): the team chat, their groups, and every
 * one-to-one chat that has a message, most recently active first after the team chat.
 */
export function conversationsOf(state: ColonyState, agent?: string): Conversation[] {
  const groups = Object.values(state.groups)
    .filter((g) => !agent || groupMembers(state, g.name).includes(agent))
    .map(
      (g): Conversation => ({
        id: `group:${g.name}`,
        kind: 'group',
        name: g.name,
        members: groupMembers(state, g.name),
      }),
    )
  const direct = new Map<string, Conversation>()
  for (const m of state.mail) {
    if (m.members || (agent && m.from !== agent && m.to !== agent)) continue
    const id = directId(m.from, m.to)
    const other = agent ? (m.from === agent ? m.to : m.from) : `${[m.from, m.to].sort().join(' & ')}`
    direct.set(id, { id, kind: 'direct', name: other, members: [m.from, m.to] })
  }
  const last = (c: Conversation) => linesOf(state, c.id).at(-1)?.seq ?? 0
  return [
    { id: TEAM_CHAT, kind: 'team', name: TEAM_CHAT, members: crewOf(state) },
    ...[...groups, ...direct.values()].sort((a, b) => last(b) - last(a)),
  ]
}

const ASK =
  /\?|\b(please|pls|can you|could you|would you|will you|need you to|let me know|tell me|send me|get back to me)\b/i
const CLOSER =
  /^\s*(ok(ay)?|thanks?( you)?|thx|got it|noted|👍|✔|done|great|cool|perfect|sounds good)\b[\s.!]*$/i

/**
 * Whether a message asks the reader for something (a question or a request) and so deserves an answer. Acks, FYIs and
 * thanks do not: they close a thread instead of opening one.
 */
export function asksSomething(text: string): boolean {
  return !CLOSER.test(text) && ASK.test(text)
}
