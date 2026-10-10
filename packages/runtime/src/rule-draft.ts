import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import type { AssistantMessage, ToolCall } from '@oh-my-pi/pi-ai'
import { completeSimple } from '@oh-my-pi/pi-ai'
import type { TtsrOutput } from '@oh-my-pi/pi-coding-agent/export/ttsr'
import {
  extractGeneratedRuleJson,
  parseGeneratedRule,
  validateParsedRuleAgainstAssistantHistory,
} from '@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule'
import { RULE_DRAFT_ATTEMPTS, RULE_DRAFT_MS, RULE_DRAFT_OUTPUT_CHARS, RULE_DRAFT_OUTPUTS } from './config.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'
import { hideInContext } from './provider-secrets.ts'
import { enforceable, parseStreamRule, replyOutputs, type StreamRule } from './stream-rules.ts'

/**
 * `/rule`: the person's complaint about the last reply becomes a stream rule, after omp's `/omfg`
 * (modes/controllers/omfg-controller.ts). A model writes the rule as JSON, omp's own parser turns it into the rule
 * file (omfg-rule.ts `parseGeneratedRule`, which repairs a doubly escaped regex), and it is checked against the reply
 * the way the live check would read it; a rule that does not catch it goes back with what went wrong, up to
 * RULE_DRAFT_ATTEMPTS times. The person sees the draft and saves it, asks for a change, or drops it.
 */

export interface RuleDraft {
  readonly name: string
  readonly description: string
  readonly condition: readonly string[]
  readonly scope: readonly string[]
  readonly body: string
  /** The rule's file, frontmatter and all, as it would be saved. */
  readonly text: string
  /** It catches the reply complained about, as the live check would. */
  readonly matched: boolean
  /** Why it could not be confirmed, when it was not. */
  readonly note?: string
}

/** What the latest round's agents wrote, output by output, as rules see it (its `llm/response` events). */
export function roundOutputs(events: readonly MyrEvent[], from: number, cwd: string): TtsrOutput[] {
  const outputs = events
    .filter((e) => e.type === 'llm/response' && e.seq >= from)
    .flatMap((e) => {
      const p = e.payload as EventPayloads['llm/response']
      const message = {
        role: 'assistant',
        content: [
          ...(p.thinking ? [{ type: 'thinking' as const, thinking: p.thinking }] : []),
          ...(p.text ? [{ type: 'text' as const, text: p.text }] : []),
          ...p.toolCalls.map(
            (c): ToolCall => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.arguments as never }),
          ),
        ],
      } as AssistantMessage
      return replyOutputs(message, cwd)
    })
  return outputs.slice(-RULE_DRAFT_OUTPUTS)
}

export async function draftStreamRule(input: {
  readonly resolver: ModelResolver
  readonly model: string
  readonly complaint: string
  readonly outputs: readonly TtsrOutput[]
  /** A change the person asked for to an earlier draft. */
  readonly amend?: { readonly previous: string; readonly change: string }
}): Promise<RuleDraft> {
  const resolved = input.resolver.resolve(input.model)
  const apiKey = await input.resolver.requireApiKey(resolved.model)
  const shown = input.outputs.map((o) => ({
    subject: o.subject,
    content:
      o.content.length > RULE_DRAFT_OUTPUT_CHARS
        ? `${o.content.slice(0, RULE_DRAFT_OUTPUT_CHARS)}…`
        : o.content,
  }))
  const failed: string[] = input.amend
    ? [`The person asked for this change before saving:\n${input.amend.change}`]
    : []
  let previous = input.amend?.previous
  let last: RuleDraft | undefined
  let error = ''
  for (let attempt = 1; attempt <= RULE_DRAFT_ATTEMPTS; attempt++) {
    const context = {
      systemPrompt: [prompts.streamRules.draftSystem],
      messages: [
        {
          role: 'user' as const,
          content: prompts.streamRules.draft({
            complaint: input.complaint,
            outputs: shown,
            ...(failed.length ? { feedback: failed.join('\n\n') } : {}),
            ...(previous ? { previous } : {}),
          }),
          timestamp: Date.now(),
        },
      ],
    }
    const signal = AbortSignal.timeout(RULE_DRAFT_MS)
    const reply = resolved.streamFn
      ? await (await resolved.streamFn(resolved.model, hideInContext(context), { apiKey, signal })).result()
      : await completeSimple(resolved.model, hideInContext(context), { apiKey, signal })
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
      throw new Error(reply.errorMessage ?? 'the model could not draft a rule')
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    const parsed = parseGeneratedRule(text)
    if ('error' in parsed) {
      error = parsed.error
      const candidate = extractGeneratedRuleJson(text) ?? text.trim()
      failed.push(
        `Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${candidate}`,
      )
      previous = candidate
      continue
    }
    if (!parsed.rule.condition?.length) {
      error = prompts.streamRules.conditionOnly
      failed.push(
        `Attempt ${attempt} failed: ${prompts.streamRules.conditionOnly}\nFailed candidate:\n${parsed.fileContent}`,
      )
      previous = parsed.fileContent
      continue
    }
    // No judge: Myrmidon's rules are regex conditions, which omp checks without one.
    const checked = await validateParsedRuleAgainstAssistantHistory(parsed, input.outputs, undefined)
    const draft = toDraft(checked.candidate.rule, checked.candidate.fileContent, checked.validation.matched)
    if (checked.validation.matched) return draft
    const why = checked.validation.feedback ?? 'The rule condition did not match any output of the reply.'
    last = { ...draft, note: why }
    failed.push(
      `Attempt ${attempt} failed validation:\n${why}\nFailed candidate:\n${checked.candidate.fileContent}`,
    )
    previous = checked.candidate.fileContent
  }
  if (last) return last
  throw new Error(`the model did not write a usable rule${error ? ` (${error})` : ''}`)
}

function toDraft(rule: StreamRule, text: string, matched: boolean): RuleDraft {
  return {
    name: rule.name,
    description: rule.description ?? '',
    condition: rule.condition ?? [],
    scope: rule.scope ?? [],
    body: rule.content.trim(),
    text,
    matched,
  }
}

/**
 * A rule file the person is saving (a draft, perhaps edited): it must be one Myrmidon enforces, a regex `condition`
 * that compiles and a scope that reaches some output. Returns the rule, or throws saying what is wrong.
 */
export function checkRuleFile(name: string, text: string): StreamRule {
  const rule = parseStreamRule(name, text, `${name}.md`, 'user')
  if (!rule)
    throw new Error(
      'a stream rule needs a regex `condition` in its frontmatter, and must not be switched off',
    )
  if (!rule.content) throw new Error('a stream rule needs guidance in its body')
  if (!enforceable(rule))
    throw new Error('the rule’s condition does not compile, or its scope reaches no output')
  return rule
}
