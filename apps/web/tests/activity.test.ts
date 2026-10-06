import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { activityOf } from '../src/client/chat/activity.ts'

let seq = 0
const ev = (type: string, payload: object) =>
  ({
    id: `e${++seq}`,
    seq,
    type,
    time: `2026-10-06T12:00:0${seq % 10}Z`,
    actor: { kind: 'agent', id: 'x' },
    payload,
  }) as unknown as MyrEvent

test("an agent's computer shows its browser, terminal, and editor activity in order", () => {
  const events = [
    ev('tool/call', {
      agent: 'wren',
      callId: 'c1',
      tool: 'fs_write',
      args: { path: 'a.py', content: 'print(1)' },
    }),
    ev('tool/call', { agent: 'wren', callId: 'c2', tool: 'shell', args: { command: 'python a.py' } }),
    ev('tool/result', { agent: 'wren', callId: 'c2', tool: 'shell', ok: true, output: '1' }),
    ev('tool/call', {
      agent: 'wren',
      callId: 'c3',
      tool: 'fs_edit',
      args: { path: 'a.py', old: '1', new: '2' },
    }),
    ev('tool/call', { agent: 'juno', callId: 'c1', tool: 'browser_open', args: { url: 'https://x.dev' } }),
  ]
  const a = activityOf(events)
  expect(a.get('wren')?.map((x) => x.kind)).toEqual(['editor', 'terminal', 'editor'])
  expect(a.get('wren')?.[1]).toMatchObject({ command: 'python a.py', output: '1', ok: true })
  expect(a.get('wren')?.[2]).toMatchObject({ path: 'a.py', edit: { old: '1', new: '2' } })
  expect(a.get('juno')?.map((x) => x.kind)).toEqual(['browser'])
})
