import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_SUMMARY_MAX_CHARS } from './config.ts'
import type { Memory } from './memory.ts'
import { ask } from './memory-review.ts'
import type { ModelResolver } from './models.ts'
import { redactMemorySecrets } from './omp/memory.ts'
import { prompts } from './prompts.ts'

/**
 * Project summaries (TODO 12y.9), after omp hindsight's mental models (named, refreshed summaries of preferences,
 * conventions and decisions loaded at the first turn): a short summary of one project's kept memories, so a chat in a
 * project whose memories do not all fit its prompt still starts from all of them. Built only from memories the person
 * kept, never from chats, so it needs no consent of its own; rebuilt in the background when they change, and never
 * waited for (omp gives its mental models a 1.5 s first-turn deadline), so a round uses the last good one or none.
 * Off unless the person turns it on (Settings → Memory). Stored in `<home>/memory-summaries.json`.
 */

interface Summary {
  readonly text: string
  /** Which kept memories, as last changed, it was built from. */
  readonly from: string
  readonly at: string
}

/** A fingerprint of the memories a summary is built from: any keep, edit or removal changes it. */
export function memoriesStamp(memories: readonly Memory[]): string {
  const hash = createHash('sha256')
  for (const m of [...memories].sort((a, b) => a.id.localeCompare(b.id)))
    hash.update(`${m.id}:${m.updatedAt}\n`)
  return hash.digest('hex').slice(0, 16)
}

export class ProjectSummaries {
  private readonly _file: string
  private readonly _building = new Set<string>()

  constructor(home: string) {
    this._file = join(home, 'memory-summaries.json')
  }

  private _all(): Record<string, Summary> {
    if (!existsSync(this._file)) return {}
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, Summary>) : {}
    } catch (err) {
      console.warn(`reading ${this._file} failed: ${err instanceof Error ? err.message : err}`)
      return {}
    }
  }

  /** The project's summary if it was built from exactly these memories; a stale one is never used. */
  current(project: string, memories: readonly Memory[]): string | undefined {
    const s = this._all()[project]
    return s && s.from === memoriesStamp(memories) ? s.text : undefined
  }

  /**
   * Builds the project's summary from `memories` in the background, unless one from them exists or is being built.
   * Resolves once done; a failure is logged, never thrown, since a round never waits for it.
   */
  async refresh(input: {
    resolver: ModelResolver
    model: string
    project: { id: string; name: string }
    memories: readonly Memory[]
  }): Promise<void> {
    const { id } = input.project
    if (this._building.has(id) || this.current(id, input.memories) !== undefined || !input.memories.length)
      return
    this._building.add(id)
    try {
      const reply = await ask(
        input.resolver,
        input.model,
        prompts.projectSummary.system,
        prompts.projectSummary.memories(
          input.project.name,
          input.memories.map((m) => ({ kind: m.kind, text: m.text })),
        ),
      )
      const text = redactMemorySecrets(reply).trim().slice(0, PROJECT_SUMMARY_MAX_CHARS)
      if (!text) return
      const all = this._all()
      all[id] = { text, from: memoriesStamp(input.memories), at: new Date().toISOString() }
      const tmp = `${this._file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`)
      renameSync(tmp, this._file)
    } catch (err) {
      console.warn(`summarizing ${id}'s memories failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      this._building.delete(id)
    }
  }
}
