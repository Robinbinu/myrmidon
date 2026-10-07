import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventPayloads, MadeToolInput } from '@myrmidon/protocol'
import { MADE_TOOL_MAX_SOURCE } from './config.ts'

/**
 * Tools agents make for themselves (like Voyager's skill library): a short script plus a typed input list. A
 * colony checks a new tool against its test input before anyone can call it; the person can then keep it in their
 * library (`<home>/tools`), and every later colony loads the library.
 */

export type MadeTool = Omit<EventPayloads['tool/created'], 'agent' | 'library'>

/** Made tools are called `tool_<name>` so they never shadow the harness's own tools. */
export const MADE_PREFIX = 'tool_'
const NAME = /^[a-z][a-z0-9_]{1,30}$/
const LANGUAGES = ['typescript', 'python', 'bash', 'browser'] as const
const FILE = { typescript: 'main.ts', python: 'main.py', bash: 'main.sh' } as const

/** Checks an agent's (or a library file's) tool definition and returns it in canonical form. */
export function checkedTool(raw: {
  name: string
  description: string
  inputs: readonly Partial<MadeToolInput>[]
  language: string
  source: string
}): MadeTool {
  const name = raw.name.trim()
  if (!NAME.test(name)) throw new Error('name must be 2-31 chars of a-z, 0-9 and _, starting with a letter')
  const description = raw.description.trim()
  if (description.length < 10) throw new Error('describe what the tool does and when to use it (10+ chars)')
  if (!LANGUAGES.includes(raw.language as never))
    throw new Error(`language must be one of ${LANGUAGES.join(', ')}`)
  if (!raw.source.trim()) throw new Error('source is empty')
  if (raw.source.length > MADE_TOOL_MAX_SOURCE) throw new Error('source is over 64 KB; keep tools small')
  const seen = new Set<string>()
  const inputs = raw.inputs.map((i): MadeToolInput => {
    const n = (i.name ?? '').trim()
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(n)) throw new Error(`input name "${n}" is not an identifier`)
    if (seen.has(n)) throw new Error(`input "${n}" is listed twice`)
    seen.add(n)
    if (i.type !== 'string' && i.type !== 'number' && i.type !== 'boolean')
      throw new Error(`input "${n}" needs type string, number or boolean`)
    return {
      name: n,
      type: i.type,
      description: (i.description ?? '').trim(),
      ...(i.optional ? { optional: true } : {}),
    }
  })
  if (raw.language === 'browser') browserSteps(raw.source)
  return { name, description, inputs, language: raw.language as MadeTool['language'], source: raw.source }
}

/** The JSON schema the model sees for a made tool's arguments. */
export function inputSchema(inputs: readonly MadeToolInput[]) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      inputs.map((i) => [i.name, { type: i.type, ...(i.description ? { description: i.description } : {}) }]),
    ),
    required: inputs.filter((i) => !i.optional).map((i) => i.name),
    additionalProperties: false,
  }
}

/** Rejects arguments that don't match the inputs, so the script only ever sees what it declared. */
export function checkedArgs(inputs: readonly MadeToolInput[], args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  const given = args as Record<string, unknown>
  for (const key of Object.keys(given))
    if (!inputs.some((i) => i.name === key)) throw new Error(`unknown input "${key}"`)
  for (const i of inputs) {
    const v = given[i.name]
    if (v === undefined) {
      if (!i.optional) throw new Error(`missing input "${i.name}"`)
      continue
    }
    if (typeof v !== i.type) throw new Error(`input "${i.name}" must be a ${i.type}`)
  }
  return given
}

/** Writes the script under `dir` (if it changed) and returns the command that runs it. */
export function scriptCommand(dir: string, tool: MadeTool): string {
  if (tool.language === 'browser') throw new Error('browser flows run in the browser, not as a script')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, FILE[tool.language])
  if (!existsSync(path) || readFileSync(path, 'utf8') !== tool.source) writeFileSync(path, tool.source)
  const runner = { typescript: 'bun', python: 'python3', bash: 'bash' }[tool.language]
  return `${runner} '${path.replaceAll("'", `'\\''`)}'`
}

/** The person's kept tools, one JSON file each in `<home>/tools`. */
export class ToolLibrary {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  list(): MadeTool[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [checkedTool(JSON.parse(readFileSync(join(this.dir, f), 'utf8')))]
        } catch {
          return []
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  save(tool: MadeTool) {
    const clean = checkedTool(tool)
    const path = join(this.dir, `${clean.name}.json`)
    writeFileSync(`${path}.tmp`, `${JSON.stringify(clean, null, 2)}\n`)
    renameSync(`${path}.tmp`, path)
    return clean
  }

  remove(name: string) {
    if (!NAME.test(name)) throw new Error('no such tool')
    rmSync(join(this.dir, `${name}.json`), { force: true })
  }
}

/**
 * One step of a saved browser flow. Targets are durable selectors, since snapshot refs change on every page:
 * a CSS selector, `text=Sign in` (visible text), or `aria=Search` (accessible name). `{input}` placeholders in
 * strings are filled from the flow's inputs.
 */
export type BrowserStep =
  | { open: string }
  | { click: string }
  | { type: string; text: string; submit?: boolean }
  | { press: string }
  | { wait: string | number }
  | { extract: { what: 'tables' | 'links' | 'items'; selector?: string; fields?: Record<string, string> } }

/** Parses and checks a browser flow's steps; throws with what is wrong. */
export function browserSteps(source: string): BrowserStep[] {
  let steps: unknown
  try {
    steps = JSON.parse(source)
  } catch {
    throw new Error(
      'a browser flow\'s source is a JSON list of steps, e.g. [{"open": "https://…?q={query}"}]',
    )
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 40) throw new Error('give 1 to 40 steps')
  return steps.map((raw, i) => {
    const step = raw as Record<string, unknown>
    const keys = Object.keys(step ?? {})
    const kind = keys.find((k) => ['open', 'click', 'type', 'press', 'wait', 'extract'].includes(k))
    if (!kind) throw new Error(`step ${i + 1}: use open, click, type, press, wait or extract`)
    if (kind === 'type' && typeof step.text !== 'string') throw new Error(`step ${i + 1}: type needs "text"`)
    if (kind === 'extract') {
      const e = step.extract as { what?: unknown } | undefined
      if (!e || !['tables', 'links', 'items'].includes(String(e.what)))
        throw new Error(`step ${i + 1}: extract needs {"what": "tables" | "links" | "items"}`)
    } else if (kind === 'wait') {
      if (typeof step.wait !== 'string' && typeof step.wait !== 'number')
        throw new Error(`step ${i + 1}: wait takes ms or a selector`)
    } else if (typeof step[kind] !== 'string' || !(step[kind] as string).trim())
      throw new Error(`step ${i + 1}: ${kind} needs a value`)
    return step as BrowserStep
  })
}

/** Fills `{name}` placeholders from the inputs; inside URLs the values are URL-encoded. */
export function fillPlaceholders(text: string, input: Record<string, unknown>, url = false): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in input) || input[name] === undefined) return whole
    const value = String(input[name])
    return url ? encodeURIComponent(value) : value
  })
}
