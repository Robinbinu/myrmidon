import { expect, test } from 'bun:test'
import type { ChatSummary } from '../src/client/api.ts'
import { chatFamily, type FamilyNode, familySize } from '../src/client/chat/family.ts'

/** A chat whose runs started at the given minutes past noon. */
function chat(
  chatId: string,
  starts: number[],
  place: { forkOf?: string; importOf?: string } = {},
): ChatSummary {
  return {
    chatId,
    title: chatId,
    updatedAt: '2026-10-10T13:00:00.000Z',
    status: 'completed',
    rounds: starts.map((minute, i) => ({
      colonyId: `colony-${chatId}`,
      round: i + 1,
      status: 'completed',
      request: `ask ${i + 1}`,
      swarm: false,
      startedAt: `2026-10-10T12:${String(minute).padStart(2, '0')}:00.000Z`,
    })),
    ...place,
  }
}

/** The tree as `id@forkedAfter[children]`, to compare whole shapes at once. */
const shape = (node: FamilyNode): string =>
  `${node.chat ? node.chatId : `(${node.chatId})`}${node.forkedAfter ? `@${node.forkedAfter}` : ''}${
    node.children.length ? `[${node.children.map(shape).join(' ')}]` : ''
  }`

const chats = [
  chat('chat-a', [0, 10, 20]),
  // Forked from a while it had two runs, then a fork of the fork.
  chat('chat-b', [15, 30], { forkOf: 'chat-a' }),
  chat('chat-c', [35], { forkOf: 'chat-b' }),
  // A second fork of a, after all three of its runs.
  chat('chat-d', [25], { forkOf: 'chat-a' }),
  chat('chat-lone', [5]),
]

test('a fork chain is one tree from its oldest chat, each fork after the run it continued', () => {
  const tree = chatFamily(chats, 'chat-c')
  expect(tree && shape(tree)).toBe('chat-a[chat-b@2[chat-c@2] chat-d@3]')
  // Every member of the family draws the same tree.
  expect(chatFamily(chats, 'chat-a')).toEqual(tree)
  expect(chatFamily(chats, 'chat-d')).toEqual(tree)
  expect(tree && familySize(tree)).toBe(4)
})

test('a chat with no forks is a family of one, and a chat not in the list has none', () => {
  const lone = chatFamily(chats, 'chat-lone')
  expect(lone && shape(lone)).toBe('chat-lone')
  expect(lone && familySize(lone)).toBe(1)
  expect(chatFamily(chats, 'chat-nope')).toBeUndefined()
})

test('forks of a deleted chat stay together under it', () => {
  const list = [chat('chat-x', [0], { forkOf: 'chat-gone' }), chat('chat-y', [5], { forkOf: 'chat-gone' })]
  const tree = chatFamily(list, 'chat-y')
  expect(tree && shape(tree)).toBe('(chat-gone)[chat-x chat-y]')
  expect(tree?.chat).toBeUndefined()
  expect(tree && familySize(tree)).toBe(2)
})

test('an imported chat roots its family and keeps where it came from', () => {
  const list = [chat('chat-i', [0, 10], { importOf: 'import-1' }), chat('chat-j', [12], { forkOf: 'chat-i' })]
  const tree = chatFamily(list, 'chat-j')
  expect(tree && shape(tree)).toBe('chat-i[chat-j@2]')
  expect(tree?.chat?.importOf).toBe('import-1')
})

test('a loop of forks (a hand-edited shelf) ends instead of climbing forever', () => {
  const list = [chat('chat-p', [0], { forkOf: 'chat-q' }), chat('chat-q', [5], { forkOf: 'chat-p' })]
  const tree = chatFamily(list, 'chat-p')
  expect(tree && familySize(tree)).toBe(2)
})
