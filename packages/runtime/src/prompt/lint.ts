import { COMPUTER_TOOL_NAMES } from '../computer/names.ts'
import { computerToolSpec } from '../computer/tool.ts'
import { PROMPT_FAMILY_WORDS, PROMPT_HEADING_WORDS, PROMPT_ROLE_WORDS } from '../config.ts'
import { prompts } from '../prompts.ts'
import { TOOL_DEFS, toolDescription, toolParameters } from '../tools.ts'
import { assemble, renderSections } from './assemble.ts'
import type { PromptFacts } from './facts.ts'
import { HEADINGS, type HeadingKey } from './sections.ts'

/** Everything one agent is shown at the start of a round, as the checks read it. */
export interface PromptView {
  readonly facts: PromptFacts
  readonly sections: readonly { readonly key: string; readonly heading: HeadingKey; readonly text: string }[]
  readonly system: readonly string[]
  readonly kickoff: string
  readonly tools: readonly {
    readonly name: string
    readonly description: string
    /** Its parameters as JSON Schema, the way the provider receives them. */
    readonly parameters?: Record<string, unknown>
  }[]
  /** Paths the agent is told about. */
  readonly paths: readonly string[]
}

export interface LintFinding {
  readonly check: string
  /** `system`, `kickoff`, `tool:<name>`, `path` or a section key. */
  readonly where: string
  readonly text: string
}

export interface LintOptions {
  /** Interface labels (a chat title, chat or colony ids) that must never reach the agent. */
  readonly markers?: readonly string[]
}

/**
 * One check over an assembled prompt. New checks (parameter descriptions, word budgets per section) join the list;
 * each returns its findings rather than throwing, so a test can report all of them at once.
 */
export interface LintCheck {
  readonly key: string
  readonly run: (view: PromptView, options: LintOptions) => LintFinding[]
}

/** What `facts` assemble into, with the first message's text from the caller (it needs the round's state). */
export function viewOf(facts: PromptFacts, kickoff = ''): PromptView {
  const assembled = assemble(facts)
  return {
    facts,
    sections: renderSections(facts).map((r) => ({
      key: r.section.key,
      heading: r.section.heading,
      text: r.text,
    })),
    system: assembled.system,
    kickoff: `${assembled.kickoffPrefix}${kickoff}`,
    tools: facts.tools.names.flatMap((name) => {
      const description = toolDescription(name, facts) ?? computerToolSpec(name)?.description
      const parameters = toolParameters(name, facts)
      return description === undefined ? [] : [{ name, description, ...(parameters ? { parameters } : {}) }]
    }),
    paths: [facts.access.project?.path, facts.access.worktree?.path].filter((p): p is string => !!p),
  }
}

const TOOL_NAMES = [...TOOL_DEFS.map((d) => d.name), ...COMPUTER_TOOL_NAMES]

/**
 * Tool names a text mentions: a name with an underscore anywhere; a one-word name (message, shell, propose), which
 * is also an English word, only when it is called or introduced as a tool (`name(`, `name:`, `with name`, `use name`).
 */
export function mentionedTools(text: string): string[] {
  return TOOL_NAMES.filter((n) =>
    new RegExp(
      n.includes('_') ? `(?<![\\w-])${n}(?![\\w-])` : `(?<![\\w-])${n}[(:]|\\b(with|use) ${n}\\b`,
    ).test(text),
  )
}

/** A sentence that names a tool the agent lacks sends it after that tool or the workflow around it. */
const unknownTools: LintCheck = {
  key: 'unknown-tools',
  run: (view) => {
    const owned = new Set(view.facts.tools.names)
    const texts = [
      ...view.sections.map((s) => ({ where: s.key, text: s.text })),
      { where: 'kickoff', text: view.kickoff },
    ]
    return texts.flatMap(({ where, text }) =>
      mentionedTools(text)
        .filter((n) => !owned.has(n))
        .map((n) => ({ check: 'unknown-tools', where, text: n })),
    )
  },
}

/** The person's labels for their screen (titles, ids) read to agents as a brief, so none may reach them. */
const interfaceMetadata: LintCheck = {
  key: 'interface-metadata',
  run: (view, { markers = [] }) => {
    const texts = [
      ...view.system.map((text) => ({ where: 'system', text })),
      { where: 'kickoff', text: view.kickoff },
      ...view.tools.map((t) => ({ where: `tool:${t.name}`, text: t.description })),
      ...view.paths.map((text) => ({ where: 'path', text })),
    ]
    return markers
      .filter((m) => m.length > 0)
      .flatMap((marker) =>
        texts
          .filter(({ text }) => text.toLowerCase().includes(marker.toLowerCase()))
          .map(({ where }) => ({ check: 'interface-metadata', where, text: marker })),
      )
  },
}

/** Sentences of a section, with hard line breaks and bullet marks taken out, normalised for comparison. */
function sentences(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*-\s+/, ''))
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) =>
      s
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!?:;,]+$/, '')
        .trim(),
    )
    .filter((s) => s.split(' ').length >= 5)
}

/** A rule said in two places has two versions to keep in step, and models weigh the repeat as emphasis. */
const repeatedSentences: LintCheck = {
  key: 'repeated-sentences',
  run: (view) => {
    const seen = new Map<string, string>()
    const found: LintFinding[] = []
    for (const { key, text } of view.sections)
      for (const sentence of new Set(sentences(text))) {
        const first = seen.get(sentence)
        if (first === undefined) seen.set(sentence, key)
        else if (first !== key)
          found.push({ check: 'repeated-sentences', where: `${first}, ${key}`, text: sentence })
      }
    return found
  },
}

/**
 * Words Myrmidon wrote in a text: data it carries (tagged blocks such as <memory>, and roster lines naming a
 * crewmate's tools) grows with the person's setup, not with the wording, so it does not count.
 */
export function authoredWords(text: string): number {
  return text
    .replace(/<([a-z_]+)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .split('\n')
    .filter((line) => !/^- [^:]+: .*; tools: /.test(line))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length
}

/**
 * Per-heading and per-role word budgets (config.ts, after the targets in the harness-prompts research §4.3 and
 * §4.4): a prompt grows one sentence at a time, and only a number makes that visible. Raise a budget in the same
 * change that needs it.
 */
const wordBudgets: LintCheck = {
  key: 'word-budget',
  run: (view) => {
    const found: LintFinding[] = []
    // Model-family blocks are budgeted on their own: they come with the model, not the role.
    const family = view.sections.filter((s) => s.key.startsWith('family:'))
    const familyWords = family.reduce((n, s) => n + authoredWords(s.text), 0)
    if (familyWords > PROMPT_FAMILY_WORDS)
      found.push({
        check: 'word-budget',
        where: 'family',
        text: `${familyWords} > ${PROMPT_FAMILY_WORDS} words`,
      })
    let stable = 0
    for (const heading of Object.keys(HEADINGS) as HeadingKey[]) {
      const words = view.sections
        .filter((s) => s.heading === heading && !family.includes(s))
        .reduce((n, s) => n + authoredWords(s.text), 0)
      if (HEADINGS[heading].tier === 'stable') stable += words
      // A plugin's own section is the plugin author's text, like project instructions.
      const budget = heading === 'plugins' ? Number.POSITIVE_INFINITY : PROMPT_HEADING_WORDS[heading]
      if (words > budget)
        found.push({ check: 'word-budget', where: heading, text: `${words} > ${budget} words` })
    }
    const { kind, works } = view.facts.agent
    // A team lead with hands-on tools also gets the working method.
    const role = kind === 'team-lead' && works ? 'team-lead-hands-on' : kind
    const budget = PROMPT_ROLE_WORDS[role]
    if (stable > budget)
      found.push({ check: 'word-budget', where: role, text: `${stable} > ${budget} words` })
    return found
  },
}

/**
 * A lead that is not told what its crewmates can do tells the person the team cannot do it: each crewmate it can hand
 * work to is listed with its tools, and a "you have no ... tools" line names only tools the lead really lacks.
 */
const crewTools: LintCheck = {
  key: 'crew-tools',
  run: (view) => {
    const { facts } = view
    const text = view.system.join('\n')
    const crew =
      facts.agent.kind === 'team-lead'
        ? facts.mode.roster
        : facts.agent.kind === 'solo'
          ? facts.mode.crewmatesOnCall
          : []
    const words = prompts.capabilities.groups
    const listed = crew
      .filter(
        (c) =>
          !text
            .split('\n')
            .some(
              (l) => l.startsWith(`- ${c.name}: `) && l.includes(c.tools.map((g) => words[g]).join(', ')),
            ),
      )
      .map((c) => ({ check: 'crew-tools', where: c.name, text: `${c.name} is not listed with its tools` }))
    const lacking = /You have no (.+?) tools yourself/.exec(text)?.[1] ?? ''
    const wrong = facts.agent.groups
      .filter((g) => new RegExp(`\\b${words[g]}\\b`).test(lacking))
      .map((g) => ({
        check: 'crew-tools',
        where: facts.agent.name,
        text: `told it lacks ${g}, which it has`,
      }))
    return [...listed, ...wrong]
  },
}

/** Paths to the parameters of a JSON Schema that carry no description, nested objects and array items included. */
export function undescribed(schema: unknown, at = ''): string[] {
  if (!schema || typeof schema !== 'object') return []
  const node = schema as Record<string, unknown>
  const props = (node.properties ?? {}) as Record<string, Record<string, unknown>>
  const own = Object.entries(props).flatMap(([key, value]) => [
    ...(typeof value.description === 'string' && value.description.trim() ? [] : [`${at}${key}`]),
    ...undescribed(value, `${at}${key}.`),
  ])
  const items = node.items ? undescribed(node.items, at.replace(/\.$/, '[].')) : []
  const branches = ['anyOf', 'oneOf', 'allOf'].flatMap((k) =>
    Array.isArray(node[k]) ? (node[k] as unknown[]).flatMap((b) => undescribed(b, at)) : [],
  )
  return [...own, ...items, ...branches]
}

/**
 * Every parameter of every tool the agent has says what it is, with its unit, default and allowed values (§4.9): a
 * bare name and type leave the model to guess, and nearly half of them once did.
 */
const paramDescriptions: LintCheck = {
  key: 'param-descriptions',
  run: (view) =>
    view.tools.flatMap((t) =>
      undescribed(t.parameters).map((p) => ({
        check: 'param-descriptions',
        where: `tool:${t.name}`,
        text: p,
      })),
    ),
}

export const CHECKS: readonly LintCheck[] = [
  unknownTools,
  interfaceMetadata,
  repeatedSentences,
  wordBudgets,
  crewTools,
  paramDescriptions,
]

export function lint(view: PromptView, options: LintOptions = {}, checks = CHECKS): LintFinding[] {
  return checks.flatMap((c) => c.run(view, options))
}
