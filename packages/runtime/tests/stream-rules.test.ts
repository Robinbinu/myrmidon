import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventPayloads } from '@myrmidon/protocol'
import { foldColony } from '@myrmidon/protocol'
import {
  bootRuntime,
  ChatService,
  ColonyRun,
  checkRuleFile,
  ModelResolver,
  parseColonySpec,
  parseStreamRule,
  RuleExistsError,
  readProjectInstructions,
  roundOutputs,
  type StreamRule,
  type StreamRuleFire,
  StreamRuleGuard,
  StreamRuleStore,
} from '../src/index.ts'
import type { StreamFn } from '../src/omp/agent-core.ts'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as LlmContext,
  Model,
  ToolCall,
} from '../src/omp/ai.ts'
import { AssistantMessageEventStream } from '../src/omp/ai.ts'
import { createMockModel } from '../src/omp/mock.ts'
import { prompts } from '../src/prompts.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-stream-rules-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const ruleFile = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}\n`
const rule = (name: string, fm: string, body = `Follow ${name}.`): StreamRule => {
  const parsed = parseStreamRule(name, ruleFile(fm, body), join(home, 'rules', `${name}.md`), 'user')
  if (!parsed) throw new Error(`not a stream rule: ${name}`)
  return parsed
}

const MODEL = { id: 'scripted', provider: 'test', api: 'test' } as unknown as Model

/** One block of a scripted reply: text in deltas, or a tool call whose arguments arrive in two pieces. */
type Block = { text: string[] } | { tool: string; args: Record<string, unknown> }

interface Call {
  readonly context: LlmContext
  /** What the scripted provider sent before it saw its request aborted. */
  readonly sent: string[]
  aborted: boolean
}

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * A scripted model that streams as a provider does, a delta at a time with a pause between, and stops once its
 * request is aborted, so a test sees what a stop cut off. `replies[n]` answers the n-th call.
 */
function scripted(replies: readonly Block[][]) {
  const calls: Call[] = []
  const stream: StreamFn = (_model, context, options) => {
    const out = new AssistantMessageEventStream()
    const call: Call = { context, sent: [], aborted: false }
    calls.push(call)
    const blocks = replies[calls.length - 1] ?? [{ text: ['done'] }]
    void (async () => {
      const content: AssistantMessage['content'] = []
      const partial = {
        role: 'assistant',
        content,
        api: 'test',
        provider: 'test',
        model: 'scripted',
        usage: USAGE,
        stopReason: 'stop',
        timestamp: Date.now(),
      } as AssistantMessage
      const stopped = async () => {
        await Bun.sleep(2)
        if (!options?.signal?.aborted) return false
        call.aborted = true
        out.push({ type: 'error', reason: 'aborted', error: { ...partial, stopReason: 'aborted' } })
        return true
      }
      out.push({ type: 'start', partial })
      for (const block of blocks) {
        const index = content.length
        if ('text' in block) {
          content.push({ type: 'text', text: '' })
          out.push({ type: 'text_start', contentIndex: index, partial })
          for (const delta of block.text) {
            if (await stopped()) return
            ;(content[index] as { text: string }).text += delta
            call.sent.push(delta)
            out.push({ type: 'text_delta', contentIndex: index, delta, partial })
          }
          out.push({ type: 'text_end', contentIndex: index, content: block.text.join(''), partial })
          continue
        }
        const json = JSON.stringify(block.args)
        const call_: ToolCall = {
          type: 'toolCall',
          id: `c${calls.length}-${index}`,
          name: block.tool,
          arguments: {},
        }
        content.push(call_)
        out.push({ type: 'toolcall_start', contentIndex: index, partial })
        // The first piece parses to the arguments' first key only, as a provider's partial JSON would.
        const [firstKey] = Object.keys(block.args)
        const steps: [string, Record<string, unknown>][] = [
          [json.slice(0, json.length >> 1), firstKey ? { [firstKey]: block.args[firstKey] } : {}],
          [json.slice(json.length >> 1), block.args],
        ]
        for (const [delta, args] of steps) {
          if (await stopped()) return
          call.sent.push(delta)
          call_.arguments = args
          out.push({ type: 'toolcall_delta', contentIndex: index, delta, partial })
        }
        out.push({ type: 'toolcall_end', contentIndex: index, toolCall: call_, partial })
      }
      if (await stopped()) return
      partial.stopReason = content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop'
      out.push({ type: 'done', reason: partial.stopReason as 'stop' | 'toolUse', message: partial })
    })()
    return out
  }
  return { stream, calls }
}

const ASK: LlmContext = {
  systemPrompt: ['You help.'],
  messages: [{ role: 'user', content: 'Write the helper.', timestamp: 1 }],
}

/** Sends one request through the guard and collects what the agent loop would see. */
async function send(guarded: StreamFn, context = ASK) {
  const events: AssistantMessageEvent[] = []
  const stream = await guarded(MODEL, context, {})
  for await (const e of stream) events.push(e)
  return { events, result: await stream.result() }
}

function guard(rules: readonly StreamRule[], retries = 3) {
  const fired: StreamRuleFire[] = []
  const g = new StreamRuleGuard({ retries, cwd: () => home, onFire: (f) => fired.push(f) })
  g.newTurn(rules)
  return { g, fired }
}

const textOf = (m: AssistantMessage) => m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
const lastUser = (c: LlmContext) => {
  const m = c.messages.at(-1)
  return m?.role === 'user' ? (typeof m.content === 'string' ? m.content : '') : ''
}

test('a rule that matches mid-stream stops the reply and sends the request again with its guidance', async () => {
  const noEval = rule(
    'no-eval',
    'description: Never call eval\ncondition: "\\\\beval\\\\("\nscope: text',
    'Never use `eval`; parse the input instead.',
  )
  const model = scripted([
    [{ text: ['Sure, ', 'just call eval(input)', ' and return it', ' — easy.'] }],
    [{ text: ['Parse it with ', 'JSON.parse(input).'] }],
  ])
  const { g, fired } = guard([noEval])
  const { events, result } = await send(g.wrap(model.stream))

  // The first request was cut off where it matched: what came after never streamed.
  expect(model.calls).toHaveLength(2)
  expect(model.calls[0]?.aborted).toBe(true)
  expect(model.calls[0]?.sent.join('')).not.toContain('easy')
  // The agent loop saw the reply restart (a second `start`) and nothing of the first attempt after the match.
  expect(events.filter((e) => e.type === 'start')).toHaveLength(2)
  const deltas = events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : []))
  expect(deltas).not.toContain('just call eval(input)')
  expect(deltas.join('')).toContain('JSON.parse')
  expect(textOf(result)).toBe('Parse it with JSON.parse(input).')
  // The retry is the same request with the rule's guidance after it; the abandoned text is not in it.
  const retry = model.calls[1]?.context as LlmContext
  expect(retry.messages).toHaveLength(ASK.messages.length + 1)
  expect(lastUser(retry)).toContain('<system-interrupt reason="rule_violation" rule="no-eval"')
  expect(lastUser(retry)).toContain('Never use `eval`; parse the input instead.')
  expect(JSON.stringify(retry.messages)).not.toContain('Sure, ')
  expect(fired.map((f) => [f.rule.name, f.source])).toEqual([['no-eval', 'text']])
  expect(fired[0]?.path.endsWith('rules/no-eval.md')).toBe(true)
})

test('output no rule matches streams through untouched, in one request', async () => {
  const noEval = rule('no-eval', 'condition: "\\\\beval\\\\("\nscope: text')
  const blocks: Block[][] = [
    [{ text: ['Parse it ', 'with JSON.parse.'] }, { tool: 'fs_write', args: { path: 'a.ts', content: 'x' } }],
  ]
  const plain = scripted(blocks)
  const watched = scripted(blocks)
  const { g, fired } = guard([noEval])
  const bare = await send(plain.stream)
  const kept = await send(g.wrap(watched.stream))
  expect(watched.calls).toHaveLength(1)
  expect(watched.calls[0]?.aborted).toBe(false)
  expect(fired).toEqual([])
  // Event for event what the provider sent, apart from the time each reply was stamped with.
  const strip = (es: AssistantMessageEvent[]) =>
    es.map((e) => ({ type: e.type, ...('delta' in e ? { delta: e.delta } : {}) }))
  expect(strip(kept.events)).toEqual(strip(bare.events))
  expect(kept.result.content).toEqual(bare.result.content)
})

test('stops are capped per turn, each rule stops a request once, and a new turn starts the count again', async () => {
  const noTodo = rule('no-todo', 'condition: TODO\nscope: text', 'Finish it now; no TODOs.')
  // Every reply breaks the rule, retries included.
  const model = scripted(Array.from({ length: 12 }, () => [{ text: ['// TODO', ' later'] }]))
  const { g, fired } = guard([noTodo], 2)
  const wrapped = g.wrap(model.stream)

  // A rule stops one request at most: the reply that breaks it again after its guidance goes through.
  const first = await send(wrapped)
  expect(model.calls).toHaveLength(2)
  expect(textOf(first.result)).toBe('// TODO later')
  // The second step of the turn uses the last stop the turn may make; the third is not checked at all.
  await send(wrapped)
  expect(model.calls).toHaveLength(4)
  await send(wrapped)
  expect(model.calls).toHaveLength(5)
  expect(model.calls[4]?.aborted).toBe(false)
  expect(fired).toHaveLength(2)

  g.newTurn([noTodo])
  await send(wrapped)
  expect(model.calls).toHaveLength(7)
  expect(fired).toHaveLength(3)
})

test('rules apply to tool-call arguments when their scope says so, matched on what the call writes', async () => {
  const noAny = rule(
    'ts-no-any',
    'condition: ": any|as any"\nscope: ["tool:fs_write(*.ts)", "tool:fs_edit(*.ts)"]',
    'Use `unknown`, not `any`.',
  )
  const proseOnly = rule('no-rm', 'condition: rm -rf\nscope: text')
  const shell = rule('no-force-push', 'condition: "push --force"\nscope: tool:shell')
  const model = scripted([
    [{ tool: 'fs_write', args: { path: 'src/a.ts', content: 'export const x: any = 1\n' } }],
    [{ tool: 'fs_write', args: { path: 'src/a.ts', content: 'export const x: unknown = 1\n' } }],
    // Prose-only and file-scoped rules leave other calls alone.
    [
      { tool: 'shell', args: { command: 'rm -rf build' } },
      { tool: 'fs_write', args: { path: 'notes.md', content: 'x: any' } },
    ],
    [{ tool: 'shell', args: { command: 'git push --force origin main' } }],
    [{ tool: 'shell', args: { command: 'git push origin main' } }],
  ])
  const { g, fired } = guard([noAny, proseOnly, shell])
  const wrapped = g.wrap(model.stream)

  const write = await send(wrapped)
  expect(model.calls).toHaveLength(2)
  expect(fired[0]).toMatchObject({ source: 'tool', tool: 'fs_write' })
  expect(fired[0]?.rule.name).toBe('ts-no-any')
  const written = write.result.content.find((c) => c.type === 'toolCall') as ToolCall
  expect(written.arguments).toEqual({ path: 'src/a.ts', content: 'export const x: unknown = 1\n' })
  // The call that broke the rule was never finished: no tool-call end for it reached the agent loop.
  const ends = write.events.flatMap((e) => (e.type === 'toolcall_end' ? [e.toolCall.arguments] : []))
  expect(ends).toEqual([{ path: 'src/a.ts', content: 'export const x: unknown = 1\n' }])

  await send(wrapped)
  expect(model.calls).toHaveLength(3)
  expect(fired).toHaveLength(1)

  await send(wrapped)
  expect(model.calls).toHaveLength(5)
  expect(fired.map((f) => [f.rule.name, f.tool])).toEqual([
    ['ts-no-any', 'fs_write'],
    ['no-force-push', 'shell'],
  ])
})

test('rules come from the person’s folder and the project’s, and stay out of the project’s instructions', () => {
  const project = join(home, 'app')
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(home, 'rules', 'mine.md'), ruleFile('condition: mine\ndescription: Mine', 'Mine.'))
  write(join(home, 'rules', 'shared.md'), ruleFile('condition: person', 'From the person.'))
  write(join(home, 'rules', 'off.md'), ruleFile('condition: off\nenabled: false', 'Off.'))
  write(join(home, 'rules', 'judged.md'), ruleFile('question: "Is it rude?"', 'Be kind.'))
  write(join(project, '.myrmidon', 'rules', 'shared.md'), ruleFile('condition: project', 'From the project.'))
  write(
    join(project, '.omp', 'rules', 'omp-rule.md'),
    ruleFile('condition: omp\ndescription: An omp rule', 'From omp.'),
  )
  write(
    join(project, '.cursor', 'rules', 'style.mdc'),
    ruleFile('description: Style guide\nalwaysApply: false', 'Style.'),
  )
  write(join(project, 'AGENTS.md'), 'Project notes.')

  const rules = new StreamRuleStore(home).list(project)
  expect(rules.map((r) => r.name).sort()).toEqual(['mine', 'omp-rule', 'shared'])
  // A project's rule of the same name wins over the person's.
  expect(rules.find((r) => r.name === 'shared')?.content).toBe('From the project.')
  expect(
    new StreamRuleStore(home)
      .list()
      .map((r) => r.name)
      .sort(),
  ).toEqual(['mine', 'shared'])

  // Stream rules watch output; they are not instructions, and other rules stay where they were.
  const instructions = readProjectInstructions(project)
  expect(instructions?.rules.map((r) => r.name)).toEqual(['style'])
  expect(instructions?.text).not.toContain('From omp.')
  expect(instructions?.text).not.toContain('From the project.')
})

test('a rule is saved only when Myrmidon can enforce it, and lands where the person chose', () => {
  const store = new StreamRuleStore(home)
  const good = ruleFile(
    'name: no-eval\ndescription: "No eval"\ncondition: "\\\\beval\\\\("\nscope: "text"',
    'Never use eval.',
  )
  expect(checkRuleFile('no-eval', good).condition).toEqual(['\\beval\\('])
  expect(() => checkRuleFile('x', ruleFile('question: "Rude?"', 'Be kind.'))).toThrow(/condition/)
  expect(() => checkRuleFile('x', ruleFile('condition: "(unclosed"', 'x'))).toThrow(/compile/)
  expect(() => checkRuleFile('x', ruleFile('condition: x', ''))).toThrow(/guidance/)

  const path = store.write('No Eval!', good, 'person')
  expect(path).toBe(join(home, 'rules', 'no-eval.md'))
  expect(store.target('no-eval', 'person').exists).toBe(true)
  const project = join(home, 'app')
  mkdirSync(project)
  expect(store.write('no-eval', good, 'project', project)).toBe(
    join(project, '.myrmidon', 'rules', 'no-eval.md'),
  )
  expect(existsSync(join(project, '.myrmidon', 'rules', 'no-eval.md'))).toBe(true)
  expect(() => store.write('no-eval', good, 'project')).toThrow(/project/)
})

test('a drafted rule is checked against what the round wrote, as the live check reads it', () => {
  const events = [
    {
      seq: 3,
      type: 'llm/response',
      payload: {
        agent: 'solo',
        model: 'm',
        text: '',
        toolCalls: [{ id: 'c1', name: 'reply_user', arguments: { text: 'Great question! Here it is.' } }],
        stopReason: 'toolUse',
      } satisfies EventPayloads['llm/response'],
    },
    {
      seq: 1,
      type: 'llm/response',
      payload: { agent: 'solo', model: 'm', text: 'old round', toolCalls: [], stopReason: 'stop' },
    },
  ] as never
  const outputs = roundOutputs(events, 2, home)
  // Only this round, and a reply tool read as the text it sends.
  expect(outputs.map((o) => [o.subject, o.content])).toEqual([
    ['`reply_user` call', 'Great question! Here it is.'],
  ])
})

test('in a round, a stopped tool call never runs, its rewrite does, and the stop is logged', async () => {
  const runtime = await bootRuntime(home)
  try {
    mkdirSync(join(home, 'rules'), { recursive: true })
    writeFileSync(
      join(home, 'rules', 'ts-no-any.md'),
      ruleFile(
        'description: No any in TypeScript\ncondition: ": any"\nscope: "tool:fs_write(*.ts)"',
        'Use `unknown`.',
      ),
    )
    const seen: LlmContext[] = []
    const mock = createMockModel({
      handler: (ctx: LlmContext) => {
        seen.push(ctx)
        const guided = JSON.stringify(ctx.messages).includes('system-interrupt')
        const wrote = ctx.messages.some((m) => m.role === 'toolResult')
        if (wrote) return { content: ['done'] }
        return {
          content: [
            {
              type: 'toolCall',
              name: 'fs_write',
              arguments: {
                path: 'a.ts',
                content: guided ? 'const x: unknown = 1\n' : 'const x: any = 1\n',
              },
            },
          ],
        }
      },
    })
    const resolver = new ModelResolver()
    resolver.register('mock/solo', { model: mock.model, streamFn: mock.stream })
    const spec = parseColonySpec({
      name: 'Rules',
      mission: 'Write a.ts.',
      agents: [{ name: 'solo', model: 'mock/solo', tools: ['fs_write'] }],
      budget: { wall: '20s' },
    })
    const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200, rules: new StreamRuleStore(home) })
    await run.start()
    await run.done
    expect(readFileSync(join(run.workspace.workdir('solo'), 'a.ts'), 'utf8')).toBe('const x: unknown = 1\n')
    const log = await runtime.ctx.log.read(run.id)
    const fired = log.filter((e) => e.type === 'rule/fired').map((e) => e.payload)
    expect(fired).toEqual([
      {
        agent: 'solo',
        rule: 'ts-no-any',
        description: 'No any in TypeScript',
        source: 'tool',
        tool: 'fs_write',
        path: expect.stringContaining('ts-no-any.md'),
      },
    ])
    // The stopped attempt is not part of the record: one write, from the reply that kept to the rule.
    const writes = log.filter((e) => e.type === 'tool/call')
    expect(writes).toHaveLength(1)
    expect(JSON.stringify(log.filter((e) => e.type === 'llm/response'))).not.toContain(': any')
    const guidance = seen
      .flatMap((c) => c.messages)
      .filter((m) => m.role === 'user' && String(m.content).includes('<system-interrupt'))
    expect(guidance.length).toBeGreaterThan(0)
    expect(String(guidance[0]?.content)).toContain('rule="ts-no-any"')
  } finally {
    await runtime.dispose()
  }
})

test('/rule: the lead model drafts a rule from the complaint, retries until it catches the reply, and it is saved', async () => {
  const runtime = await bootRuntime(home)
  try {
    const drafts: string[] = []
    const lead = createMockModel({
      handler: (ctx: LlmContext) => {
        if (ctx.systemPrompt?.includes(prompts.streamRules.draftSystem)) {
          const ask = String(ctx.messages[0]?.content)
          drafts.push(ask)
          // The first draft misses (wrong scope); the feedback sends it back, and the second catches the reply.
          const scope = drafts.length === 1 ? 'text' : 'tool:reply_user'
          return {
            content: [
              JSON.stringify({
                name: 'No Flattery',
                description: 'Never open with flattery',
                condition: '(?i)great question',
                scope,
                body: 'Answer directly, without praising the question.',
              }),
            ],
          }
        }
        return {
          content: [
            {
              type: 'toolCall',
              name: 'reply_user',
              arguments: { text: 'Great question! It is 4.', final: true },
            },
          ],
        }
      },
    })
    const resolver = new ModelResolver()
    resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
    const rules = new StreamRuleStore(home)
    const chats = new ChatService(runtime, { resolver, classify: async () => 'answer', rules })
    const { chatId, colonyId } = await chats.send('What is 2+2?', {
      mode: 'orchestrated',
      leadModel: 'mock/lead',
      roster: [],
      judgeModel: 'mock/lead',
    })
    for (let i = 0; i < 200; i++) {
      const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
      if (s.status !== 'running' && s.status !== 'created') break
      await Bun.sleep(25)
    }

    const draft = await chats.draftRule(chatId, 'stop flattering me')
    expect(drafts).toHaveLength(2)
    // The model saw the reply and the complaint, then why its first rule failed.
    expect(drafts[0]).toContain('Great question! It is 4.')
    expect(drafts[0]).toContain('stop flattering me')
    expect(drafts[1]).toContain('Failed attempts')
    expect(draft).toMatchObject({ name: 'no-flattery', matched: true, scope: ['tool:reply_user'] })
    expect(draft.text).toContain('condition: "(?i)great question"')

    const saved = await chats.saveRule({ name: draft.name, text: draft.text, where: 'person', chatId })
    expect(saved.path).toBe(join(home, 'rules', 'no-flattery.md'))
    expect(rules.list().map((r) => r.name)).toEqual(['no-flattery'])
    await expect(
      chats.saveRule({ name: draft.name, text: draft.text, where: 'person' }),
    ).rejects.toBeInstanceOf(RuleExistsError)
    await chats.saveRule({ name: draft.name, text: draft.text, where: 'person', replace: true })
    await expect(
      chats.saveRule({ name: draft.name, text: draft.text, where: 'project', chatId }),
    ).rejects.toThrow(/no project/)
    await chats.stopAll()
  } finally {
    await runtime.dispose()
  }
})
