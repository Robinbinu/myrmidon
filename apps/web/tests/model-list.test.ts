import { expect, test } from 'bun:test'
import type { ModelOption } from '../src/client/api.ts'
import { fallbackModel, withoutDatedAliases } from '../src/client/chat/model-list.ts'

const model = (provider: string, id: string, name: string): ModelOption => ({
  ref: `${provider}/${id}`,
  provider,
  id,
  name,
  reasoning: false,
})

test("a provider's dated snapshot of a listed alias is offered once, under the alias", () => {
  const models = [
    model('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5'),
    model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5'),
    model('vertex', 'claude-haiku-4-5', 'Claude Haiku 4.5'),
    model('vertex', 'claude-haiku-4-5@20251001', 'Claude Haiku 4.5'),
    // A snapshot with no alias beside it is the only way to reach that model, so it stays.
    model('anthropic', 'claude-3-opus-20240229', 'Claude 3 Opus'),
    // Another provider's alias does not hide this provider's snapshot.
    model('bedrock', 'claude-opus-4-5-20251101', 'Claude Opus 4.5'),
  ]
  expect(withoutDatedAliases(models).map((m) => m.ref)).toEqual([
    'anthropic/claude-haiku-4-5',
    'vertex/claude-haiku-4-5',
    'anthropic/claude-3-opus-20240229',
    'bedrock/claude-opus-4-5-20251101',
  ])
  // The model already chosen is always listed, so the picker can show it as current.
  expect(withoutDatedAliases(models, 'anthropic/claude-haiku-4-5-20251001').map((m) => m.ref)).toContain(
    'anthropic/claude-haiku-4-5-20251001',
  )
})

test('a failed model is replaced by one the crew already uses, else the same provider’s next, never the first listed', () => {
  const models = [
    model('anthropic', 'claude-4-opus', 'Claude 4 Opus'),
    model('openai', 'gpt-5', 'GPT-5'),
    model('openai', 'gpt-5-mini', 'GPT-5 mini'),
    model('google', 'gemini-3-pro', 'Gemini 3 Pro'),
    model('openai', 'gpt-5-nano', 'GPT-5 nano'),
  ]
  const any = () => true
  // Another model this chat's crew runs on has answered here already.
  expect(fallbackModel('openai/gpt-5', models, any, ['openai/gpt-5', 'google/gemini-3-pro'])?.ref).toBe(
    'google/gemini-3-pro',
  )
  // Otherwise the failed model's provider's next one, wrapping round its list.
  expect(fallbackModel('openai/gpt-5', models, any, ['openai/gpt-5'])?.ref).toBe('openai/gpt-5-mini')
  expect(fallbackModel('openai/gpt-5-nano', models, any, [])?.ref).toBe('openai/gpt-5')
  // A provider with nothing else offers nothing, rather than whatever comes first.
  expect(fallbackModel('google/gemini-3-pro', models, any, [])).toBeUndefined()
  // Only models that fit count.
  expect(fallbackModel('openai/gpt-5', models, (m) => m.id !== 'gpt-5-mini', [])?.ref).toBe(
    'openai/gpt-5-nano',
  )
})
