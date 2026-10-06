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
import { AgentAvatar } from './ui/pixel.tsx'

type AgentNodeData = { view: AgentView; task?: string; selected: boolean }

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { view, task, selected } = data
  return (
    <div className={`agent-node status-${view.status}${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="handle" />
      <div className="agent-node-head">
        <AgentAvatar name={view.info.name} status={view.status} size={28} />
        <strong>{view.info.name}</strong>
        <span className="muted">{view.info.specialty ?? view.info.role}</span>
      </div>
      <div className="agent-node-model">{view.info.model}</div>
      <div className="agent-node-meta">
        <span>{view.status}</span>
        <span>turn {view.turns}</span>
        <span>{view.tokens.toLocaleString()} tok</span>
      </div>
      {task ? <div className="agent-node-task">{task}</div> : null}
      {view.detail ? <div className="agent-node-detail">{view.detail}</div> : null}
      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  )
}

const nodeTypes = { agent: AgentNode }

function recentLinks(events: readonly MyrEvent[], cursor: number): Set<string> {
  const keys = new Set<string>()
  let seen = 0
  for (let i = Math.min(events.length, cursor) - 1; i >= 0 && seen < 25; i--) {
    const e = events[i]
    if (!e) continue
    seen++
    if (e.type === 'mail/sent') {
      const p = e.payload as EventPayloads['mail/sent']
      keys.add(`${p.from}→${p.to}`)
    } else if (e.type === 'board/posted') {
      const p = e.payload as EventPayloads['board/posted']
      for (const m of p.mentions) keys.add(`${p.agent}→${m}`)
    }
  }
  return keys
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
        data: { view, task: task ? `${task.id}: ${task.subject}` : undefined, selected: selected === name },
      }
    })
    const hot = recentLinks(events, cursor)
    const edges: Edge[] = Object.entries(state.links).map(([key, count]) => {
      const [from, to] = key.split('→') as [string, string]
      const active = hot.has(key)
      return {
        id: key,
        source: from,
        target: to,
        label: String(count),
        animated: active,
        className: active ? 'edge-active' : 'edge',
        markerEnd: { type: MarkerType.ArrowClosed },
      }
    })
    return { nodes, edges }
  }, [state, events, cursor, selected, names])

  if (names.length === 0) return <div className="empty">No agents yet.</div>
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
    >
      <Background gap={24} size={1} />
    </ReactFlow>
  )
}
