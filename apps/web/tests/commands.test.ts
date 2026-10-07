import { expect, test } from 'bun:test'
import {
  parseSlash,
  rankCommands,
  rankOptions,
  SLASH_COMMANDS,
  slashStage,
  unavailable,
} from '../src/client/chat/commands.ts'

const idle = { running: false, chat: true, resumable: false }
const running = { running: true, chat: true, resumable: false }

test('slash commands parse and leave ordinary text alone', () => {
  expect(parseSlash('/plan build a landing page')).toMatchObject({
    command: { name: 'plan' },
    arg: 'build a landing page',
  })
  expect(parseSlash('/stop')).toMatchObject({ command: { name: 'stop' }, arg: '' })
  expect(parseSlash('/usr/bin is a path')).toBeUndefined()
  expect(parseSlash('hello /stop')).toBeUndefined()
})

test('the menu knows whether a name or an argument is being typed', () => {
  expect(slashStage('/mo')).toEqual({ stage: 'name', query: 'mo' })
  expect(slashStage('/model cla')).toMatchObject({ stage: 'arg', command: { name: 'model' }, query: 'cla' })
  // Commands without an argument have no argument stage; ordinary text has no stage at all.
  expect(slashStage('/stop now')).toBeUndefined()
  expect(slashStage('hello')).toBeUndefined()
})

test('commands rank by prefix, then letters in order, and the ones that cannot run sink', () => {
  expect(
    rankCommands('st', running)
      .map((r) => r.command.name)
      .slice(0, 2),
  ).toEqual(['steer', 'stop'])
  const idleStop = rankCommands('st', idle)
  expect(idleStop.find((r) => r.command.name === 'stop')?.unavailable).toBe('Nothing is running')
  expect(idleStop.at(-1)?.unavailable).toBeDefined()
  // "thk" finds thinking by its letters, and the matched letters are reported for highlighting.
  expect(rankCommands('thk', idle)[0]).toMatchObject({ command: { name: 'thinking' }, matches: [0, 1, 4] })
  expect(rankCommands('', idle)).toHaveLength(SLASH_COMMANDS.length)
})

test('availability follows the chat', () => {
  const resume = SLASH_COMMANDS.find((c) => c.name === 'resume')
  if (!resume) throw new Error('missing /resume')
  expect(unavailable(resume, { running: false, chat: true, resumable: true })).toBeUndefined()
  expect(unavailable(resume, idle)).toBe('No stopped round to resume')
})

test('argument choices match labels, values and descriptions', () => {
  const models = [
    { value: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', description: 'anthropic' },
    { value: 'ark/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'ark' },
  ]
  expect(rankOptions('', models)).toHaveLength(2)
  expect(rankOptions('deep', models).map((o) => o.label)).toEqual(['DeepSeek V4 Pro'])
  expect(rankOptions('cop', models).map((o) => o.label)).toEqual(['Claude Opus 5.5'])
  expect(rankOptions('anthropic', models)[0]?.label).toBe('Claude Opus 5.5')
  expect(rankOptions('zzz', models)).toEqual([])
  // A provider prefix in the value never outranks a word of the label.
  const mixed = [
    { value: 'openai-codex/gpt-6', label: 'GPT-6', description: 'openai-codex' },
    { value: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', description: 'anthropic' },
  ]
  expect(rankOptions('op', mixed)[0]?.label).toBe('Claude Opus 5.5')
})
