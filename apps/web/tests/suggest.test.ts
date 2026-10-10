import { expect, test } from 'bun:test'
import { buildSuggester, nextWord } from '../src/client/chat/suggest.ts'

const said = [
  'Fix the failing tests in the auth module',
  'Summarize what changed in this repo since yesterday',
  'run the tests and fix what fails',
  'run the tests again',
  'write a short poem about ants',
]

test('what you typed before is offered back, most recent first, as shells do with history', () => {
  const s = buildSuggester(said, [])
  expect(s.suggest('Summ')).toBe('arize what changed in this repo since yesterday')
  // Case is the person's own; the match ignores it.
  expect(s.suggest('fix the f')).toBe('ailing tests in the auth module')
  // The most recent of two matches wins.
  expect(s.suggest('run the tests ')).toBe('and fix what fails')
})

test('otherwise the next word comes from what usually follows the last two words', () => {
  const s = buildSuggester(['please run the tests', 'then run the tests', 'run the build'], [])
  // "run the" is followed by "tests" twice and "build" once.
  expect(s.suggest('Could you run the ')).toBe('tests')
})

test('a half-typed word is finished from the words the person uses', () => {
  const s = buildSuggester(['refactor the dashboard', 'the dashboard is slow', 'deploy the dashboard'], [])
  expect(s.suggest('make the dash')).toBe('board')
})

test('nothing is suggested when there is too little to go on', () => {
  const s = buildSuggester(said, [])
  expect(s.suggest('')).toBeUndefined()
  // One letter is not enough to finish a word.
  expect(s.suggest('w')).toBeUndefined()
  // A pair seen once is too weak to predict from.
  expect(s.suggest('ants are ')).toBeUndefined()
  // A slash command belongs to its own menu.
  expect(s.suggest('/mod')).toBeUndefined()
  // A finished message is not repeated.
  expect(s.suggest('run the tests again')).toBeUndefined()
})

test('the built-in phrases suggest on the first day, before there is any history', () => {
  const s = buildSuggester([], ['can you help me with', 'can you help me with', 'can you explain'])
  expect(s.suggest('can you ')).toBe('help')
})

test('messages sent now are learned at once', () => {
  const s = buildSuggester([], [])
  expect(s.suggest('deploy to st')).toBeUndefined()
  s.learn('deploy to staging please')
  expect(s.suggest('deploy to st')).toBe('aging please')
})

test('Tab takes one word of a suggestion at a time, with the space after it', () => {
  expect(nextWord('arize what changed')).toBe('arize ')
  expect(nextWord(' what changed')).toBe(' what ')
  expect(nextWord('tests')).toBe('tests ')
})
