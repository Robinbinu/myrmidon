import type { Model } from './omp/ai.ts'
import { clampThinkingLevelForModel, getSupportedEfforts } from './omp/catalog.ts'
import { thinkingFor } from './patterns.ts'
import type { AgentSpec, ColonySpec } from './spec.ts'

/** omp's thinking efforts, least to most. */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The levels the person picks from (team.thinking); Auto is the absence of one. */
export const THINKING_CHOICES = ['low', 'medium', 'high'] as const
export type ThinkingChoice = (typeof THINKING_CHOICES)[number]

/** What the thinking picker needs to know of a model: what each choice becomes on it. */
export interface ModelThinking {
  /** The effort each choice is sent as: itself when the model has it, else the nearest it has. */
  readonly levels: Readonly<Record<ThinkingChoice, Effort>>
  /** omp only guesses the model reasons (a host that lists no capabilities): Auto leaves its thinking off. */
  readonly unverified?: true
}

/**
 * The effort a model call asks for, or none. A model without a thinking dial (no reasoning, or reasoning it sets
 * itself) gets none, so no thinking field reaches its API; a level the model lacks becomes the nearest one below it
 * (its lowest when all are above), as omp's sessions clamp, since omp refuses an unsupported level outright. `chosen`
 * is whether the person picked the level: Auto never opts a model omp has not verified into thinking, as in omp.
 */
export function effortFor(model: Model, wanted: Effort, chosen: boolean): Effort | undefined {
  if (!chosen && model.thinking?.unverified) return undefined
  return clampThinkingLevelForModel(model, wanted as never) as Effort | undefined
}

/**
 * How hard `model` thinks for `agent` in this round: its role's level (thinkingFor) as `model` takes it. A quick
 * answer's low level is the role's, not the person's pick.
 */
export function agentEffort(model: Model, spec: ColonySpec, agent: AgentSpec): Effort | undefined {
  const chosen = spec.ultrathink === true || (spec.thinking !== undefined && spec.tier !== 'answer')
  return effortFor(model, thinkingFor(spec, agent), chosen)
}

/** What each thinking choice is sent as on `model`; none when the model takes no thinking level at all. */
export function modelThinking(model: Model): ModelThinking | undefined {
  if (getSupportedEfforts(model).length === 0) return undefined
  const levels = Object.fromEntries(
    THINKING_CHOICES.map((choice) => [choice, effortFor(model, choice, true) as Effort]),
  ) as Record<ThinkingChoice, Effort>
  return { levels, ...(model.thinking?.unverified ? { unverified: true as const } : {}) }
}
