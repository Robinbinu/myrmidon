import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Groq answers a model it retired with 400 `model_decommissioned`, and omp's catalog still lists several. With
// patches/@oh-my-pi%2Fpi-catalog@*.patch, Groq's live /models list replaces the bundled one once signed in, so retired
// models are no longer offered. omp's model registry turns its network off under `bun test`, so this reads the
// installed source: a patch is pinned to one omp version, and an upgrade that leaves it behind fails here first.
test("Groq's live model list replaces the bundled one", () => {
  const catalog = dirname(require.resolve('@oh-my-pi/pi-catalog/package.json'))
  const source = readFileSync(join(catalog, 'src/provider-models/openai-compat.ts'), 'utf8')
  const groq = /export function groqModelManagerOptions[\s\S]*?\n}\n/.exec(source)?.[0] ?? ''
  expect(groq).toContain('dynamicModelsAuthoritative: true')
})
