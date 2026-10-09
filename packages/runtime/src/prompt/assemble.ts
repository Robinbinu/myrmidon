import type { Environment } from '../patterns.ts'
import { prompts } from '../prompts.ts'
import type { AgentSpec, ColonySpec } from '../spec.ts'
import { factsFor, type PromptFacts } from './facts.ts'
import { HEADINGS, type HeadingKey, SECTIONS, type Section, type Tier } from './sections.ts'

/** Which prompt an agent had: enough to compare two runs by what their agents were told. */
export interface PromptManifest {
  readonly agent: string
  readonly sections: readonly { readonly key: string; readonly version: number; readonly hash: string }[]
  readonly family: string
  /** A rough size of the system prompt (characters / 4). */
  readonly totalTokens: number
}

export interface AssembledPrompt {
  /** System blocks, stable first, then context, then volatile, so providers can cache the longest prefix. */
  readonly system: string[]
  /** What the agent's first message opens with (a crewmate's job); empty for most agents. */
  readonly kickoffPrefix: string
  readonly manifest: PromptManifest
}

export interface RenderedSection {
  readonly section: Section
  readonly text: string
}

const TIERS: readonly Tier[] = ['stable', 'context', 'volatile']

/** Every section whose guard holds for these facts, rendered, in registry order. */
export function renderSections(facts: PromptFacts): RenderedSection[] {
  return SECTIONS.filter((s) => s.guard(facts))
    .map((section) => ({ section, text: section.render(facts) }))
    .filter((r) => r.text.trim().length > 0)
}

const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 12)

/**
 * One system block per tier (after Hermes' stable → context → volatile, and OpenHands' static and dynamic blocks),
 * so providers can cache the longest unchanged prefix. Inside a tier, each heading's sections render under a short
 * `#` heading, in registry order.
 */
function blocks(rendered: readonly RenderedSection[]): string[] {
  return TIERS.flatMap((tier) => {
    const headings = (Object.keys(HEADINGS) as HeadingKey[]).filter((h) => HEADINGS[h].tier === tier)
    const parts = headings.flatMap((h) => {
      const texts = rendered.filter((r) => r.section.heading === h).map((r) => r.text)
      return texts.length ? [`# ${prompts.system.headings[h]}\n${texts.join(HEADINGS[h].join)}`] : []
    })
    return parts.length ? [parts.join('\n\n')] : []
  })
}

export function assemble(facts: PromptFacts): AssembledPrompt {
  const rendered = renderSections(facts)
  const system = blocks(rendered)
  return {
    system,
    kickoffPrefix: facts.agent.job ?? '',
    manifest: {
      agent: facts.agent.name,
      sections: rendered.map(({ section, text }) => ({
        key: section.key,
        version: section.version,
        hash: hash(text),
      })),
      family: facts.model.family,
      totalTokens: Math.round(system.join('\n\n').length / 4),
    },
  }
}

/** The system prompt alone, for callers that have a spec and an environment rather than facts. */
export function systemPrompt(spec: ColonySpec, agent: AgentSpec, env: Environment): string[] {
  return assemble(factsFor(spec, agent, env)).system
}
