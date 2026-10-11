import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'

// Groq answers a model it retired with 400 `model_decommissioned`, and omp's catalog still lists several. With
// patches/@oh-my-pi%2Fpi-catalog@*.patch, Groq's live /models list replaces the bundled one once signed in, keeping
// only its chat models (not Whisper, Orpheus or Prompt Guard). A patch is pinned to one omp version, so an upgrade that
// leaves it behind fails here first. omp's registry turns its network off under `bun test`, so this loads the
// installed discovery module itself and hands it Groq's live answer.
test("Groq's live chat models replace the bundled list; speech, transcription and classifiers stay out", async () => {
  const catalog = dirname(require.resolve('@oh-my-pi/pi-catalog/package.json'))
  const { groqModelManagerOptions } = await import(join(catalog, 'src/provider-models/openai-compat.ts'))
  // Groq's /models on 2026-10-11, trimmed to the fields that tell the models apart.
  const live = [
    { id: 'openai/gpt-oss-120b', output_modalities: ['text'], supported_features: ['tools', 'reasoning'] },
    { id: 'openai/gpt-oss-20b', output_modalities: ['text'], supported_features: ['tools', 'reasoning'] },
    {
      id: 'openai/gpt-oss-safeguard-20b',
      output_modalities: ['text'],
      supported_features: ['tools', 'reasoning'],
    },
    { id: 'qwen/qwen3.8-27b', output_modalities: ['text'], supported_features: ['tools', 'reasoning'] },
    { id: 'allam-2-7b', output_modalities: ['text'], supported_features: ['json_mode'] },
    { id: 'meta-llama/llama-prompt-guard-2-22m', output_modalities: ['text'] },
    {
      id: 'meta-llama/llama-prompt-guard-2-86m',
      output_modalities: ['text'],
      supported_features: ['json_mode'],
    },
    { id: 'canopylabs/orpheus-v1-english', output_modalities: ['speech'] },
    { id: 'whisper-large-v3-turbo', output_modalities: ['transcription'] },
  ]
  const options = groqModelManagerOptions({
    apiKey: 'gsk-test',
    fetch: async () => Response.json({ object: 'list', data: live.map((m) => ({ ...m, object: 'model' })) }),
  })
  expect(options.dynamicModelsAuthoritative).toBe(true)
  const found = (await options.fetchDynamicModels()) as { models?: { id: string }[] } | { id: string }[]
  const ids = (Array.isArray(found) ? found : (found.models ?? [])).map((m) => m.id).sort()
  expect(ids).toEqual([
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-safeguard-20b',
    'qwen/qwen3.8-27b',
  ])
})
