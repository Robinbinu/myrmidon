import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BlobStore } from '@myrmidon/core'
import type { ColonyState } from '@myrmidon/protocol'
import { clockTime, localDate } from './clock.ts'

const ARTIFACT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

export function assertArtifactName(name: string): string {
  if (name.length > 200 || !ARTIFACT_NAME.test(name) || name.split('/').includes('..')) {
    throw new Error(
      `invalid artifact name ${JSON.stringify(name)}: use letters, digits, ., _, -, and / between segments`,
    )
  }
  return name
}

/**
 * On-disk layout of one colony: scratch directories per agent plus a read-only mirror. With a project, agents
 * work in the project folder instead (shared by the team) and keep their scratch for private files.
 */
export class ColonyWorkspace {
  readonly scratchRoot: string
  readonly mirrorRoot: string
  private readonly _isolated = new Map<string, { workdir: string; branch: string }>()

  constructor(
    readonly colonyDir: string,
    /** The person's project folder (absolute, real path), when the chat belongs to one. */
    readonly project?: string,
    /** Whether the round has full access right now: then the file tools may reach any path the person can. */
    private readonly _unconfined: () => boolean = () => false,
  ) {
    this.scratchRoot = join(colonyDir, 'scratch')
    this.mirrorRoot = join(colonyDir, 'mirror')
    mkdirSync(this.scratchRoot, { recursive: true })
    mkdirSync(this.mirrorRoot, { recursive: true })
  }

  scratch(agent: string): string {
    const dir = join(this.scratchRoot, agent)
    mkdirSync(dir, { recursive: true })
    return realpathSync(dir)
  }

  /** Where an agent's shell starts and its file tools work: its worktree, the project, or its scratch directory. */
  workdir(agent: string): string {
    return this._isolated.get(agent)?.workdir ?? this.project ?? this.scratch(agent)
  }

  /** Points an agent at its own git worktree of the project instead of the shared folder. */
  isolate(agent: string, tree: { workdir: string; branch: string }) {
    this._isolated.set(agent, tree)
  }

  /** The agent's worktree, if it has one. */
  isolation(agent: string): { workdir: string; branch: string } | undefined {
    return this._isolated.get(agent)
  }

  /**
   * Resolves an agent-supplied path for the file tools: relative paths are in its working directory; absolute
   * paths may point into the project or its own scratch, and nowhere else. With full access any path goes, `~` for
   * the person's home included.
   */
  resolveInWorkdir(agent: string, path: string): string {
    const roots = [...new Set([this.workdir(agent), this.scratch(agent)])]
    const unconfined = this._unconfined()
    const named = unconfined ? path.replace(/^~(?=$|\/)/, homedir()) : path
    const target = isAbsolute(named) ? named : resolve(roots[0] as string, named)
    let probe = target
    while (!existsSync(probe)) probe = dirname(probe)
    const real = join(realpathSync(probe), relative(probe, target))
    if (!unconfined && !roots.some((root) => real === root || real.startsWith(root + sep)))
      throw new Error(
        `path is outside your ${this.project ? 'project and scratch directories' : 'scratch directory'}: ${path}`,
      )
    return real
  }

  /**
   * Resolves an agent-supplied path inside its scratch directory. Symlinks are resolved so a link
   * cannot point the agent outside its own directory.
   */
  resolveInScratch(agent: string, path: string): string {
    const root = this.scratch(agent)
    const target = isAbsolute(path) ? path : resolve(root, path)
    let probe = target
    while (!existsSync(probe)) probe = dirname(probe)
    const real = join(realpathSync(probe), relative(probe, target))
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`path escapes your scratch directory: ${path}`)
    }
    return real
  }

  /** Rewrites the read-only mirror of artifacts and notes from projected state. */
  async writeMirror(state: ColonyState, blobs: BlobStore): Promise<void> {
    const write = (rel: string, content: string | Uint8Array) => {
      const path = join(this.mirrorRoot, rel)
      mkdirSync(dirname(path), { recursive: true })
      if (existsSync(path)) {
        chmodSync(path, 0o644)
        unlinkSync(path)
      }
      writeFileSync(path, content)
      chmodSync(path, 0o444)
    }
    const at = (time: string) => `${localDate(time)} ${clockTime(time)}`
    write('notes.md', state.notes.map((n) => `- [${at(n.time)}] ${n.agent}: ${n.text}`).join('\n'))
    write('board.md', state.board.map((b) => `- [${at(b.time)}] ${b.agent}: ${b.text}`).join('\n'))
    for (const [name, versions] of Object.entries(state.artifacts)) {
      const latest = versions.at(-1)
      if (latest) write(join('artifacts', name), await blobs.get(latest.blob))
    }
  }

  /** Writes the latest version of the named artifacts into a fresh directory for verification. */
  async materialize(
    state: ColonyState,
    blobs: BlobStore,
    names: readonly string[],
    dir: string,
  ): Promise<string[]> {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const missing: string[] = []
    const all = names.length > 0 ? names : Object.keys(state.artifacts)
    for (const name of all) {
      const prefix = name.endsWith('/') ? name : `${name}/`
      const matches = Object.keys(state.artifacts).filter((a) => a === name || a.startsWith(prefix))
      if (matches.length === 0) missing.push(name)
      for (const match of matches) {
        const latest = state.artifacts[match]?.at(-1)
        if (!latest) continue
        const path = join(dir, match)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, await blobs.get(latest.blob))
      }
    }
    return missing
  }
}

/** Folders file listings and searches do not descend into: dependencies, VCS data, and build output. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
])
