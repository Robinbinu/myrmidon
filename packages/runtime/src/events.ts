import type SchemaType from '@deepseek-ai/schemastery'
import { type EventLog, type EventTypeDefinition, Schema } from '@myrmidon/core'

const str = () => Schema.string().required()
const strs = () => Schema.array(Schema.string()).default([])
// A nested object that may be absent; a bare Schema.object would fill in {} and then fail its required fields.
const optional = <S, T>(schema: SchemaType<S, T>) => Schema.union([schema, Schema.const(undefined as never)])
const oneOf = (...values: string[]) => Schema.union(values).required()

const usage = Schema.object({
  input: Schema.number().required(),
  output: Schema.number().required(),
  totalTokens: Schema.number().required(),
  cost: Schema.number(),
})

const task = Schema.object({
  id: str(),
  revision: Schema.natural().required(),
  subject: str(),
  description: Schema.string().default(''),
  status: oneOf('pending', 'in_progress', 'submitted', 'verified', 'rejected', 'deleted'),
  owner: Schema.string(),
  blockedBy: strs(),
  artifacts: strs(),
  assignee: Schema.string(),
  outputs: Schema.array(Schema.string()),
})

const presetOf = Schema.union(['read-only', 'ask', 'auto', 'full'])
const ruleTarget = {
  kind: oneOf('tool', 'edit', 'command', 'mcp-server', 'mcp-tool'),
  target: str(),
  who: Schema.union(['all', 'lead', 'crew']),
}
const rule = Schema.object({ ...ruleTarget, decision: oneOf('allow', 'ask', 'deny') })
const access = Schema.dict(Schema.boolean())
/** A level of the permission model (see protocol's permissions.ts). */
const permissionLevel = Schema.object({
  preset: presetOf,
  rules: Schema.array(rule).default([]),
  access: optional(Schema.object({ lead: optional(access), crew: optional(access) })),
})

const groups = optional(Schema.array(Schema.string()))
/** What a round's agents were told they may do (protocol's RoundAccess). */
const roundAccess = Schema.object({
  preset: presetOf,
  fullAccess: Schema.boolean(),
  reads: optional(Schema.array(Schema.string())),
  rules: optional(Schema.array(rule)),
  off: optional(Schema.object({ lead: groups, crew: groups })),
})

/** How a colony (or a chat round in it) was set up: everything needed to run or resume it. */
const colonySpec = Schema.object({
  name: str(),
  mission: str(),
  pattern: str(),
  agents: Schema.array(
    Schema.object({
      name: str(),
      role: str(),
      model: str(),
      tools: strs(),
      specialty: Schema.string(),
      focus: Schema.string(),
    }),
  ).required(),
  acceptance: Schema.array(Schema.any()).default([]),
  budget: Schema.object({
    wallMs: Schema.natural().required(),
    costUsd: Schema.number(),
    tokens: Schema.natural(),
    maxTurns: Schema.natural(),
  }),
  unsafeNoSandbox: Schema.boolean().default(false),
  chat: optional(
    Schema.object({
      chatId: str(),
      round: Schema.natural().required(),
      request: str(),
      history: Schema.string(),
      escalate: Schema.array(oneOf('solo', 'team')).default([]),
      memory: strs(),
      addressed: optional(Schema.array(str())),
      project: optional(
        Schema.object({
          id: str(),
          name: str(),
          path: str(),
          // Old logs hold the shape from before the permission model; new ones a project level.
          permissions: optional(
            Schema.union([
              Schema.object({
                mode: oneOf('auto', 'ask', 'read-only', 'full'),
                allow: Schema.array(Schema.string()).default([]),
                read: optional(Schema.array(Schema.string())),
              }),
              Schema.object({
                preset: presetOf,
                rules: Schema.array(rule).default([]),
                access: optional(Schema.object({ lead: optional(access), crew: optional(access) })),
                read: optional(Schema.array(Schema.string())),
              }),
            ]),
          ),
        }),
      ),
    }),
  ),
  team: optional(
    Schema.object({
      mode: oneOf('orchestrated', 'swarm', 'auto', 'manual'),
      maxWorkers: Schema.natural().required(),
      workerModels: strs(),
    }),
  ),
  tier: Schema.union(['answer', 'solo', 'team']),
  observerMs: Schema.natural(),
  thinking: Schema.union(['low', 'medium', 'high']),
  taskJudge: Schema.string(),
  disabledTools: Schema.array(str()),
  askTools: Schema.array(str()),
  allowTools: Schema.array(str()),
  askAll: Schema.boolean(),
  review: Schema.union(['off', 'auto', 'always']),
  fullAccess: Schema.boolean(),
  computerUse: Schema.boolean(),
  access: optional(roundAccess),
})

const defs: EventTypeDefinition[] = [
  { type: 'colony/created', version: 1, actors: ['system', 'user'], schema: colonySpec },
  { type: 'round/started', version: 1, actors: ['system', 'user'], schema: colonySpec },
  {
    type: 'colony/started',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      pid: Schema.natural(),
      hostname: Schema.string(),
      resumed: Schema.boolean(),
      models: Schema.dict(Schema.string()),
    }),
  },
  {
    type: 'agent/joined',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      agent: Schema.object({
        name: str(),
        role: str(),
        model: str(),
        tools: strs(),
        specialty: Schema.string(),
        focus: Schema.string(),
      }).required(),
      by: str(),
      focus: Schema.string().default(''),
    }),
  },
  {
    type: 'agent/error',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      agent: str(),
      model: str(),
      kind: oneOf('refusal', 'overflow', 'error'),
      message: str(),
      tokens: Schema.number(),
      window: Schema.number(),
    }),
  },
  {
    type: 'agent/dismissed',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), by: str(), reason: str() }),
  },
  {
    type: 'login/requested',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({ agent: str(), site: str(), url: str(), reason: str() }),
  },
  {
    type: 'login/finished',
    version: 1,
    actors: ['user', 'system'],
    schema: Schema.object({ agent: str(), outcome: oneOf('handed-back', 'timeout', 'stopped') }),
  },
  {
    type: 'safety/flagged',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), tool: str(), reason: str(), source: str() }),
  },
  {
    type: 'server/started',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({ agent: str(), name: str(), command: str(), url: str() }),
  },
  {
    type: 'server/stopped',
    version: 1,
    actors: ['agent', 'system'],
    schema: Schema.object({ name: str(), reason: str() }),
  },
  {
    type: 'memory/proposed',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      id: str(),
      agent: str(),
      text: str(),
      kind: oneOf('preference', 'decision', 'lesson', 'fact'),
      project: Schema.string(),
      why: Schema.string().default(''),
    }),
  },
  {
    type: 'hook/ran',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      event: oneOf('PreToolUse', 'PostToolUse', 'Stop'),
      agent: Schema.string(),
      tool: Schema.string(),
      command: str(),
      code: Schema.number().required(),
      ms: Schema.natural().required(),
      outcome: oneOf('ok', 'blocked', 'asked', 'feedback', 'failed'),
      message: Schema.string(),
    }),
  },
  {
    type: 'skill/used',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({ agent: str(), name: str(), file: Schema.string() }),
  },
  {
    type: 'memory/decided',
    version: 1,
    actors: ['user'],
    schema: Schema.object({ id: str(), kept: Schema.boolean().required() }),
  },
  {
    type: 'worktree/created',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), branch: str(), path: str() }),
  },
  {
    type: 'worktree/merged',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), files: strs() }),
  },
  {
    type: 'worktree/updated',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), files: strs() }),
  },
  {
    type: 'worktree/conflict',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), files: strs() }),
  },
  {
    type: 'worktree/closed',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), kept: Schema.boolean().required() }),
  },
  {
    type: 'approval/requested',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      id: str(),
      agent: str(),
      tool: str(),
      summary: str(),
      review: optional(
        Schema.object({
          kind: oneOf('file', 'commit', 'command', 'call'),
          title: str(),
          fields: Schema.array(
            Schema.object({
              key: str(),
              label: str(),
              value: Schema.string().default(''),
              format: oneOf('text', 'code', 'patch'),
              before: Schema.string(),
              editable: Schema.boolean().default(false),
            }),
          ).default([]),
        }),
      ),
      key: Schema.string(),
      grant: optional(Schema.union(['file', 'command'])),
      read: Schema.string(),
      sensitive: Schema.boolean(),
      offer: optional(Schema.array(Schema.object(ruleTarget))),
      why: optional(Schema.dict(Schema.any())),
      call: optional(Schema.dict(Schema.any())),
      role: Schema.union(['lead', 'crew']),
    }),
  },
  {
    type: 'approval/decided',
    version: 1,
    actors: ['user', 'system'],
    schema: Schema.object({
      id: str(),
      approved: Schema.boolean().required(),
      by: oneOf('person', 'timeout', 'stopped'),
      edits: optional(Schema.dict(Schema.string())),
      note: Schema.string(),
    }),
  },
  {
    type: 'skill/proposed',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      id: str(),
      name: str(),
      description: str(),
      body: str(),
      why: Schema.string().default(''),
      update: optional(Schema.object({ description: str(), body: str() })),
    }),
  },
  {
    type: 'skill/decided',
    version: 1,
    actors: ['user'],
    schema: Schema.object({ id: str(), kept: Schema.boolean().required() }),
  },
  {
    type: 'review/done',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ key: str(), agent: str(), tool: str(), output: Schema.string().default('') }),
  },
  {
    type: 'checkpoint/created',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ commit: str(), phase: oneOf('start', 'end'), round: Schema.natural() }),
  },
  {
    type: 'checkpoint/restored',
    version: 1,
    actors: ['user'],
    schema: Schema.object({
      commit: str(),
      undo: str(),
      changed: Schema.natural().required(),
      files: Schema.array(Schema.string()),
    }),
  },
  {
    type: 'permissions/changed',
    version: 1,
    actors: ['user'],
    schema: Schema.object({
      off: strs(),
      ask: strs(),
      allow: strs(),
      project: Schema.string(),
      askAll: Schema.boolean(),
      fullAccess: Schema.boolean(),
      interrupted: strs(),
      access: optional(roundAccess),
    }),
  },
  {
    type: 'plugin/event',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ plugin: str(), type: str(), data: Schema.dict(Schema.any()).default({}) }),
  },
  {
    type: 'agent/compacted',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      messages: Schema.natural().required(),
      tokens: Schema.natural().required(),
      summaryChars: Schema.natural().required(),
    }),
  },
  {
    type: 'agent/model',
    version: 1,
    actors: ['user'],
    schema: Schema.object({ agent: str(), model: str(), previous: str() }),
  },
  {
    type: 'tool/created',
    version: 1,
    actors: ['agent', 'system', 'user'],
    schema: Schema.object({
      agent: str(),
      name: str(),
      description: str(),
      inputs: Schema.array(
        Schema.object({
          name: str(),
          type: oneOf('string', 'number', 'boolean'),
          description: Schema.string().default(''),
          optional: Schema.boolean(),
        }),
      ).default([]),
      language: oneOf('typescript', 'python', 'bash', 'browser'),
      source: str(),
      library: Schema.boolean(),
    }),
  },
  {
    type: 'chat/user',
    version: 1,
    actors: ['user'],
    schema: Schema.object({
      text: str(),
      mode: Schema.union(['steer', 'queue']),
      attachments: Schema.array(str()).max(20),
      to: optional(Schema.array(str()).max(20)),
      /** Said aloud on a voice call: whoever answers is told their reply will be read aloud. */
      voice: optional(Schema.boolean()),
      /** What the agents should know that the chat does not show, e.g. a voice call's transcript. */
      context: optional(Schema.string().max(40_000)),
    }),
  },
  {
    type: 'chat/reply',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      text: str(),
      final: Schema.boolean().default(false),
      question: Schema.boolean(),
      assumption: Schema.string(),
      choices: Schema.array(
        Schema.object({
          question: str(),
          header: Schema.string(),
          options: Schema.array(Schema.object({ label: str(), description: Schema.string() })).required(),
          multiSelect: Schema.boolean(),
        }),
      ),
      plan: Schema.string(),
    }),
  },
  {
    type: 'chat/renamed',
    version: 1,
    actors: ['user', 'system'],
    // `auto`: Myrmidon named it from what it is about; anything else (the person, a channel, a schedule) is kept.
    schema: Schema.object({ title: str(), by: optional(Schema.union(['auto'])) }),
  },
  {
    type: 'chat/permissions',
    version: 1,
    actors: ['user'],
    schema: permissionLevel,
  },
  {
    type: 'chat/allowed',
    version: 1,
    actors: ['user'],
    schema: Schema.object({
      grants: Schema.array(oneOf('file', 'command')).default([]),
      reads: optional(Schema.array(Schema.string())),
    }),
  },
  {
    type: 'colony/escalated',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({ by: str(), to: oneOf('solo', 'team'), reason: str() }),
  },
  {
    type: 'colony/stopped',
    version: 1,
    actors: ['system', 'user'],
    schema: Schema.object({ reason: str() }),
  },
  { type: 'colony/failed', version: 1, actors: ['system'], schema: Schema.object({ reason: str() }) },
  {
    type: 'agent/status',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      agent: str(),
      status: oneOf('provisioning', 'ready', 'working', 'idle', 'completed', 'stopped', 'failed'),
      detail: Schema.string(),
    }),
  },
  {
    type: 'agent/turn',
    version: 1,
    actors: ['system'],
    schema: Schema.object({
      agent: str(),
      phase: oneOf('start', 'end'),
      turn: Schema.natural().required(),
      trigger: str(),
    }),
  },
  {
    type: 'llm/response',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      model: str(),
      text: Schema.string().default(''),
      thinking: Schema.string(),
      toolCalls: Schema.array(Schema.object({ id: str(), name: str(), arguments: Schema.any() })).default([]),
      usage,
      stopReason: str(),
      error: Schema.string(),
    }),
  },
  {
    type: 'tool/call',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      callId: str(),
      tool: str(),
      args: Schema.any(),
      readOnly: Schema.boolean(),
    }),
  },
  {
    type: 'computer/keyframe',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      blob: str(),
      app: str(),
      title: Schema.string().default(''),
      action: str(),
      label: Schema.string(),
      point: optional(Schema.object({ x: Schema.number().required(), y: Schema.number().required() })),
      width: Schema.number().required(),
      height: Schema.number().required(),
    }),
  },
  {
    type: 'computer/apps',
    version: 1,
    actors: ['user'],
    schema: Schema.object({
      apps: Schema.array(
        Schema.object({ bundleId: str(), name: str(), tier: oneOf('view', 'click', 'full') }),
      ).default([]),
    }),
  },
  {
    type: 'computer/control',
    version: 1,
    actors: ['agent', 'user', 'system'],
    schema: Schema.object({ agent: str(), app: Schema.string(), active: Schema.boolean().required() }),
  },
  {
    type: 'computer/blocked',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      reason: oneOf('install', 'grants'),
      missing: Schema.array(oneOf('accessibility', 'screen-recording')),
    }),
  },
  {
    type: 'browser/keyframe',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      blob: str(),
      url: Schema.string().default(''),
      title: Schema.string().default(''),
      action: oneOf('open', 'click', 'type', 'press'),
      label: Schema.string(),
      cursor: optional(Schema.object({ x: Schema.number().required(), y: Schema.number().required() })),
      box: optional(
        Schema.object({
          x: Schema.number().required(),
          y: Schema.number().required(),
          width: Schema.number().required(),
          height: Schema.number().required(),
        }),
      ),
      width: Schema.number().required(),
      height: Schema.number().required(),
    }),
  },
  {
    type: 'tool/result',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({
      agent: str(),
      callId: str(),
      tool: str(),
      ok: Schema.boolean().required(),
      output: Schema.string().default(''),
    }),
  },
  {
    type: 'board/posted',
    version: 1,
    actors: ['agent', 'user'],
    schema: Schema.object({ agent: str(), text: str(), mentions: strs(), replyTo: Schema.natural() }),
  },
  {
    type: 'note/appended',
    version: 1,
    actors: ['agent', 'user', 'system'],
    schema: Schema.object({
      agent: str(),
      text: str(),
      corrects: Schema.string(),
      section: Schema.union(['plan', 'decision', 'finding', 'status', 'user']),
    }),
  },
  {
    type: 'mail/sent',
    version: 1,
    actors: ['agent', 'user'],
    schema: Schema.object({
      from: str(),
      to: str(),
      subject: Schema.string().default(''),
      body: str(),
      replyTo: Schema.natural(),
      members: optional(Schema.array(Schema.string())),
    }),
  },
  {
    type: 'group/created',
    version: 1,
    actors: ['agent', 'user'],
    schema: Schema.object({ name: str(), members: strs(), by: str() }),
  },
  {
    type: 'group/changed',
    version: 1,
    actors: ['agent', 'user'],
    schema: Schema.object({ name: str(), add: strs(), remove: strs(), by: str() }),
  },
  {
    type: 'mail/delivered',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ mail: str(), to: str() }),
  },
  {
    type: 'task/changed',
    version: 1,
    actors: ['agent', 'system', 'verifier'],
    schema: Schema.object({ task, by: str(), reason: Schema.string() }),
  },
  {
    type: 'artifact/versioned',
    version: 1,
    actors: ['agent', 'user'],
    schema: Schema.object({
      name: str(),
      version: Schema.natural().required(),
      blob: str(),
      size: Schema.natural().required(),
      parentVersion: Schema.natural(),
      author: str(),
      mediaType: Schema.string().default('text/plain'),
    }),
  },
  {
    type: 'observer/signal',
    version: 1,
    actors: ['observer'],
    schema: Schema.object({
      kind: oneOf('deadline', 'budget', 'stall', 'unclaimed', 'blocked', 'conflict'),
      severity: oneOf('info', 'warn', 'critical'),
      facts: str(),
      targets: strs(),
    }),
  },
  {
    type: 'verifier/requested',
    version: 1,
    actors: ['agent', 'system'],
    schema: Schema.object({ target: str(), by: str() }),
  },
]

/** Registers every colony event type; returns one disposer for all of them. */
export function registerColonyEvents(log: EventLog): () => void {
  const disposers = defs.filter((d) => !log.registry.get(d.type)).map((d) => log.registerType(d))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
