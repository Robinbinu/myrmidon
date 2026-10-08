import { expect, test } from 'bun:test'
import {
  allCommands,
  menuSections,
  parseSlash,
  rankCommands,
  rankOptions,
  SLASH_COMMANDS,
  setPluginCommands,
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

test('a command typed in full wins over a longer one it prefixes', () => {
  // "/mode" + Enter runs the highlighted (first) command; it must not be /model.
  expect(rankCommands('mode', idle)[0]?.command.name).toBe('mode')
  expect(rankCommands('mod', idle)[0]?.command.name).toBe('model')
  // An exact name stays first even when it can't run now, so Enter shows why instead of running another command.
  expect(rankCommands('stop', idle)[0]?.command.name).toBe('stop')
})

test('the full menu lists each command once, recent first and the ones that cannot run last', () => {
  const fresh = { running: false, chat: false, resumable: false }
  const sections = menuSections(fresh, ['plan', 'stop'])
  const names = sections.flatMap((s) => s.commands.map((c) => c.name))
  expect(names).toHaveLength(SLASH_COMMANDS.length)
  expect(new Set(names).size).toBe(names.length)
  // /stop can't run on a new task, so it is not offered as recent; /plan is, and only there.
  expect(sections[0]).toMatchObject({ section: 'recent', commands: [{ name: 'plan' }] })
  const last = sections.at(-1)
  expect(last?.section).toBe('unavailable')
  expect(last?.commands.every((c) => unavailable(c, fresh))).toBe(true)
  expect(sections.slice(0, -1).every((s) => s.commands.every((c) => !unavailable(c, fresh)))).toBe(true)
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

test("plugins' commands join the menu, take their arguments, and never shadow a built-in command", () => {
  setPluginCommands([
    {
      name: 'review-ui',
      plugin: 'nova-kit',
      description: 'Review a screen',
      argumentHint: '<file>',
      prompt: 'Review $1',
    },
    { name: 'plan', plugin: 'nova-kit', description: 'A plugin trying to take /plan', prompt: 'nope' },
  ])
  expect(parseSlash('/review-ui home.tsx')).toMatchObject({
    command: { name: 'review-ui', group: 'Plugins', prompt: 'Review $1', needsArg: true },
    arg: 'home.tsx',
  })
  expect(slashStage('/review-ui ho')).toMatchObject({ stage: 'arg', query: 'ho' })
  expect(rankCommands('rev', { chat: false, running: false, resumable: false })[0]?.command.name).toBe(
    'review-ui',
  )
  expect(allCommands().filter((c) => c.name === 'plan')).toHaveLength(1)
  expect(parseSlash('/plan a site')?.command.prompt).toBeUndefined()
  setPluginCommands([])
  expect(parseSlash('/review-ui x')).toBeUndefined()
})
