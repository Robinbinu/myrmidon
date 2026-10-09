import { expect, test } from 'bun:test'
import { foldColony, type MyrEvent } from '@myrmidon/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { copy } from '../src/client/copy.ts'

/**
 * RoundView.tsx reaches the API module, which reads the page's address when it loads. Bun runs every test file in one
 * process, so the stand-ins are put back as soon as it has loaded.
 */
async function roundView() {
  const g = globalThis as Record<string, unknown>
  const before = { location: g.location, window: g.window }
  g.location ??= { hash: '', pathname: '/', protocol: 'http:', host: 'localhost' }
  g.window ??= globalThis
  try {
    return await import('../src/client/chat/RoundView.tsx')
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete g[key]
      else g[key] = value
    }
  }
}

let seq = 0
const event = (type: string, payload: unknown, kind = 'system'): MyrEvent =>
  ({
    colonyId: 'c',
    seq: ++seq,
    id: `e${seq}`,
    time: new Date(seq * 1000).toISOString(),
    type,
    actor: { kind, id: kind === 'user' ? 'user' : 'test' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

test('messages said on a call are marked in the chat, the opening one and those sent mid-round alike', async () => {
  const { UserMessage } = await roundView()
  const state = foldColony('c', [
    event('chat/user', { text: 'how is the build going', voice: true }, 'user'),
    event('chat/reply', { agent: 'lead', text: 'Two tests left.', final: false }),
    event('chat/user', { text: 'typed this one', mode: 'steer' }, 'user'),
    event('chat/user', { text: 'and the docs?', mode: 'steer', voice: true }, 'user'),
  ])
  const users = state.chatMessages.filter((m) => m.from === 'user')
  expect(users.map((m) => [m.text, m.voice === true])).toEqual([
    ['how is the build going', true],
    ['typed this one', false],
    ['and the docs?', true],
  ])
  // RoundView hands each user message's flag to UserMessage as `voice`.
  const html = users.map((m) => renderToStaticMarkup(<UserMessage text={m.text} voice={m.voice} />))
  expect(html.map((h) => h.includes(copy.round.message.saidOnCall))).toEqual([true, false, true])
})
