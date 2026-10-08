import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_SPECIALISTS } from './config.ts'
import { prompts } from './prompts.ts'
import { TOOL_GROUPS, type ToolGroup } from './settings.ts'
import type { AgentSpec } from './spec.ts'

/**
 * Agents the person defines once and brings back: a fixed name, what they are for, how they work, the model they
 * run on, and what they may use. A specialist is a template, whatever the team mode: a worker under a lead, a peer
 * in a swarm, someone hired into an organisation.
 */
export interface Specialist {
  readonly id: string
  /** The name it joins under every time, so the person knows it and can write to it (@name). */
  readonly name: string
  /** What it is for, in a few words: "data analyst", "UI copywriter". */
  readonly specialty: string
  /** How it works: its own role instructions, added to the team's. */
  readonly instructions: string
  /** Its model; without one it runs on the team's worker model. */
  readonly model?: string
  /** Tool groups it may not use (on top of anything Settings switches off). */
  readonly off: readonly ToolGroup[]
  readonly createdAt: string
}

export type SpecialistInput = Pick<Specialist, 'name' | 'specialty' | 'instructions' | 'off'> & {
  readonly model?: string | undefined
}

/** Names the harness uses itself, which a specialist cannot take. */
const RESERVED = new Set([
  'lead',
  'team',
  'user',
  'verifier',
  'judge',
  'system',
  'myrmidon',
  'previous-round',
])
const NAME = /^[a-z][a-z0-9-]{1,23}$/
/** Groups a specialist can be kept from; every crew member can always message the others. */
export const SPECIALIST_GROUPS: readonly ToolGroup[] = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter(
  (g) => g !== 'messaging',
)

/** `<home>/specialists.json`. */
export class SpecialistStore {
  private readonly _file: string

  constructor(home: string) {
    this._file = join(home, 'specialists.json')
  }

  list(): Specialist[] {
    if (!existsSync(this._file)) return []
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as Specialist[]).filter((s) => s && typeof s.name === 'string') : []
    } catch {
      return []
    }
  }

  byName(name: string): Specialist | undefined {
    return this.list().find((s) => s.name === name)
  }

  /** Creates a specialist, or (with `id`) changes one; returns it as saved. */
  save(input: SpecialistInput, id?: string): Specialist {
    const all = this.list()
    const current = id ? all.find((s) => s.id === id) : undefined
    if (id && !current) throw new Error('no such specialist')
    const name = input.name.trim().toLowerCase()
    if (!NAME.test(name))
      throw new Error('name: 2-24 lowercase letters, digits and dashes, starting with a letter')
    if (RESERVED.has(name)) throw new Error(`"${name}" is a name Myrmidon uses itself; choose another`)
    if (all.some((s) => s.name === name && s.id !== id))
      throw new Error(`there is already a specialist called ${name}`)
    if (!current && all.length >= MAX_SPECIALISTS) throw new Error(`at most ${MAX_SPECIALISTS} specialists`)
    const specialty = input.specialty.trim()
    if (!specialty || specialty.length > 60) throw new Error('specialty: a few words, up to 60 characters')
    const instructions = input.instructions.trim()
    if (instructions.length > 8000) throw new Error('instructions: up to 8000 characters')
    const model = input.model?.trim()
    if (model && !/^[^/\s]+\/\S+$/.test(model)) throw new Error('model must be "provider/model-id"')
    const unknown = input.off.filter((g) => !SPECIALIST_GROUPS.includes(g))
    if (unknown.length) throw new Error(`unknown tool groups: ${unknown.join(', ')}`)
    const saved: Specialist = {
      id: current?.id ?? `${name}-${Date.now().toString(36)}`,
      name,
      specialty,
      instructions,
      ...(model ? { model } : {}),
      off: [...new Set(input.off)],
      createdAt: current?.createdAt ?? new Date().toISOString(),
    }
    this._write(current ? all.map((s) => (s.id === saved.id ? saved : s)) : [...all, saved])
    return saved
  }

  remove(id: string): boolean {
    const all = this.list()
    const rest = all.filter((s) => s.id !== id)
    if (rest.length === all.length) return false
    this._write(rest)
    return true
  }

  private _write(list: readonly Specialist[]) {
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`)
    renameSync(tmp, this._file)
  }
}

/** A specialist as a crew member: its name, specialty, instructions, model, and the tools it may not use. */
export function specialistAgent(s: Specialist, role: 'worker' | 'peer', fallbackModel: string): AgentSpec {
  const without = s.off.flatMap((g) => TOOL_GROUPS[g])
  return {
    name: s.name,
    role,
    model: s.model ?? fallbackModel,
    specialty: s.specialty,
    ...(s.instructions ? { instructions: prompts.chat.specialist(s.name, s.instructions) } : {}),
    ...(without.length ? { withoutTools: without } : {}),
  }
}
