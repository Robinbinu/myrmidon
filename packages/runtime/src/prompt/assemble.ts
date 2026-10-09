import type { Environment } from '../patterns.ts'
import type { AgentSpec, ColonySpec } from '../spec.ts'
import { factsFor, type PromptFacts } from './facts.ts'
import { BLOCKS, SECTIONS, type Section, type Tier } from './sections.ts'

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
 * Groups rendered sections by tier (after Hermes' stable → context → volatile, and OpenHands' static and dynamic
 * blocks) and joins each run of sections sharing a block into one system block.
 */
function blocks(rendered: readonly RenderedSection[]): string[] {
  const out: string[] = []
  for (const tier of TIERS) {
    let open: { block: keyof typeof BLOCKS; parts: string[] } | undefined
    const close = () => {
      if (open) out.push(open.parts.join(BLOCKS[open.block]))
      open = undefined
    }
    for (const { section, text } of rendered) {
      if (section.tier !== tier) continue
      if (!section.block || section.block !== open?.block) close()
      if (section.block) {
        open ??= { block: section.block, parts: [] }
        open.parts.push(text)
      } else out.push(text)
    }
    close()
  }
  return out
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
