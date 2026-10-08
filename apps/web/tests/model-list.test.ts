import { expect, test } from 'bun:test'
import type { ModelOption } from '../src/client/api.ts'
import { withoutDatedAliases } from '../src/client/chat/model-list.ts'

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
