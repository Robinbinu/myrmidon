import type { CompanyBody } from '@myrmidon/protocol'
import { type CompanyProblem, parseCompany } from './companies.ts'
import { COMPANY } from './config.ts'
import type { ModelResolver } from './models.ts'
import { completeSimple } from './omp/ai.ts'
import { prompts } from './prompts.ts'
import { hideInContext } from './provider-secrets.ts'

/**
 * A company from the person's description: one model call drafts it against the fixed schema (MiroFish's
 * personas-from-a-seed idea, without the demographics), checked by the same validation as a saved company; a draft that
 * fails goes back with every problem, up to COMPANY.draftAttempts times, as rule-draft.ts does after omp's /omfg. The
 * person sees the draft and edits it; nothing is saved until they save it.
 */
export async function draftCompany(input: {
  readonly resolver: ModelResolver
  readonly model: string
  readonly description: string
}): Promise<CompanyBody> {
  const description = input.description.trim()
  if (description.length < 10) throw new Error('describe the company in a sentence or more')
  const resolved = input.resolver.resolve(input.model)
  const apiKey = await input.resolver.requireApiKey(resolved.model)
  let previous: string | undefined
  let feedback: string | undefined
  let problems: readonly CompanyProblem[] = []
  for (let attempt = 1; attempt <= COMPANY.draftAttempts; attempt++) {
    const context = {
      systemPrompt: [prompts.company.draftSystem],
      messages: [
        {
          role: 'user' as const,
          content: prompts.company.draft(description.slice(0, 4_000), feedback, previous),
          timestamp: Date.now(),
        },
      ],
    }
    const signal = AbortSignal.timeout(COMPANY.draftMs)
    const reply = resolved.streamFn
      ? await (await resolved.streamFn(resolved.model, hideInContext(context), { apiKey, signal })).result()
      : await completeSimple(resolved.model, hideInContext(context), { apiKey, signal })
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
      throw new Error(reply.errorMessage ?? 'the model could not draft a company')
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    const json = jsonIn(text)
    previous = json ?? text.trim().slice(0, 8_000)
    if (!json) {
      feedback = 'The reply had no JSON object.'
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch (err) {
      feedback = `The JSON did not parse: ${err instanceof Error ? err.message : String(err)}`
      continue
    }
    const parsed = parseCompany(raw)
    if (parsed.company) return parsed.company
    problems = parsed.problems
    feedback = problems.map((p) => `- ${p.path}: ${p.message}`).join('\n')
  }
  throw new Error(
    `the model did not draft a valid company${problems.length ? `: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}` : ''}`,
  )
}

/** The JSON object in a reply: inside a ```json fence, or from the first `{` to the last `}`. */
function jsonIn(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const body = fenced ?? text
  const from = body.indexOf('{')
  const to = body.lastIndexOf('}')
  return from >= 0 && to > from ? body.slice(from, to + 1) : undefined
}
