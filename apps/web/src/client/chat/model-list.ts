import type { ModelOption, TeamConfig } from '../api.ts'

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
 * Display names the registries spell differently for one family, rewritten to the newest pattern. Applied to the name
 * without its trailing `(region)` or `(effort)`, which stays as it is.
 */
const NAME_RULES: readonly [RegExp, (...m: string[]) => string][] = [
  // Bedrock's "AU Anthropic Claude Opus 4.6": the region goes last, in brackets, as on its other regional models.
  [
    /^(?:([A-Z]{2,}) )?Anthropic (Claude\b.*)$/,
    (_, region, rest = '') => (region ? `${rest} (${region})` : rest),
  ],
  // Anthropic's names before Claude 4.5 put the version first: "Claude 4.1 Opus", "Claude 3.5 Sonnet v2".
  [/^Claude (\d+(?:\.\d+)?) ([A-Z][a-z]+)\b/, (_, version, family) => `Claude ${family} ${version}`],
  // "GPT-5.6-Luna" beside "GPT-5.6 Luna".
  [/^GPT-(\d+(?:\.\d+)?)-([A-Za-z])/, (_, version, tier) => `GPT-${version} ${tier}`],
  // OpenAI's open-weight models go by their ids: "GPT OSS Safeguard 20B" and "GPT-OSS 120B" beside "gpt-oss-120b".
  [
    /^gpt[- ]oss\b(.*)$/i,
    (_, rest = '') => {
      const tail = rest.trim().replace(/^-/, '').toLowerCase().replace(/\s+/g, '-')
      return tail ? `gpt-oss-${tail}` : 'gpt-oss'
    },
  ],
  // "DeepSeek V3.2" beside "DeepSeek-V3.1".
  [/^DeepSeek ([VR]\d)/, (_, version) => `DeepSeek-${version}`],
]

/** A model's display name in one pattern per family ("Claude 4 Opus" shows as "Claude Opus 4"); ids never change. */
export function modelName(name: string): string {
  const [, base = name, suffix = ''] = /^(.*?)((?: \([^()]*\))*)$/.exec(name) ?? []
  return NAME_RULES.reduce((out, [pattern, rewrite]) => out.replace(pattern, rewrite), base) + suffix
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

/** Who uses a model by default, as Settings → Models names them before it is removed. */
export type ModelUser = 'lead' | 'crewmates' | 'reviewer' | 'call'

/** The defaults that use `ref`: this window's crew (the composer's) and the saved ones a channel or call gets. */
export function usersOf(
  ref: string,
  config: TeamConfig | undefined,
  saved: {
    team: { leadModel?: string; workerModel?: string; judgeModel?: string }
    voice: { callModel?: string }
  },
): ModelUser[] {
  const users: ModelUser[] = []
  if (config?.leadModel === ref || saved.team.leadModel === ref) users.push('lead')
  if (config?.roster.some((r) => r.model === ref) || saved.team.workerModel === ref) users.push('crewmates')
  if (config?.judgeModel === ref || saved.team.judgeModel === ref) users.push('reviewer')
  if (saved.voice.callModel === ref) users.push('call')
  return users
}

/** This window's crew without a removed model: `lead` takes over from it, and crewmates and the reviewer follow. */
export function withoutModel(config: TeamConfig, ref: string, lead: string): TeamConfig {
  const leadModel = config.leadModel === ref ? lead : config.leadModel
  return {
    ...config,
    leadModel,
    roster: config.roster.map((r) => (r.model === ref ? { ...r, model: leadModel } : r)),
    judgeModel: config.judgeModel === ref ? leadModel : config.judgeModel,
  }
}
