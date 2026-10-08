import type { ModelOption } from '../api.ts'

/** A provider's dated snapshot id: claude-haiku-4-5-20251001, or claude-haiku-4-5@20251001 on Vertex. */
const DATED = /[-@]\d{8}$/

/**
 * The models to offer, without a provider's dated snapshot of a model it also lists by its alias
 * (claude-haiku-4-5-20251001 beside claude-haiku-4-5): the two are one model under two ids, and the list showed it
 * twice under the same name. A snapshot stays when no alias is listed, or when it is the model chosen.
 */
export function withoutDatedAliases(models: readonly ModelOption[], chosen?: string): ModelOption[] {
  const ids = new Set(models.map((m) => `${m.provider}\n${m.id}`))
  return models.filter(
    (m) => m.ref === chosen || !DATED.test(m.id) || !ids.has(`${m.provider}\n${m.id.replace(DATED, '')}`),
  )
}
