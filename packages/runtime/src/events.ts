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

const defs: EventTypeDefinition[] = [
  {
    type: 'colony/created',
    version: 1,
    actors: ['system', 'user'],
    schema: Schema.object({
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
          project: optional(
            Schema.object({
              id: str(),
              name: str(),
              path: str(),
              permissions: optional(
                Schema.object({
                  mode: oneOf('auto', 'ask', 'read-only'),
                  allow: Schema.array(Schema.string()).default([]),
                }),
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
    }),
  },
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
    schema: Schema.object({ agent: str(), model: str(), kind: oneOf('refusal', 'error'), message: str() }),
  },
  {
    type: 'agent/dismissed',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ agent: str(), by: str(), reason: str() }),
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
    type: 'approval/requested',
    version: 1,
    actors: ['agent'],
    schema: Schema.object({ id: str(), agent: str(), tool: str(), summary: str() }),
  },
  {
    type: 'approval/decided',
    version: 1,
    actors: ['user', 'system'],
    schema: Schema.object({
      id: str(),
      approved: Schema.boolean().required(),
      by: oneOf('person', 'timeout', 'stopped'),
    }),
  },
  {
    type: 'checkpoint/created',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ commit: str(), phase: oneOf('start', 'end') }),
  },
  {
    type: 'checkpoint/restored',
    version: 1,
    actors: ['user'],
    schema: Schema.object({ commit: str(), undo: str(), changed: Schema.natural().required() }),
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
      language: oneOf('typescript', 'python', 'bash'),
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
    }),
  },
  { type: 'chat/renamed', version: 1, actors: ['user'], schema: Schema.object({ title: str() }) },
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
    schema: Schema.object({ agent: str(), callId: str(), tool: str(), args: Schema.any() }),
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
    schema: Schema.object({ agent: str(), text: str(), mentions: strs() }),
  },
  {
    type: 'note/appended',
    version: 1,
    actors: ['agent', 'user'],
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
    schema: Schema.object({ from: str(), to: str(), subject: Schema.string().default(''), body: str() }),
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
    schema: Schema.object({ task, by: str() }),
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
