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

/**
 * The model to offer in place of one that failed: another the chat's crew runs on (it has answered here), else the
 * failed model's provider's next one. Undefined rather than whichever model happens to be listed first.
 */
export function fallbackModel(
  failed: string,
  models: readonly ModelOption[],
  fits: (m: ModelOption) => boolean,
  used: readonly string[],
): ModelOption | undefined {
  const ok = (m: ModelOption | undefined): m is ModelOption => !!m && m.ref !== failed && fits(m)
  const crew = used.map((ref) => models.find((m) => m.ref === ref)).find(ok)
  if (crew) return crew
  const provider = models.find((m) => m.ref === failed)?.provider ?? failed.split('/')[0]
  const siblings = models.filter((m) => m.provider === provider)
  const at = siblings.findIndex((m) => m.ref === failed)
  return [...siblings.slice(at + 1), ...siblings.slice(0, Math.max(at, 0))].find(ok)
}
