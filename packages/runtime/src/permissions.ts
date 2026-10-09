import {
  type AgentRole,
  effectivePreset,
  type PermissionLevels,
  type PermissionPreset,
  projectLevelFrom,
} from '@myrmidon/protocol'
import { speaksForColony } from './patterns.ts'
import type { ColonySpec } from './spec.ts'

/**
 * A bare colony's rules (`myr run`, tests), from before the permission model: commands and edits run, MCP tools that
 * change things ask, nothing else does.
 */
const BARE: PermissionLevels['global'] = {
  preset: 'auto',
  rules: [{ kind: 'command', target: '*', decision: 'allow' }],
}

/** The permission levels a round runs under: its own, or a bare colony's with the project it names. */
export function levelsOf(spec: Pick<ColonySpec, 'permissions' | 'chat'>): PermissionLevels {
  if (spec.permissions) return spec.permissions
  const project = spec.chat?.project?.permissions
  return { global: BARE, ...(project ? { project: projectLevelFrom(project) } : {}) }
}

/** The preset a round runs under (see `effectivePreset`). */
export function presetOf(spec: Pick<ColonySpec, 'permissions' | 'chat'>): PermissionPreset {
  return effectivePreset(levelsOf(spec)).preset
}

/** The lead is the agent that speaks for the chat; everyone else (workers, crewmates, swarm peers) is crew. */
export function roleOf(spec: ColonySpec, agent: string): AgentRole {
  const a = spec.agents.find((x) => x.name === agent)
  return a && speaksForColony(spec, a) ? 'lead' : 'crew'
}
