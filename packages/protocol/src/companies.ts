/**
 * A company: a saved crew of roles, each its own crewmate, and a playbook of stages they work through. Mode-free data:
 * how a round runs it (who leads, who may hire) lives in the runtime's prompts and patterns, so swarm, lead/worker and a
 * later org mode can all read the same file.
 */

/** Model tiers, never model ids, so a shared company runs on whoever's models: each resolves to one of theirs. */
export const MODEL_TIERS = ['frontier', 'smart', 'fast'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * What a role may use, as a narrowing of whatever the round allows: `full` takes nothing away, `no-shell` its
 * commands, `review` its file changes, `read-only` both. A company never grants what the person's permissions do not.
 */
export const COMPANY_ACCESS = ['full', 'no-shell', 'review', 'read-only'] as const
export type CompanyAccess = (typeof COMPANY_ACCESS)[number]

/** `lead`: every round starts with the head alone, who brings in the playbook when the work needs it. */
export const COMPANY_STARTS = ['lead', 'playbook'] as const
export type CompanyStart = (typeof COMPANY_STARTS)[number]

export interface CompanyRole {
  /** The crewmate's name: it joins under it, and the person writes to it as @name. */
  readonly name: string
  /** A label, e.g. "Engineering lead": capability comes from the prompt and tools, not the title. */
  readonly title: string
  readonly responsibilities: readonly string[]
  readonly tier: ModelTier
  readonly access: CompanyAccess
  /** Another role's name; the head reports to nobody. */
  readonly reportsTo?: string
  /** The playbook stage this role owns: it is woken when that stage's task is ready. */
  readonly stage?: string
  /** How the role works: the body of `roles/<name>.md`. */
  readonly prompt: string
}

export interface CompanyStage {
  readonly id: string
  readonly title: string
  /** Stages that must be done first. */
  readonly after: readonly string[]
  /** The artifact the stage hands on (`spec.md`); its task cannot be submitted without it. */
  readonly output?: string
  readonly brief: string
}

/** What the person edits and shares; the store adds an id and a version. */
export interface CompanyBody {
  readonly name: string
  /** What kind of company: software, marketing, research, operations, or anything else. */
  readonly kind: string
  readonly description: string
  /** Where its prompts come from, for a template adapted from someone else's work. */
  readonly credit?: string
  /** The role that leads: the round's lead, who speaks to the person. */
  readonly head: string
  readonly start: CompanyStart
  readonly budget?: { readonly perRunUsd?: number }
  readonly roles: readonly CompanyRole[]
  readonly playbook: readonly CompanyStage[]
}

export interface Company extends CompanyBody {
  readonly id: string
  /** Bumped by every save; rounds log id, version and hash, so a replay names the exact company. */
  readonly version: number
  readonly savedAt: string
  /** What this version changed. */
  readonly note?: string
  /** The built-in template it was made from. */
  readonly template?: string
}

/** One saved version in a company's history. */
export interface CompanyVersion {
  readonly version: number
  readonly savedAt: string
  readonly note?: string
}

/** The company a round ran with, as its log records it. */
export interface CompanyRef {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly hash: string
}

/** A change to the saved company an agent proposes after a run; it applies only once the person approves it. */
export type CompanyChange = 'hire' | 'fire' | 'rerole'

/** What the round's record says about the role a proposal names, counted by the harness. */
export interface RoleRecord {
  readonly tasks: number
  readonly verified: number
  readonly sentBack: number
  readonly turns: number
  readonly costUsd: number
}
