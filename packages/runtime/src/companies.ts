import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPANY_ACCESS,
  COMPANY_STARTS,
  type ColonyState,
  type Company,
  type CompanyAccess,
  type CompanyBody,
  type CompanyChange,
  type CompanyRef,
  type CompanyRole,
  type CompanyStage,
  type CompanyVersion,
  type EventPayloads,
  MODEL_TIERS,
  type ModelTier,
  type RoleRecord,
  type TaskSnapshot,
} from '@myrmidon/protocol'
import { COMPANY } from './config.ts'
import { prompts } from './prompts.ts'
import { TOOL_GROUPS } from './settings.ts'
import { type SkillFinding, scanText } from './skill-scan.ts'
import type { AgentSpec } from './spec.ts'
import { RESERVED_SPECIALIST_NAMES } from './specialists.ts'
import { assertArtifactName } from './workspace.ts'

/**
 * Companies (docs/research/2026-10-15-mirofish-gstack-company-mode.md, approach B): a saved crew the person reuses.
 * Every role is its own crewmate, with its prompt, model tier and tools; the playbook's stages become tasks with
 * dependencies, and a role is woken only when its stage's task is ready. Stored as a folder per company:
 *
 *   <home>/companies/<id>/company.yaml      roles, reporting lines, playbook
 *   <home>/companies/<id>/roles/<name>.md   each role's prompt
 *   <home>/companies/<id>/versions/<n>.yaml every saved version, whole (the export format), for history and roll back
 */

/** The tools each access level takes away, on top of anything the round's permissions already do. */
export const ACCESS_TOOLS: Readonly<Record<CompanyAccess, readonly string[]>> = {
  full: [],
  'no-shell': TOOL_GROUPS.shell,
  review: ['fs_write', 'fs_edit', 'ast_edit'],
  'read-only': ['fs_write', 'fs_edit', 'ast_edit', ...TOOL_GROUPS.shell],
}

/** The models the tiers resolve to for this person: the lead's for frontier, the crew's, and the one for small jobs. */
export interface TierModels {
  readonly frontier: string
  readonly smart: string
  readonly fast: string
}

export interface CompanyProblem {
  /** Where in the company, e.g. `roles[2].reportsTo`. */
  readonly path: string
  readonly message: string
}

export class CompanyInvalidError extends Error {
  constructor(readonly problems: readonly CompanyProblem[]) {
    super(problems.map((p) => `${p.path}: ${p.message}`).join('; '))
    this.name = 'CompanyInvalidError'
  }
}

/** The first line of a shared company file, and the format this Myrmidon reads and writes. */
export const COMPANY_FILE_KIND = 'myrmidon-company'
export const COMPANY_FORMAT = 1

const ROLE_NAME = /^[a-z][a-z0-9-]{1,23}$/
const STAGE_ID = /^[a-z][a-z0-9-]{0,23}$/
const ROLE_FILE = /^roles\/([a-z][a-z0-9-]{1,23})\.md$/

type Raw = Record<string, unknown>
const isRecord = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])

/**
 * Checks a company as read from a file, the page or a model's draft, and returns it in canonical form with every
 * problem found (not just the first), so the person can fix them all at once. `readPrompt` reads a role's
 * `prompt: roles/<name>.md`; without it a prompt is its own text.
 */
export function parseCompany(
  raw: unknown,
  readPrompt?: (file: string) => string | undefined,
): { company?: CompanyBody; problems: CompanyProblem[] } {
  const problems: CompanyProblem[] = []
  const bad = (path: string, message: string) => problems.push({ path, message })
  if (!isRecord(raw)) return { problems: [{ path: 'company', message: 'expected a company object' }] }
  if (raw.format !== undefined && raw.format !== COMPANY_FORMAT)
    bad('format', `format ${String(raw.format)} is not one this Myrmidon reads (${COMPANY_FORMAT})`)
  const name = text(raw.name)
  if (!name || name.length > 60) bad('name', 'a name of 1 to 60 characters')
  const kind = text(raw.kind) || 'other'
  if (kind.length > 30) bad('kind', 'a kind of up to 30 characters, such as software or marketing')
  const description = text(raw.description)
  if (description.length > 600) bad('description', 'up to 600 characters')
  const credit = text(raw.credit)
  if (credit.length > 300) bad('credit', 'up to 300 characters')
  const start = (text(raw.start) || 'lead') as CompanyBody['start']
  if (!COMPANY_STARTS.includes(start)) bad('start', `one of ${COMPANY_STARTS.join(', ')}`)
  let budget: CompanyBody['budget']
  if (raw.budget !== undefined && raw.budget !== null) {
    const usd = isRecord(raw.budget) ? raw.budget.perRunUsd : undefined
    if (usd !== undefined && (typeof usd !== 'number' || !(usd > 0) || usd > COMPANY.maxRunUsd))
      bad('budget.perRunUsd', `a number of dollars above 0 and at most ${COMPANY.maxRunUsd}`)
    else if (typeof usd === 'number') budget = { perRunUsd: Math.round(usd * 100) / 100 }
  }

  const roles: CompanyRole[] = []
  const rawRoles = list(raw.roles)
  if (rawRoles.length === 0) bad('roles', 'a company needs at least one role, the one that leads')
  if (rawRoles.length > COMPANY.maxRoles)
    bad('roles', `at most ${COMPANY.maxRoles} roles: a lead and ${COMPANY.maxRoles - 1} crewmates`)
  for (const [i, r] of rawRoles.entries()) {
    const at = `roles[${i}]`
    if (!isRecord(r)) {
      bad(at, 'expected a role')
      continue
    }
    const roleName = text(r.name).toLowerCase()
    if (!ROLE_NAME.test(roleName))
      bad(`${at}.name`, '2-24 lowercase letters, digits and dashes, starting with a letter')
    else if (RESERVED_SPECIALIST_NAMES.has(roleName))
      bad(`${at}.name`, `"${roleName}" is a name Myrmidon uses itself`)
    else if (roles.some((x) => x.name === roleName)) bad(`${at}.name`, `two roles are called ${roleName}`)
    const title = text(r.title)
    if (!title || title.length > 60) bad(`${at}.title`, 'a title of 1 to 60 characters')
    const tier = (text(r.tier) || 'smart') as ModelTier
    if (!MODEL_TIERS.includes(tier)) bad(`${at}.tier`, `one of ${MODEL_TIERS.join(', ')}`)
    const access = (text(r.access) || 'full') as CompanyAccess
    if (!COMPANY_ACCESS.includes(access)) bad(`${at}.access`, `one of ${COMPANY_ACCESS.join(', ')}`)
    const responsibilities = list(r.responsibilities).map(text).filter(Boolean)
    if (responsibilities.length > COMPANY.maxResponsibilities)
      bad(`${at}.responsibilities`, `at most ${COMPANY.maxResponsibilities}`)
    if (responsibilities.some((x) => x.length > 200))
      bad(`${at}.responsibilities`, 'each up to 200 characters')
    let prompt = typeof r.prompt === 'string' ? r.prompt : ''
    const file = ROLE_FILE.exec(prompt.trim())
    if (file && readPrompt) {
      const body = readPrompt(prompt.trim())
      if (body === undefined) bad(`${at}.prompt`, `${prompt.trim()} is missing`)
      prompt = body ?? ''
    }
    prompt = prompt.trim()
    if (prompt.length > COMPANY.maxPromptChars)
      bad(`${at}.prompt`, `up to ${COMPANY.maxPromptChars} characters`)
    const reportsTo = text(r.reportsTo).toLowerCase()
    const stage = text(r.stage).toLowerCase()
    roles.push({
      name: roleName,
      title,
      responsibilities,
      tier,
      access,
      ...(reportsTo ? { reportsTo } : {}),
      ...(stage ? { stage } : {}),
      prompt,
    })
  }
  const named = new Map(roles.map((r) => [r.name, r]))
  const head = text(raw.head).toLowerCase() || roles[0]?.name || ''
  const lead = named.get(head)
  if (!lead) bad('head', `the head must be one of the roles (${roles.map((r) => r.name).join(', ')})`)
  else {
    if (lead.reportsTo) bad('head', 'the head leads, so it reports to nobody')
    if (lead.stage) bad('head', 'the head leads and checks the stages; give its stage to another role')
  }
  // A crewmate with no line written reports to the head.
  for (const [i, r] of roles.entries())
    if (!r.reportsTo && r.name !== head && lead) roles[i] = { ...r, reportsTo: head }
  for (const [i, r] of roles.entries()) {
    if (!r.reportsTo) continue
    if (r.reportsTo === r.name) bad(`roles[${i}].reportsTo`, 'a role cannot report to itself')
    else if (!named.has(r.reportsTo)) bad(`roles[${i}].reportsTo`, `no role is called ${r.reportsTo}`)
  }
  // Reporting lines end at the head: following them from any role never comes back round.
  for (const r of roles) {
    const seen = new Set<string>()
    let at: CompanyRole | undefined = r
    while (at?.reportsTo && !seen.has(at.name)) {
      seen.add(at.name)
      at = named.get(at.reportsTo)
    }
    if (at && seen.has(at.name)) {
      bad('roles', `the reporting lines of ${r.name} go round in a circle`)
      break
    }
  }

  const playbook: CompanyStage[] = []
  const rawStages = list(raw.playbook)
  if (rawStages.length > COMPANY.maxStages) bad('playbook', `at most ${COMPANY.maxStages} stages`)
  for (const [i, s] of rawStages.entries()) {
    const at = `playbook[${i}]`
    if (!isRecord(s)) {
      bad(at, 'expected a stage')
      continue
    }
    const id = text(s.id).toLowerCase()
    if (!STAGE_ID.test(id))
      bad(`${at}.id`, '1-24 lowercase letters, digits and dashes, starting with a letter')
    else if (playbook.some((x) => x.id === id)) bad(`${at}.id`, `two stages are called ${id}`)
    const title = text(s.title)
    if (!title || title.length > 80) bad(`${at}.title`, 'a title of 1 to 80 characters')
    const brief = text(s.brief)
    if (brief.length > 2_000) bad(`${at}.brief`, 'up to 2000 characters')
    const output = text(s.output)
    if (output)
      try {
        assertArtifactName(output)
      } catch {
        bad(`${at}.output`, 'a file name such as spec.md: letters, digits, ., _ and -')
      }
    const after = [
      ...new Set(
        list(s.after)
          .map(text)
          .map((x) => x.toLowerCase()),
      ),
    ].filter(Boolean)
    playbook.push({ id, title, after, ...(output ? { output } : {}), brief })
  }
  const stages = new Map(playbook.map((s) => [s.id, s]))
  for (const [i, s] of playbook.entries()) {
    for (const a of s.after) {
      if (a === s.id) bad(`playbook[${i}].after`, 'a stage cannot wait for itself')
      else if (!stages.has(a)) bad(`playbook[${i}].after`, `no stage is called ${a}`)
    }
    const owners = roles.filter((r) => r.stage === s.id)
    if (owners.length === 0)
      bad(`playbook[${i}]`, `no role owns the ${s.id} stage: set one role's stage to it`)
    if (owners.length > 1)
      bad(`playbook[${i}]`, `${owners.map((o) => o.name).join(' and ')} both own ${s.id}`)
  }
  for (const [i, r] of roles.entries())
    if (r.stage && !stages.has(r.stage)) bad(`roles[${i}].stage`, `no stage is called ${r.stage}`)
  if (stageOrder(playbook) === undefined) bad('playbook', 'the stages wait for each other in a circle')

  if (problems.length) return { problems }
  return {
    company: {
      name,
      kind,
      description,
      ...(credit ? { credit } : {}),
      head,
      start,
      ...(budget ? { budget } : {}),
      roles,
      playbook,
    },
    problems,
  }
}

/** The stages in an order that respects `after`, or undefined when they wait for each other in a circle. */
export function stageOrder(stages: readonly CompanyStage[]): CompanyStage[] | undefined {
  const done = new Set<string>()
  const known = new Set(stages.map((s) => s.id))
  const out: CompanyStage[] = []
  let left = [...stages]
  while (left.length) {
    const ready = left.filter((s) => s.after.every((a) => done.has(a) || !known.has(a)))
    if (ready.length === 0) return undefined
    for (const s of ready) {
      out.push(s)
      done.add(s.id)
    }
    left = left.filter((s) => !done.has(s.id))
  }
  return out
}

/** Like parseCompany, but throws with every problem. */
export function checkCompany(raw: unknown, readPrompt?: (file: string) => string | undefined): CompanyBody {
  const { company, problems } = parseCompany(raw, readPrompt)
  if (!company) throw new CompanyInvalidError(problems)
  return company
}

/** Only the parts a person writes, in a fixed key order: what versions, hashes and exports are made of. */
function bodyOf(c: CompanyBody): CompanyBody {
  return {
    name: c.name,
    kind: c.kind,
    description: c.description,
    ...(c.credit ? { credit: c.credit } : {}),
    head: c.head,
    start: c.start,
    ...(c.budget?.perRunUsd ? { budget: { perRunUsd: c.budget.perRunUsd } } : {}),
    roles: c.roles.map((r) => ({
      name: r.name,
      title: r.title,
      responsibilities: [...r.responsibilities],
      tier: r.tier,
      access: r.access,
      ...(r.reportsTo ? { reportsTo: r.reportsTo } : {}),
      ...(r.stage ? { stage: r.stage } : {}),
      prompt: r.prompt,
    })),
    playbook: c.playbook.map((s) => ({
      id: s.id,
      title: s.title,
      after: [...s.after],
      ...(s.output ? { output: s.output } : {}),
      brief: s.brief,
    })),
  }
}

/** A short fingerprint of what the company says, so a replay can tell two versions apart. */
export function companyHash(c: CompanyBody): string {
  return createHash('sha256')
    .update(JSON.stringify(bodyOf(c)))
    .digest('hex')
    .slice(0, 12)
}

export function companyRef(c: Company): CompanyRef {
  return { id: c.id, name: c.name, version: c.version, hash: companyHash(c) }
}

/**
 * A company as one shareable YAML file, prompts inlined: what Export downloads and what each saved version is.
 * `version`, `savedAt` and `note` say which version it is; import ignores them and starts a fresh history.
 */
export function exportCompany(
  c: CompanyBody & Partial<Pick<Company, 'version' | 'savedAt' | 'note'>>,
): string {
  const doc = {
    kind: COMPANY_FILE_KIND,
    format: COMPANY_FORMAT,
    ...(c.version ? { version: c.version } : {}),
    ...(c.savedAt ? { savedAt: c.savedAt } : {}),
    ...(c.note ? { note: c.note } : {}),
    company: bodyOf(c),
  }
  return `# A Myrmidon company: import it in Settings → Companies.\n${Bun.YAML.stringify(doc, null, 2)}\n`
}

/** A role prompt from someone else's file, flagged where it looks like an attack (the skill scanner's rules). */
export interface CompanyFinding extends SkillFinding {
  readonly role: string
}

/**
 * Reads a shared company file. Its prompts are someone else's words: each is run through the skill scanner, and the
 * findings come back with the company so the person sees them before saving it. Access levels can only narrow what a
 * round allows, so an imported company never gets more than the person's permissions give.
 */
export function importCompany(source: string): { company: CompanyBody; findings: CompanyFinding[] } {
  if (Buffer.byteLength(source) > COMPANY.maxImportBytes)
    throw new Error(`a company file is at most ${Math.round(COMPANY.maxImportBytes / 1024)} KB`)
  let doc: unknown
  try {
    doc = Bun.YAML.parse(source)
  } catch (err) {
    throw new Error(`not a company file: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(doc) || doc.kind !== COMPANY_FILE_KIND || !isRecord(doc.company))
    throw new Error(`not a company file: it should start with kind: ${COMPANY_FILE_KIND}`)
  if (doc.format !== COMPANY_FORMAT)
    throw new Error(
      `this company file is format ${String(doc.format)}; this Myrmidon reads ${COMPANY_FORMAT}`,
    )
  const company = checkCompany(doc.company)
  const findings = company.roles.flatMap((r) =>
    scanText(`roles/${r.name}.md`, r.prompt).map((f) => ({ ...f, role: r.name })),
  )
  return { company, findings }
}

/** `<home>/companies`: one folder per company, its versions inside it. */
export class CompanyStore {
  readonly root: string

  constructor(home: string) {
    this.root = join(home, 'companies')
  }

  list(): Company[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          const c = this.get(d.name)
          return c ? [c] : []
        } catch (err) {
          console.error(`companies: ${d.name} could not be read: ${err instanceof Error ? err.message : err}`)
          return []
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): Company | undefined {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return undefined
    const dir = join(this.root, id)
    const file = join(dir, 'company.yaml')
    if (!existsSync(file)) return undefined
    const raw = Bun.YAML.parse(readFileSync(file, 'utf8')) as Raw
    const body = checkCompany(raw, (f) => {
      const path = join(dir, f)
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    })
    return {
      ...body,
      id,
      version: typeof raw.version === 'number' ? raw.version : 1,
      savedAt: text(raw.savedAt) || new Date(0).toISOString(),
      ...(text(raw.note) ? { note: text(raw.note) } : {}),
      ...(text(raw.template) ? { template: text(raw.template) } : {}),
    }
  }

  /**
   * Saves a new company, or (with `id`) a new version of one: the folder is rewritten and the whole version is kept
   * under versions/, so any earlier one can come back.
   */
  save(input: unknown, opts: { id?: string; note?: string; template?: string } = {}): Company {
    const body = checkCompany(input)
    const current = opts.id ? this.get(opts.id) : undefined
    if (opts.id && !current) throw new Error('no such company')
    const id = current?.id ?? this._newId(body.name)
    const template = opts.template ?? current?.template
    const company: Company = {
      ...body,
      id,
      version: (current?.version ?? 0) + 1,
      savedAt: new Date().toISOString(),
      ...(opts.note ? { note: opts.note.slice(0, 300) } : {}),
      ...(template ? { template } : {}),
    }
    const dir = join(this.root, id)
    mkdirSync(join(dir, 'roles'), { recursive: true })
    mkdirSync(join(dir, 'versions'), { recursive: true })
    for (const r of company.roles) atomicWrite(join(dir, 'roles', `${r.name}.md`), `${r.prompt}\n`)
    const kept = new Set(company.roles.map((r) => `${r.name}.md`))
    for (const f of readdirSync(join(dir, 'roles')))
      if (f.endsWith('.md') && !kept.has(f)) rmSync(join(dir, 'roles', f), { force: true })
    const { roles, playbook, ...rest } = bodyOf(company)
    const file = {
      format: COMPANY_FORMAT,
      ...rest,
      version: company.version,
      savedAt: company.savedAt,
      ...(company.note ? { note: company.note } : {}),
      ...(company.template ? { template: company.template } : {}),
      roles: roles.map((r) => ({ ...r, prompt: `roles/${r.name}.md` })),
      playbook,
    }
    atomicWrite(join(dir, 'company.yaml'), Bun.YAML.stringify(file, null, 2))
    atomicWrite(join(dir, 'versions', `${company.version}.yaml`), exportCompany(company))
    this._prune(join(dir, 'versions'))
    return company
  }

  /** Every saved version, newest first. */
  history(id: string): CompanyVersion[] {
    const dir = join(this.root, id, 'versions')
    if (!this.get(id) || !existsSync(dir)) return []
    return this._versions(dir)
      .flatMap((n) => {
        try {
          const doc = Bun.YAML.parse(readFileSync(join(dir, `${n}.yaml`), 'utf8')) as Raw
          return [
            {
              version: n,
              savedAt: text(doc.savedAt),
              ...(text(doc.note) ? { note: text(doc.note) } : {}),
            },
          ]
        } catch {
          return []
        }
      })
      .reverse()
  }

  /** One saved version, whole. */
  version(id: string, version: number): CompanyBody | undefined {
    const file = join(this.root, id, 'versions', `${Math.floor(version)}.yaml`)
    if (!this.get(id) || !existsSync(file)) return undefined
    return importCompany(readFileSync(file, 'utf8')).company
  }

  /** Brings an earlier version back as the newest one, so the roll back is itself in the history. */
  rollback(id: string, version: number): Company {
    const body = this.version(id, version)
    if (!body) throw new Error(`company ${id} has no version ${version}`)
    return this.save(body, { id, note: prompts.company.rolledBack(version) })
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false
    rmSync(join(this.root, id), { recursive: true, force: true })
    return true
  }

  private _newId(name: string): string {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'company'
    return `${/^[a-z0-9]/.test(slug) ? slug : `c-${slug}`}-${Date.now().toString(36)}`
  }

  private _versions(dir: string): number[] {
    return readdirSync(dir)
      .map((f) => /^(\d+)\.yaml$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
  }

  private _prune(dir: string) {
    const all = this._versions(dir)
    for (const n of all.slice(0, Math.max(0, all.length - COMPANY.maxVersions)))
      rmSync(join(dir, `${n}.yaml`), { force: true })
  }
}

function atomicWrite(file: string, body: string) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
}

// Running a company: the mapping onto the roster and the task graph.

export const headOf = (c: CompanyBody): CompanyRole => c.roles.find((r) => r.name === c.head) as CompanyRole

/** The roles that work as crewmates: everyone but the head. */
export const crewOf = (c: CompanyBody): CompanyRole[] => c.roles.filter((r) => r.name !== c.head)

export const ownerOf = (c: CompanyBody, stage: string): CompanyRole | undefined =>
  c.roles.find((r) => r.stage === stage)

/** A role as a crewmate: its name, model for its tier, title, prompt and the tools its access takes away. */
export function roleAgent(c: CompanyBody, role: CompanyRole, models: TierModels): AgentSpec {
  const without = ACCESS_TOOLS[role.access]
  return {
    name: role.name,
    role: 'worker',
    model: models[role.tier],
    specialty: role.title,
    instructions: prompts.company.role({
      company: c.name,
      name: role.name,
      title: role.title,
      reportsTo: role.reportsTo === c.head ? 'lead' : role.reportsTo,
      responsibilities: role.responsibilities,
      stage: role.stage ? c.playbook.find((s) => s.id === role.stage)?.title : undefined,
      prompt: role.prompt,
    }),
    ...(without.length ? { withoutTools: [...without] } : {}),
  }
}

/** The roster lines the lead is shown: who is on the company, what they do, which stage is theirs. */
function rosterLines(c: CompanyBody): string[] {
  return crewOf(c).map((r) =>
    prompts.company.rosterLine({
      name: r.name,
      title: r.title,
      responsibilities: r.responsibilities,
      ...(r.stage ? { stage: r.stage } : {}),
    }),
  )
}

/**
 * The lead's part: the head role's prompt and the company card for the round's tier. Alone, it keeps the roles on
 * call and may hand the request to the playbook; as a team, the playbook is already on the task board.
 */
export function leadInstructions(
  c: CompanyBody,
  tier: 'answer' | 'solo' | 'team',
  tasks: readonly TaskSnapshot[] = [],
  canEscalate = false,
): string {
  // playbookTasks numbers the stages in stageOrder, so the two line up.
  const order = stageOrder(c.playbook) ?? []
  const stages = tasks.map((t, i) => ({
    id: order[i]?.id ?? t.subject,
    task: t.id,
    owner: t.assignee ?? c.head,
    after: t.blockedBy,
  }))
  const head = headOf(c)
  const card = prompts.company.lead({
    company: c.name,
    title: head.title,
    responsibilities: head.responsibilities,
    prompt: head.prompt,
    roster: rosterLines(c),
  })
  if (tier === 'team')
    return `${card}\n\n${prompts.company.playbookOnBoard(
      stages.map((s) => prompts.company.stageLine(s.task, s.id, s.owner, s.after)),
    )}\n\n${prompts.company.proposals(COMPANY.maxProposals)}`
  if (tier === 'solo')
    return `${card}\n\n${prompts.company.onCall(
      c.playbook.map((s) => s.id),
      canEscalate,
    )}`
  return card
}

/**
 * The playbook as tasks, numbered from `first`: each stage assigned to the role that owns it and blocked by the stages
 * it comes after, so only a ready stage wakes anyone. The minimal gate: a stage's task must be submitted (with its
 * output) and verified before the next one starts. Full gates wait for typed results (TODO.md, Task 7).
 */
export function playbookTasks(c: CompanyBody, request: string, first: number): TaskSnapshot[] {
  const order = stageOrder(c.playbook) ?? []
  const ids = new Map(order.map((s, i) => [s.id, `task-${first + i}`]))
  return order.map((s) => {
    const owner = ownerOf(c, s.id)?.name ?? c.head
    const inputs = s.after.flatMap((a) => {
      const out = c.playbook.find((x) => x.id === a)?.output
      return out ? [out] : []
    })
    return {
      id: ids.get(s.id) as string,
      revision: 1,
      subject: prompts.company.stageSubject(s.title, s.id),
      description: prompts.company.stageTask({
        brief: s.brief,
        request,
        inputs,
        ...(s.output ? { output: s.output } : {}),
      }),
      status: 'pending',
      blockedBy: s.after.flatMap((a) => (ids.has(a) ? [ids.get(a) as string] : [])),
      artifacts: [],
      assignee: owner,
      ...(s.output ? { outputs: [s.output] } : {}),
    }
  })
}

/** A price per million tokens, or nothing when the provider does not say. */
export type Price = { readonly input: number; readonly output: number } | undefined

export interface CompanyEstimate {
  /** What one playbook run is expected to cost, in USD; absent when no model of it has a price. */
  readonly usd?: number
  /** Roles whose model has no price, so the total leaves them out. */
  readonly unpriced: readonly string[]
  readonly roles: readonly { name: string; model: string; usd?: number }[]
  /** The company's own cap on one run, if it has one. */
  readonly capUsd?: number
}

/**
 * The expected cost of one playbook run before it starts: each staffed stage at typical sizes for its role's model,
 * plus the lead coordinating. Roles without a stage are only woken when asked, so they add nothing up front.
 */
export function estimateCompany(
  c: CompanyBody,
  models: TierModels,
  price: (ref: string) => Price,
): CompanyEstimate {
  const e = COMPANY.estimate
  const cost = (ref: string, input: number, output: number) => {
    const p = price(ref)
    return p ? (input * p.input + output * p.output) / 1_000_000 : undefined
  }
  const head = headOf(c)
  const rows = [
    { name: head.name, model: models[head.tier], usd: cost(models[head.tier], e.leadInput, e.leadOutput) },
    ...crewOf(c)
      .filter((r) => r.stage)
      .map((r) => ({
        name: r.name,
        model: models[r.tier],
        usd: cost(models[r.tier], e.stageInput, e.stageOutput),
      })),
  ]
  const priced = rows.filter((r) => r.usd !== undefined)
  return {
    ...(priced.length ? { usd: round(priced.reduce((n, r) => n + (r.usd ?? 0), 0)) } : {}),
    unpriced: rows.filter((r) => r.usd === undefined).map((r) => r.name),
    roles: rows.map((r) => ({
      name: r.name,
      model: r.model,
      ...(r.usd !== undefined ? { usd: round(r.usd) } : {}),
    })),
    ...(c.budget?.perRunUsd ? { capUsd: c.budget.perRunUsd } : {}),
  }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000

// Proposals: agents suggest, the person decides, an approved change is a new version.

/** What the round's record says about one crewmate, counted from the log, not from what the lead remembers. */
export function roleRecord(state: ColonyState, name: string): RoleRecord {
  const tasks = Object.values(state.tasks).filter((t) => t.assignee === name || t.owner === name)
  const agent = state.agents[name]
  return {
    tasks: tasks.length,
    verified: tasks.filter((t) => t.status === 'verified').length,
    sentBack: tasks.filter((t) => t.revision > 1 && t.status === 'rejected').length,
    turns: agent?.turns ?? 0,
    costUsd: Math.round((agent?.cost ?? 0) * 10_000) / 10_000,
  }
}

export type ProposalInput = Pick<
  EventPayloads['company/proposed'],
  'change' | 'role' | 'why' | 'title' | 'tier' | 'access' | 'prompt' | 'responsibilities'
>

/** The company with a proposal applied; throws when the result is not a valid company. */
export function applyProposal(c: CompanyBody, p: ProposalInput): CompanyBody {
  const role = p.role.trim().toLowerCase()
  const existing = c.roles.find((r) => r.name === role)
  const change: CompanyChange = p.change
  if (change === 'hire') {
    if (existing) throw new Error(`the company already has ${role}`)
    return checkCompany({
      ...c,
      roles: [
        ...c.roles,
        {
          name: role,
          title: p.title?.trim() || role,
          responsibilities: p.responsibilities ?? [],
          tier: p.tier ?? 'smart',
          access: p.access ?? 'no-shell',
          reportsTo: c.head,
          prompt: p.prompt ?? '',
        },
      ],
    })
  }
  if (!existing) throw new Error(`the company has no role called ${role}`)
  if (change === 'fire') {
    if (role === c.head) throw new Error('the head leads the company and cannot be let go; edit it instead')
    const stage = existing.stage
    const dropped = c.playbook.find((s) => s.id === stage)
    return checkCompany({
      ...c,
      roles: c.roles
        .filter((r) => r.name !== role)
        .map((r) => (r.reportsTo === role ? { ...r, reportsTo: existing.reportsTo ?? c.head } : r)),
      // Its stage goes with it; the stages after it now wait for what it waited for.
      playbook: c.playbook
        .filter((s) => s.id !== stage)
        .map((s) =>
          dropped && s.after.includes(dropped.id)
            ? { ...s, after: [...new Set([...s.after.filter((a) => a !== dropped.id), ...dropped.after])] }
            : s,
        ),
    })
  }
  return checkCompany({
    ...c,
    roles: c.roles.map((r) =>
      r.name === role
        ? {
            ...r,
            ...(p.title?.trim() ? { title: p.title.trim() } : {}),
            ...(p.tier ? { tier: p.tier } : {}),
            ...(p.access ? { access: p.access } : {}),
            ...(p.prompt?.trim() ? { prompt: p.prompt } : {}),
            ...(p.responsibilities?.length ? { responsibilities: p.responsibilities } : {}),
          }
        : r,
    ),
  })
}
