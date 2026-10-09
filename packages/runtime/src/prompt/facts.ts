import { personZone, zoneOffset } from '../clock.ts'
import {
  type Environment,
  isLead,
  onDemand,
  preloaded,
  RUNTIMES,
  skillsFor,
  speaksForColony,
  toolsFor,
} from '../patterns.ts'
import type { AgentSpec, ColonySpec, Tier } from '../spec.ts'

/**
 * What an agent is in its round, from its own point of view: the role decides the brief and the round line, never the
 * round's tier alone (a crewmate the solo lead asks is not "solo").
 */
export type AgentKind =
  | 'answer'
  | 'solo'
  | 'crewmate'
  | 'team-lead'
  | 'team-worker'
  | 'swarm-peer'
  | 'colony-lead'
  | 'colony-worker'
  | 'colony-peer'

/** Model families whose prompting differs; matched from the model ref by name, after OpenHands' model prompt spec. */
export type ModelFamily =
  | 'anthropic'
  | 'openai-codex'
  | 'openai-gpt'
  | 'google-gemini'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'glm'
  | 'mistral'
  | 'llama'
  | 'other'

export interface CrewInfo {
  readonly name: string
  readonly role: string
  readonly model: string
  readonly specialty?: string
}

/**
 * Everything a prompt section may depend on, computed once per agent per round by `factsFor`, the only reader of the
 * spec and the environment. Interface metadata (the chat's title, chat and colony ids, round numbers) has no field
 * here, so no section can put it in front of a model.
 */
export interface PromptFacts {
  readonly agent: {
    readonly name: string
    readonly kind: AgentKind
    readonly model: string
    readonly specialty?: string
    /** Who leads the round; a crewmate answers them. */
    readonly lead: string
    /** The person's (or a specialist's) own instructions for this agent. */
    readonly instructions?: string
    /** A crewmate's job from the lead, when it joined for one. */
    readonly job?: string
    /** It speaks for the round to the person. */
    readonly speaks: boolean
    /** It does hands-on work (everyone except a lead that only delegates, and a direct answer). */
    readonly works: boolean
  }
  readonly mode: {
    readonly tier?: Tier
    readonly chat: boolean
    readonly pattern: ColonySpec['pattern']
    readonly team?: 'orchestrated' | 'swarm'
    /** Agents in the round, this one included. */
    readonly size: number
    /** The round's other agents. */
    readonly roster: readonly CrewInfo[]
    /** Crewmates the lead may ask with ask_crewmate. */
    readonly crewmatesOnCall: readonly CrewInfo[]
    /** How many more crewmates a team lead may add, and the models it may give them. */
    readonly canAdd: number
    readonly workerModels: readonly string[]
    /** The person's saved specialists not yet on the team. */
    readonly specialists: readonly CrewInfo[]
    readonly escalateTo: readonly ('solo' | 'team')[]
  }
  readonly tools: {
    /** Every tool the agent has, after its role, the round's switched-off tools and its own. */
    readonly names: readonly string[]
    /** Of those, the ones it must load with find_tools before calling them. */
    readonly deferred: readonly string[]
  }
  readonly model: { readonly ref: string; readonly family: ModelFamily }
  readonly access: {
    /** The sandbox kind commands run in; `unconfined` is full access. */
    readonly sandbox: string
    readonly fullAccess: boolean
    readonly web: boolean
    readonly browser: boolean
    readonly computer: boolean
    readonly project?: {
      readonly name: string
      readonly path: string
      readonly mode: 'auto' | 'ask' | 'read-only' | 'full'
      readonly allow: readonly string[]
    }
    readonly worktree?: { readonly path: string; readonly branch: string }
    /** Folders the person opened for reading beyond the defaults. */
    readonly reads: readonly string[]
  }
  readonly review: {
    /** What happens to the speaker's final answer. */
    readonly setting: 'off' | 'auto' | 'always'
    /** Who judges it, when it is reviewed. */
    readonly judge?: string
    /** Whether an independent verifier decides completion at all. */
    readonly verifier: boolean
    /** The model that reviews each submitted task, if any. */
    readonly taskJudge?: string
  }
  readonly audience: {
    /** The person who owns Myrmidon opened the round; false when a channel member did. */
    readonly owner: boolean
    /** The round's opening message was said aloud on a voice call. */
    readonly voice: boolean
  }
  readonly env: {
    readonly now: Date
    /** The person's zone with its offset, e.g. "Europe/Berlin (UTC+02:00)". */
    readonly zone: string
    readonly platform: string
    readonly runtimes: readonly string[]
    /** This round's marker for untrusted content blocks. */
    readonly boundary?: string
  }
  readonly context: {
    readonly memory: readonly string[]
    /** `fits`: the request may need it, so its description is shown. */
    readonly skills: readonly {
      readonly name: string
      readonly description: string
      readonly fits: boolean
    }[]
    readonly plugins: readonly string[]
    readonly layout?: string
    readonly checks: readonly { readonly name: string; readonly command: string }[]
    readonly instructions?: { readonly files: readonly string[]; readonly text: string }
    readonly nested: readonly string[]
  }
}

/** Skills listed in a prompt at most; a person with more still loads the rest by name. */
const MAX_SKILLS = 40

const FAMILIES: [ModelFamily, RegExp][] = [
  ['anthropic', /claude|anthropic/],
  ['openai-codex', /codex/],
  ['openai-gpt', /gpt-|\bo[134](-|$)|openai/],
  ['google-gemini', /gemini|gemma/],
  ['qwen', /qwen/],
  ['deepseek', /deepseek/],
  ['kimi', /kimi|moonshot/],
  ['glm', /glm|zhipu|z-ai/],
  ['mistral', /mistral|codestral|devstral/],
  ['llama', /llama/],
]

export function modelFamily(ref: string): ModelFamily {
  const name = ref.toLowerCase()
  return FAMILIES.find(([, match]) => match.test(name))?.[0] ?? 'other'
}

function kindOf(spec: ColonySpec, agent: AgentSpec): AgentKind {
  if (spec.chat && spec.tier === 'answer') return 'answer'
  if (spec.chat && spec.tier === 'solo' && agent.role === 'worker') return 'crewmate'
  if (spec.chat && (spec.tier !== 'team' || spec.agents.length === 1)) return 'solo'
  if (spec.chat && spec.team?.mode === 'swarm') return 'swarm-peer'
  if (isLead(spec, agent)) return spec.chat ? 'team-lead' : 'colony-lead'
  if (spec.pattern === 'lead-workers') return spec.chat ? 'team-worker' : 'colony-worker'
  return 'colony-peer'
}

const info = (a: AgentSpec): CrewInfo => ({
  name: a.name,
  role: a.role,
  model: a.model,
  ...(a.specialty ? { specialty: a.specialty } : {}),
})

/** Whether the round's final answer is reviewed: never with no acceptance checks or the reviewer off. */
function reviewOf(spec: ColonySpec): PromptFacts['review'] {
  const reviewed = spec.acceptance.length > 0 && spec.review !== 'off'
  const llm = spec.acceptance.find((c) => c.verifier === 'llm-judge')
  const judge = llm?.verifier === 'llm-judge' ? llm.model : spec.acceptance.map((c) => c.verifier).join(', ')
  return {
    setting: !reviewed ? 'off' : spec.review === 'auto' ? 'auto' : 'always',
    ...(reviewed ? { judge } : {}),
    verifier: !spec.chat || reviewed,
    ...(spec.taskJudge ? { taskJudge: spec.taskJudge } : {}),
  }
}

/** The facts every prompt section of this agent reads, for this round. */
export function factsFor(spec: ColonySpec, agent: AgentSpec, env: Environment): PromptFacts {
  const kind = kindOf(spec, agent)
  const names = toolsFor(spec, agent)
  const request = spec.chat?.request ?? spec.mission
  const ready = new Set(preloaded(request, names))
  const project = spec.chat?.project
  const now = new Date()
  const skills = (names.includes('use_skill') ? (env.skills ?? []) : []).slice(0, MAX_SKILLS)
  const fits = new Set(skillsFor(request, skills))
  const guide = env.project?.instructions
  const team = spec.team
  return {
    agent: {
      name: agent.name,
      kind,
      model: agent.model,
      ...(agent.specialty ? { specialty: agent.specialty } : {}),
      lead: spec.agents.find((a) => isLead(spec, a))?.name ?? 'lead',
      ...(agent.instructions ? { instructions: agent.instructions } : {}),
      ...(kind === 'crewmate' && agent.focus ? { job: agent.focus } : {}),
      speaks: speaksForColony(spec, agent),
      works: kind !== 'answer' && !(isLead(spec, agent) && !!spec.chat && spec.agents.length > 1),
    },
    mode: {
      ...(spec.tier ? { tier: spec.tier } : {}),
      chat: spec.chat !== undefined,
      pattern: spec.pattern,
      ...(team ? { team: team.mode } : {}),
      size: spec.agents.length,
      roster: spec.agents.filter((a) => a.name !== agent.name).map(info),
      crewmatesOnCall: isLead(spec, agent) ? (team?.crewmates ?? []).map(info) : [],
      canAdd: (team?.maxWorkers ?? 0) - (spec.agents.length - 1),
      workerModels: team?.workerModels ?? [],
      specialists: (team?.specialists ?? []).map(info),
      escalateTo: spec.chat?.escalate ?? [],
    },
    tools: {
      names,
      deferred: names.includes('find_tools') ? names.filter((t) => onDemand(t) && !ready.has(t)) : [],
    },
    model: { ref: agent.model, family: modelFamily(agent.model) },
    access: {
      sandbox: env.sandbox,
      fullAccess: env.sandbox === 'unconfined',
      web: env.web,
      browser: env.browser,
      computer: env.computer ?? false,
      ...(project
        ? {
            project: {
              name: project.name,
              path: project.path,
              mode: project.permissions?.mode ?? 'auto',
              allow: project.permissions?.allow ?? [],
            },
          }
        : {}),
      ...(project && env.worktree
        ? { worktree: { path: env.worktree.workdir, branch: env.worktree.branch } }
        : {}),
      reads: spec.askAll ? [] : (spec.reads ?? []),
    },
    review: reviewOf(spec),
    audience: { owner: !spec.askAll, voice: spec.chat?.voice ?? false },
    env: {
      now,
      zone: `${personZone()} (${zoneOffset(now)})`,
      platform: process.platform,
      runtimes: RUNTIMES,
      ...(env.boundary ? { boundary: env.boundary } : {}),
    },
    context: {
      memory: spec.chat?.memory ?? [],
      skills: skills.map((s) => ({ name: s.name, description: s.description, fits: fits.has(s) })),
      plugins: env.plugins ?? [],
      ...(project && env.project?.layout ? { layout: env.project.layout } : {}),
      checks: project ? (env.project?.checks ?? []) : [],
      ...(project && guide?.text ? { instructions: { files: guide.files, text: guide.text } } : {}),
      nested: project ? (guide?.nested ?? []) : [],
    },
  }
}

export const has = (f: PromptFacts, tool: string) => f.tools.names.includes(tool)
