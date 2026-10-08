import { expect, test } from 'bun:test'
import { answerText, typesOwn } from '../src/client/chat/QuestionCard.tsx'

test('options that mean "I will type it" hand over to the text box', () => {
  expect(typesOwn({ label: "Adjust the plan — I'll type what to change" })).toBe(true)
  expect(typesOwn({ label: 'Adjust the plan — I’ll type what to change' })).toBe(true)
  expect(typesOwn({ label: 'Let me type my own' })).toBe(true)
  expect(typesOwn({ label: 'Other' })).toBe(true)
  expect(typesOwn({ label: 'Other…' })).toBe(true)
  expect(typesOwn({ label: 'Something else' })).toBe(true)
  expect(typesOwn({ label: 'Approve', description: 'Go ahead with this plan' })).toBe(false)
  expect(typesOwn({ label: 'Another color scheme' })).toBe(false)
})

test('ordinary options that describe what the agent will write stay answers', () => {
  expect(typesOwn({ label: 'Summary', description: "I'll write a one-page summary" })).toBe(false)
  expect(typesOwn({ label: 'Tradeoffs', description: 'Let me explain the tradeoffs first' })).toBe(false)
  expect(typesOwn({ label: 'Tests', description: "I'll add unit tests for each module" })).toBe(false)
  expect(typesOwn({ label: 'Walkthrough', description: 'I will describe each step' })).toBe(false)
  expect(typesOwn({ label: "I'll write a one-page summary" })).toBe(false)
  expect(typesOwn({ label: 'Other frameworks (Vue, Svelte)' })).toBe(false)
})

test('a typed answer is sent with the option that asked for it', () => {
  const choices = [
    { question: 'OK to proceed?', options: [{ label: 'Approve' }, { label: "Adjust — I'll type it" }] },
  ]
  expect(
    answerText(choices, [{ picked: ["Adjust — I'll type it"], other: 'build auth first', skipped: false }]),
  ).toBe("OK to proceed? → Adjust — I'll type it, build auth first")
})
