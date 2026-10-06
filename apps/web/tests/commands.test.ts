import { expect, test } from 'bun:test'
import { matchSlash, parseSlash } from '../src/client/chat/commands.ts'

test('slash commands parse, complete, and leave ordinary text alone', () => {
  expect(parseSlash('/plan build a landing page')).toMatchObject({
    command: { name: 'plan' },
    arg: 'build a landing page',
  })
  expect(parseSlash('/stop')).toMatchObject({ command: { name: 'stop' }, arg: '' })
  expect(parseSlash('/usr/bin is a path')).toBeUndefined()
  expect(parseSlash('hello /stop')).toBeUndefined()
  expect(matchSlash('/st').map((c) => c.name)).toEqual(['steer', 'stop'])
  expect(matchSlash('/').length).toBeGreaterThan(10)
  expect(matchSlash('/plan now')).toEqual([])
})
