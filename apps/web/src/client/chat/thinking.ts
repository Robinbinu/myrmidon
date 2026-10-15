import type { Effort, ModelOption, ThinkingChoice } from '../api.ts'
import { copy } from '../copy.ts'

export const THINKING_CHOICES: readonly ThinkingChoice[] = ['low', 'medium', 'high']

/** How the lead's model takes the thinking setting, for the thinking chip and the crew panel. */
export interface ThinkingFit {
  /** The choices to offer: those the model has. All of them when it takes none, as they still reach crewmates. */
  readonly offered: readonly ThinkingChoice[]
  /** The level the model is sent instead of the one picked, when they differ; `off` when it takes none. */
  readonly effective?: Effort | 'off'
  /** Why the model thinks other than as picked, to show beside the picker. */
  readonly note?: string
}

/**
 * What the thinking picker shows for `model` with `chosen` picked (none: Auto), from what the server says each level
 * is sent as on it (ModelOption.thinking). An unknown model is offered every level as is.
 */
export function thinkingFit(model: ModelOption | undefined, chosen: ThinkingChoice | undefined): ThinkingFit {
  if (!model) return { offered: THINKING_CHOICES }
  const thinking = model.thinking
  // A model that reasons with no level to set still thinks, as much as it decides: not off.
  if (!thinking && model.reasoning) {
    return { offered: THINKING_CHOICES, note: copy.teamControls.thinking.own(model.name) }
  }
  if (!thinking) {
    return { offered: THINKING_CHOICES, effective: 'off', note: copy.teamControls.thinking.none(model.name) }
  }
  const offered = THINKING_CHOICES.filter((c) => thinking.levels[c] === c)
  if (!chosen) {
    return thinking.unverified
      ? { offered, effective: 'off', note: copy.teamControls.thinking.unverified(model.name) }
      : { offered }
  }
  const effective = thinking.levels[chosen]
  if (effective === chosen) return { offered }
  return {
    offered,
    effective,
    note: copy.teamControls.thinking.clamped(
      model.name,
      copy.teamControls.effort[chosen].title,
      copy.teamControls.effortName[effective],
    ),
  }
}

/** The name of a level a model is actually sent. */
export const effectiveName = (effective: Effort | 'off') =>
  effective === 'off' ? copy.teamControls.thinking.off : copy.teamControls.effortName[effective]
