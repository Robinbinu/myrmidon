import type { AgentView, ColonyState, EventPayloads, MyrEvent } from '@myrmidon/protocol'
import {
  Background,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo } from 'react'
import { copy } from './copy.ts'
import { AgentAvatar } from './ui/pixel.tsx'
import { agentPhase } from './ui/status.ts'
import { MAP_ARROW_PX, MAP_LINK_WIDTH, MAP_RECENT_EVENTS } from './ui-config.ts'

type AgentNodeData = {
  view: AgentView
  status: ReturnType<typeof agentPhase>
  task?: string
  selected: boolean
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { view, task, selected } = data
  const { phase, detail } = data.status
  // The lead is named for its role, so the role would only repeat the name.
  const role = view.info.specialty ?? view.info.role
  return (
    <div className={`agent-node status-${phase}${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="handle" />
      <div className="agent-node-head">
        <AgentAvatar name={view.info.name} status={phase} size={28} />
        <strong>{view.info.name}</strong>
        {role !== view.info.name && <span className="muted">{role}</span>}
      </div>
      <div className="agent-node-model">{view.info.model}</div>
      <div className="agent-node-meta">
        <span>{copy.status.agent[phase]}</span>
        <span>{copy.colonyMap.turn(view.turns)}</span>
        <span>{copy.colonyMap.tokens(view.tokens.toLocaleString())}</span>
      </div>
      {task ? <div className="agent-node-task">{task}</div> : null}
      {detail ? <div className="agent-node-detail">{detail}</div> : null}
      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  )
}

const nodeTypes = { agent: AgentNode }

/** `from→to` keys of the messages among the latest events before the cursor, drawn as live links. */
function recentLinks(events: readonly MyrEvent[], cursor: number): Set<string> {
  const keys = new Set<string>()
  let seen = 0
  for (let i = Math.min(events.length, cursor) - 1; i >= 0 && seen < MAP_RECENT_EVENTS; i--) {
    const e = events[i]
    if (!e) continue
    seen++
    if (e.type === 'mail/sent') {
      const p = e.payload as EventPayloads['mail/sent']
      for (const to of p.members?.length ? p.members : [p.to]) keys.add(`${p.from}→${to}`)
    } else if (e.type === 'board/posted') {
      const p = e.payload as EventPayloads['board/posted']
      for (const m of p.mentions) keys.add(`${p.agent}→${m}`)
    } else if (e.type === 'task/changed') {
      const p = e.payload as EventPayloads['task/changed']
      if (p.task.assignee) keys.add(`${p.by}→${p.task.assignee}`)
    }
  }
  return keys
}

/** Two agents who wrote to each other: one line however many messages went which way. */
export interface CrewLink {
  readonly a: string
  readonly b: string
  /** Messages both ways together. */
  readonly count: number
  /** Whether `a` wrote to `b`, and `b` to `a`. */
  readonly toB: boolean
  readonly toA: boolean
}

/** Folds the crew's `from→to` message counts into one link per pair, leaving out anyone not on the map. */
export function crewLinks(links: Readonly<Record<string, number>>, agents: ReadonlySet<string>): CrewLink[] {
  const pairs = new Map<string, { a: string; b: string; count: number; toB: boolean; toA: boolean }>()
  for (const [key, count] of Object.entries(links)) {
    const [from, to] = key.split('→') as [string, string]
    if (!agents.has(from) || !agents.has(to) || from === to || count <= 0) continue
    const [a, b] = from < to ? [from, to] : [to, from]
    const pair = pairs.get(`${a}→${b}`) ?? { a, b, count: 0, toB: false, toA: false }
    pair.count += count
    if (from === a) pair.toB = true
    else pair.toA = true
    pairs.set(`${a}→${b}`, pair)
  }
  return [...pairs.values()]
}

/** A link's stroke width: thicker for more messages, on a log scale so one busy pair doesn't thin out the rest. */
export function linkWidth(count: number, busiest: number): number {
  const { min, max } = MAP_LINK_WIDTH
  if (busiest <= 1 || count <= 1) return min
  return min + ((max - min) * Math.log(Math.min(count, busiest))) / Math.log(busiest)
}

export function ColonyMap(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  cursor: number
  selected?: string
  onSelect(agent: string): void
}) {
  const { state, events, cursor, selected, onSelect } = props
  const names = Object.keys(state.agents)
  const { nodes, edges } = useMemo(() => {
    const radius = Math.max(170, names.length * 55)
    const nodes: Node<AgentNodeData>[] = names.map((name, i) => {
      const angle = (i / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2
      const view = state.agents[name] as AgentView
      const task = Object.values(state.tasks).find((t) => t.owner === name && t.status === 'in_progress')
      return {
        id: name,
        type: 'agent',
        position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
        data: {
          view,
          status: agentPhase(view, state),
          task: task ? `${task.id}: ${task.subject}` : undefined,
          selected: selected === name,
        },
      }
    })
    const hot = recentLinks(events, cursor)
    const links = crewLinks(state.links, new Set(names))
    const busiest = Math.max(1, ...links.map((l) => l.count))
    const y = new Map(nodes.map((n) => [n.id, n.position.y]))
    const edges: Edge[] = links.map((l) => {
      const active = hot.has(`${l.a}→${l.b}`) || hot.has(`${l.b}→${l.a}`)
      const width = linkWidth(l.count, busiest)
      // Arrowheads sized in px, not in line widths, so a thick link's arrow doesn't swallow the node it points at.
      const arrow = {
        type: MarkerType.ArrowClosed,
        markerUnits: 'userSpaceOnUse',
        width: MAP_ARROW_PX.base + width * MAP_ARROW_PX.perWidth,
        height: MAP_ARROW_PX.base + width * MAP_ARROW_PX.perWidth,
        ...(active ? { color: 'var(--accent-text)' } : {}),
      }
      // Lines leave a node's bottom and enter the next one's top, so drawing from the higher node keeps them from
      // looping around the nodes they join.
      const down = (y.get(l.a) ?? 0) <= (y.get(l.b) ?? 0)
      const [source, target] = down ? [l.a, l.b] : [l.b, l.a]
      const [toTarget, toSource] = down ? [l.toB, l.toA] : [l.toA, l.toB]
      return {
        id: `${l.a}→${l.b}`,
        source,
        target,
        label: String(l.count),
        // Inline: React Flow's own stylesheet sets 10px and outranks the app's layered CSS.
        labelStyle: { fontSize: 'var(--text-caption)' },
        ariaLabel: copy.colonyMap.link(l.a, l.b, l.count),
        animated: active,
        className: active ? 'edge-active' : 'edge',
        style: { strokeWidth: width },
        ...(toTarget ? { markerEnd: arrow } : {}),
        ...(toSource ? { markerStart: arrow } : {}),
      }
    })
    return { nodes, edges }
  }, [state, events, cursor, selected, names])

  if (names.length === 0) return <div className="empty">{copy.colonyMap.noAgents}</div>
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      nodesDraggable
      nodesConnectable={false}
      onNodeClick={(_, n) => onSelect(n.id)}
      proOptions={{ hideAttribution: true }}
      // Arrowheads take the link colour from the theme's tokens instead of the library's fixed grey.
      defaultMarkerColor={null}
    >
      <Background gap={24} size={1} />
    </ReactFlow>
  )
}
