import { COMPUTER_TOOL } from '../computer/tool.ts'
import { TOOL_DEFS, toolDescription } from '../tools.ts'
import { assemble, renderSections } from './assemble.ts'
import type { PromptFacts } from './facts.ts'
import type { HeadingKey } from './sections.ts'

/** Everything one agent is shown at the start of a round, as the checks read it. */
export interface PromptView {
  readonly facts: PromptFacts
  readonly sections: readonly { readonly key: string; readonly heading: HeadingKey; readonly text: string }[]
  readonly system: readonly string[]
  readonly kickoff: string
  readonly tools: readonly { readonly name: string; readonly description: string }[]
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
      const description = toolDescription(name, facts)
      return description === undefined ? [] : [{ name, description }]
    }),
    paths: [facts.access.project?.path, facts.access.worktree?.path].filter((p): p is string => !!p),
  }
}

const TOOL_NAMES = [...TOOL_DEFS.map((d) => d.name), COMPUTER_TOOL]

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

export const CHECKS: readonly LintCheck[] = [unknownTools, interfaceMetadata, repeatedSentences]

export function lint(view: PromptView, options: LintOptions = {}, checks = CHECKS): LintFinding[] {
  return checks.flatMap((c) => c.run(view, options))
}
