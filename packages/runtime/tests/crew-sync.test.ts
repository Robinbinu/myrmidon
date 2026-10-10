import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import {
  bootRuntime,
  ChatService,
  type Classify,
  ModelResolver,
  type Runtime,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

/**
 * A crew chats like people in a group chat: a round does not end on someone mid-reply, and a message someone never
 * got to read waits for them in the next round instead of leaving them answering old news.
 */

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-sync-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})
type Step = MockContent[] | ((ctx: LlmContext) => MockContent[] | Promise<MockContent[]>)

function scripted(resolver: ModelResolver, ref: string, script: Step[]) {
  let call = 0
  const mock = createMockModel({
    handler: async (ctx: LlmContext) => {
      const step = script[call++]
      return { content: typeof step === 'function' ? await step(ctx) : (step ?? ['ok']) }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

const team: Classify = async () => 'team'
const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [{ role: 'friend', model: 'mock/friend' }],
  judgeModel: 'mock/lead',
}

/**
 * A chat like the person's: a crew talking, nobody reviewing the answer (unless `reviewer` says otherwise). Its
 * rounds close soon after the crew goes quiet; `quietMs` holds them open longer.
 */
function chatService(resolver: ModelResolver, reviewer: 'off' | 'always' = 'off', quietMs = 500) {
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), verification: { ...settings.get().verification, reviewer } })
  return new ChatService(runtime, { resolver, classify: team, settings, quietMs })
}

function judge(resolver: ModelResolver) {
  const m = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
}

async function waitFor(colonyId: string, until: (s: ColonyState) => boolean) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(25)
  }
  throw new Error('colony did not reach the expected state')
}

const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)
const seqOf = (log: readonly MyrEvent[], test: (e: MyrEvent) => boolean) => log.find(test)?.seq ?? -1
const friendIn = (ctx: LlmContext) =>
  /- ([a-z]+): friend \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''

test('a final answer lets a crewmate finish its reply, and everyone reads it before the round ends', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', {
          name: 'pub',
          members: [friend],
          text: `@${friend} brains in computers: thoughts?`,
        }),
      ]
    },
    [tool('reply_user', { text: 'We had a good chat.', final: true })],
    ['nice point'],
  ])
  scripted(resolver, 'mock/friend', [
    async () => {
      // Still writing when the lead has already summed up for the person.
      await Bun.sleep(400)
      return [tool('message', { to: 'pub', text: 'Understanding is the bottleneck, not hardware.' })]
    },
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Chat about brains in computers', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  const log = await events(colonyId)
  const said = log.find(
    (e) =>
      e.type === 'mail/sent' && (e.payload as EventPayloads['mail/sent']).body.startsWith('Understanding'),
  )
  expect(said).toBeDefined()
  const completed = seqOf(log, (e) => e.type === 'colony/completed')
  const final = seqOf(log, (e) => e.type === 'chat/reply')
  // The crewmate's reply came after the final answer and still made it, and the lead read it, before the round closed.
  expect(said?.seq ?? 0).toBeGreaterThan(final)
  const read = seqOf(
    log,
    (e) =>
      e.type === 'mail/delivered' &&
      (e.payload as EventPayloads['mail/delivered']).mail === said?.id &&
      (e.payload as EventPayloads['mail/delivered']).to === 'lead',
  )
  expect(read).toBeGreaterThan(0)
  expect(read).toBeLessThan(completed)
  expect(state.mail.find((m) => m.id === said?.id)?.delivered).toBe(true)
  // Nobody was cut off: the crewmate's turn ended on its own, before completion.
  const friendEnds = log.filter(
    (e) =>
      e.type === 'agent/turn' &&
      (e.payload as EventPayloads['agent/turn']).agent === friend &&
      (e.payload as EventPayloads['agent/turn']).phase === 'end',
  )
  expect(friendEnds.at(0)?.seq ?? Number.POSITIVE_INFINITY).toBeLessThan(completed)
  await chats.stopAll()
})

test('a message a crewmate never read when the round stopped is the first thing it sees in the next round', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  let release = () => {}
  let newTopic = false
  const seen: string[] = []
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [tool('create_group', { name: 'game', members: [friend], text: `@${friend} is it a book?` })]
    },
    [tool('message', { to: 'game', text: "YES! It's a BOOK!" })],
    // Waiting in round 1 (the stop may cut that step off), and a new topic once round 2 opens.
    ...Array.from({ length: 5 }, () => (ctx: LlmContext) => {
      const round2 = JSON.stringify(ctx.messages).includes('Now talk about brains')
      if (!round2 || newTopic) return ['waiting']
      newTopic = true
      return [tool('message', { to: 'game', text: 'New topic: brains in computers.' })]
    }),
  ])
  scripted(resolver, 'mock/friend', [
    // Round 1: busy with the first message when the answer arrives; the round is stopped before it reads it.
    () =>
      new Promise((resolve) => {
        release = () => resolve(['thinking'])
      }),
    (ctx) => {
      seen.push(JSON.stringify(ctx.messages))
      return ['caught up']
    },
    ['ok'],
  ])
  const chats = chatService(resolver)
  const first = await chats.send('Play twenty questions', config)
  // The answer reached the group while the crewmate was mid-turn.
  await waitFor(first.colonyId, (s) => s.mail.some((m) => m.body.startsWith('YES')))
  const book = (await waitFor(first.colonyId, () => true)).mail.find((m) => m.body.startsWith('YES'))
  await chats.stop(first.chatId)
  release()
  const stopped = await waitFor(first.colonyId, (s) => s.status !== 'running')
  expect(stopped.mail.find((m) => m.id === book?.id)?.readBy).not.toContain(friend)

  const second = await chats.send('Now talk about brains in computers', config, first.chatId)
  const state = await waitFor(
    second.colonyId,
    (s) => seen.length > 0 && s.mail.some((m) => m.body.startsWith('New')),
  )
  // Its first turn of the new round opens with what it missed, marked as older than the new topic.
  const prompt = seen[0] ?? ''
  expect(prompt).toContain('Messages you had not read yet')
  expect(prompt).toContain("YES! It's a BOOK!")
  expect(prompt.indexOf("YES! It's a BOOK!")).toBeLessThan(prompt.indexOf('New topic'))
  await waitFor(
    second.colonyId,
    (s) => s.mail.find((m) => m.id === book?.id)?.readBy.includes(friend) ?? false,
  )
  expect(state.mail.length).toBeGreaterThan(0)
  await chats.stopAll()
})

test('after the final answer, goodbyes do not set off more goodbyes: the round winds down and closes', async () => {
  const resolver = new ModelResolver()
  const names: string[] = []
  const seen: string[] = []
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      names.push(
        ...[...(ctx.systemPrompt?.join('\n') ?? '').matchAll(/- ([a-z]+): (?:friend|pal) \(/g)].map(
          (m) => m[1] as string,
        ),
      )
      return [
        tool('create_group', {
          name: 'pub',
          members: names,
          text: `@${names[0]} @${names[1]} brains in computers?`,
        }),
      ]
    },
    [tool('reply_user', { text: 'We had a good chat.', final: true })],
  ])
  // Two crewmates who say GG to anything that wakes them, as polite models do.
  const gg = (who: string) => (ctx: LlmContext) => {
    seen.push(`${who}: ${JSON.stringify(ctx.messages.at(-1))}`)
    return [tool('message', { to: 'pub', text: `GG, great chat from ${who}!` })]
  }
  scripted(resolver, 'mock/friend', [
    async (ctx) => {
      await Bun.sleep(300)
      return gg('friend')(ctx)
    },
    ...Array.from({ length: 30 }, () => gg('friend')),
  ])
  scripted(resolver, 'mock/pal', [
    async (ctx) => {
      await Bun.sleep(300)
      return gg('pal')(ctx)
    },
    ...Array.from({ length: 30 }, () => gg('pal')),
  ])
  const chats = chatService(resolver)
  const started = Date.now()
  const { colonyId } = await chats.send('Chat about brains in computers', {
    ...config,
    roster: [
      { role: 'friend', model: 'mock/friend' },
      { role: 'pal', model: 'mock/pal' },
    ],
  })
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  // It closed once the crew went quiet, long before the cap.
  expect(Date.now() - started).toBeLessThan(15_000)
  const goodbyes = state.mail.filter((m) => m.body.startsWith('GG'))
  // Each said goodbye once; nobody answered a goodbye with another.
  expect(goodbyes.length).toBeLessThanOrEqual(2)
  // And everyone read every goodbye: two ticks on all of them.
  for (const m of state.mail)
    expect({ body: m.body, delivered: m.delivered }).toEqual({ body: m.body, delivered: true })
  await chats.stopAll()
})

test('a busy agent reads everything that came in at its next step, and nothing waiting is lost when it signs off', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  let caughtUp = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', {
          name: 'pub',
          members: [friend],
          text: `@${friend} three facts about brains?`,
        }),
      ]
    },
    // A long step: the crewmate's three messages all arrive while it runs.
    async () => {
      await Bun.sleep(700)
      return [tool('list_tasks', {})]
    },
    (ctx) => {
      caughtUp = JSON.stringify(ctx.messages)
      return [tool('reply_user', { text: 'Three facts, noted.', final: true })]
    },
  ])
  scripted(resolver, 'mock/friend', [
    [
      tool('message', { to: 'pub', text: 'Fact one: 86 billion neurons.' }),
      tool('message', { to: 'pub', text: 'Fact two: 20 watts.' }),
      tool('message', { to: 'pub', text: 'Fact three: no clock.' }),
    ],
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Chat about brains', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  // All three reached the lead together at its next step, not one per step.
  for (const fact of ['Fact one', 'Fact two', 'Fact three']) expect(caughtUp).toContain(fact)
  // Every crewmate message was read by the lead: two ticks, nothing dropped.
  const facts = state.mail.filter((m) => m.body.startsWith('Fact'))
  expect(facts).toHaveLength(3)
  for (const m of facts) expect(m.readBy).toContain('lead')
  await chats.stopAll()
})

test('a message still queued when an agent signs off is read at its next turn, not dropped', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [tool('create_group', { name: 'pub', members: [friend], text: `@${friend} one last thought?` })]
    },
    // Writing its summary while the crewmate's message arrives: it is queued, not yet shown.
    async () => {
      await Bun.sleep(500)
      return [tool('reply_user', { text: 'Wrapping up.', final: true })]
    },
    ['noted'],
  ])
  scripted(resolver, 'mock/friend', [
    [tool('message', { to: 'pub', text: 'Last thought: sleep matters.' })],
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Chat about brains', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(state.mail.find((m) => m.body.startsWith('Last thought'))?.readBy).toContain('lead')
  await chats.stopAll()
})

const mailed = (state: ColonyState, body: string) => state.mail.some((m) => m.body === body)

test("the person's follow-up while the crew winds down is answered, and the round winds down again after", async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [tool('reply_user', { text: 'Brains run on about 20 watts.', final: true })]
    },
    // The follow-up: the lead asks its crewmate twice before it answers, as it would mid-round.
    () => [tool('message', { to: friend, text: 'How much does a GPU draw?' })],
    () => [tool('message', { to: friend, text: 'And a whole data centre?' })],
    [tool('reply_user', { text: 'A GPU draws hundreds of watts; a data centre, megawatts.', final: true })],
  ])
  scripted(resolver, 'mock/friend', [['noted'], ['noted']])
  // Long enough to write again while it winds down.
  const chats = chatService(resolver, 'off', 3_000)
  const { chatId, colonyId } = await chats.send('How much power does a brain use?', config)
  await waitFor(colonyId, (s) => s.chatMessages.some((m) => m.final))
  // Still winding down: the round is open, and the person asks more.
  const next = await chats.send('And computers?', config, chatId)
  expect(next.started).toBe(false)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  // The crew answered it as in any round: nothing was refused as "closing", and the answer reached the person.
  expect(mailed(state, 'How much does a GPU draw?')).toBe(true)
  expect(mailed(state, 'And a whole data centre?')).toBe(true)
  const log = await events(colonyId)
  const asked = seqOf(
    log,
    (e) => e.type === 'chat/user' && (e.payload as { text: string }).text === 'And computers?',
  )
  const answer = seqOf(
    log,
    (e) => e.type === 'chat/reply' && (e.payload as EventPayloads['chat/reply']).text.startsWith('A GPU'),
  )
  expect(answer).toBeGreaterThan(asked)
  expect(seqOf(log, (e) => e.type === 'colony/completed')).toBeGreaterThan(answer)
  await chats.stopAll()
}, 20_000)

test('a final answer given while the crew winds down is reviewed like any other', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', { name: 'pub', members: [friend], text: `@${friend} anything to add?` }),
        tool('reply_user', { text: 'Brains run on about 20 watts.', final: true }),
      ]
    },
    // The crewmate's point changes the answer, so the lead sends a better one.
    [
      tool('reply_user', {
        text: 'Brains run on about 20 watts, a fifth of the body’s energy.',
        final: true,
      }),
    ],
  ])
  scripted(resolver, 'mock/friend', [
    async () => {
      await Bun.sleep(300)
      return [tool('message', { to: 'pub', text: 'It is a fifth of the body’s energy.' })]
    },
    ['done'],
  ])
  judge(resolver)
  const chats = chatService(resolver, 'always')
  const { colonyId } = await chats.send('How much power does a brain use?', {
    ...config,
    judgeModel: 'mock/judge',
  })
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  const log = await events(colonyId)
  const better = seqOf(
    log,
    (e) => e.type === 'chat/reply' && (e.payload as EventPayloads['chat/reply']).text.includes('a fifth'),
  )
  expect(better).toBeGreaterThan(0)
  const reviews = log.filter((e) => e.type === 'verifier/requested')
  expect(reviews).toHaveLength(2)
  expect(reviews.at(-1)?.seq ?? 0).toBeGreaterThan(better)
  await chats.stopAll()
}, 20_000)

test("a team lead's final answer in plain text reaches the person without a stall nudge", async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [tool('create_group', { name: 'pub', members: [friend], text: `@${friend} brains or chips?` })]
    },
    // Holding text while the crewmate thinks: not an answer.
    ['I asked my friend and am waiting for their thoughts.'],
    ['Brains win on energy: about 20 watts against hundreds for a chip.'],
  ])
  scripted(resolver, 'mock/friend', [
    async () => {
      await Bun.sleep(300)
      return [tool('message', { to: 'pub', text: 'Brains, by a mile on energy.' })]
    },
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Brains or chips?', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(state.chatMessages.filter((m) => m.from !== 'user')).toEqual([
    expect.objectContaining({
      text: 'Brains win on energy: about 20 watts against hundreds for a chip.',
      final: true,
    }),
  ])
  expect(state.signals.filter((x) => x.kind === 'stall')).toHaveLength(0)
  await chats.stopAll()
}, 20_000)

test('signing off asks the model nothing more: no request is sent and then aborted', async () => {
  const resolver = new ModelResolver()
  let calls = 0
  const lead = createMockModel({
    handler: () => {
      calls += 1
      return { content: calls === 1 ? [tool('reply_user', { text: 'Done.', final: true })] : ['more'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  scripted(resolver, 'mock/friend', [])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Say done', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(calls).toBe(1)
  const responses = (await events(colonyId)).filter((e) => e.type === 'llm/response')
  expect(responses.map((e) => (e.payload as EventPayloads['llm/response']).stopReason)).toEqual(['toolUse'])
  await chats.stopAll()
}, 20_000)

test('a crewmate past its last word cannot start a group conversation either', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', { name: 'pub', members: [friend], text: `@${friend} anything to add?` }),
        tool('reply_user', { text: 'All done.', final: true }),
      ]
    },
  ])
  scripted(resolver, 'mock/friend', [
    async () => {
      await Bun.sleep(300)
      return [tool('message', { to: 'pub', text: 'Bye!' })]
    },
    [tool('create_group', { name: 'side', members: ['lead'], text: 'One more thing...' })],
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Wrap up', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(mailed(state, 'Bye!')).toBe(true)
  expect(mailed(state, 'One more thing...')).toBe(false)
  expect(state.groups.side).toBeUndefined()
  await chats.stopAll()
}, 20_000)

const toPerson = (state: ColonyState) =>
  state.chatMessages.filter((m) => m.from !== 'user').map((m) => ({ text: m.text, final: m.final }))

test("a lead's chat with its crew after the answer is not sent to the person as another answer", async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [tool('create_group', { name: 'pub', members: [friend], text: `@${friend} thoughts?` })]
    },
    [tool('reply_user', { text: 'We had a good chat.', final: true })],
    // The crewmate's late note wakes it, and it answers the crewmate, not the person.
    ['Nice point, thanks for adding that!'],
  ])
  scripted(resolver, 'mock/friend', [
    async () => {
      await Bun.sleep(400)
      return [tool('message', { to: 'pub', text: 'Understanding is the bottleneck.' })]
    },
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Chat about brains', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(toPerson(state)).toEqual([{ text: 'We had a good chat.', final: true }])
  await chats.stopAll()
}, 20_000)

test('a lead still waiting on one crewmate does not answer the person with its holding line', async () => {
  const resolver = new ModelResolver()
  const roleIn = (ctx: LlmContext, role: string) =>
    new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  scripted(resolver, 'mock/lead', [
    (ctx) => [
      tool('message', { to: roleIn(ctx, 'friend'), text: 'Your view?' }),
      tool('message', { to: roleIn(ctx, 'skeptic'), text: 'Your view?' }),
    ],
    ['Asked both of them.'],
    ['Got the first view; still waiting on the second one before I answer.'],
    [tool('reply_user', { text: 'Both views are in: brains win.', final: true })],
  ])
  scripted(resolver, 'mock/friend', [[tool('message', { to: 'lead', text: 'Brains.' })], ['ok']])
  scripted(resolver, 'mock/skeptic', [
    async () => {
      await Bun.sleep(1500)
      return [tool('message', { to: 'lead', text: 'Chips, actually.' })]
    },
    ['ok'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Brains or chips?', {
    ...config,
    roster: [
      { role: 'friend', model: 'mock/friend' },
      { role: 'skeptic', model: 'mock/skeptic' },
    ],
  })
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(toPerson(state)).toEqual([{ text: 'Both views are in: brains win.', final: true }])
  await chats.stopAll()
}, 20_000)

test('a message the person sends just as a wound-down round closes starts the next round and is answered', async () => {
  const resolver = new ModelResolver()
  // Naming the chat calls this model too (without tools), so each answer goes by what it is asked.
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      if (!ctx.tools?.length) return { content: ['Brains'] }
      const again = JSON.stringify(ctx.messages).includes('Wait, one more thing?')
      return {
        content: [tool('reply_user', { text: again ? 'Second answer.' : 'First answer.', final: true })],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  scripted(resolver, 'mock/friend', [])
  const chats = chatService(resolver)
  const log = runtime.ctx.log
  const append = log.appendOne.bind(log)
  let chatId = ''
  let racing: Promise<{ started: boolean; colonyId: string }> | undefined
  // The person's message lands between the round deciding to close and its completion being logged.
  log.appendOne = ((colony: never, draft: { type: string }) => {
    if (draft.type === 'colony/completed' && chatId && !racing)
      racing = chats.send('Wait, one more thing?', config, chatId)
    return append(colony, draft as never)
  }) as typeof log.appendOne
  const first = await chats.send('Say something', config)
  chatId = first.chatId
  await waitFor(first.colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  const next = await racing
  expect(next?.started).toBe(true)
  const state = await waitFor(
    first.colonyId,
    (s) => s.status === 'completed' && s.chatMessages.some((m) => m.text === 'Second answer.'),
  )
  const asked = state.chatMessages.find((m) => m.text === 'Wait, one more thing?')
  const completions = (await events(first.colonyId)).filter((e) => e.type === 'colony/completed')
  // It opened the second round, not a closed first one.
  expect(asked?.seq ?? 0).toBeGreaterThan(completions[0]?.seq ?? Number.POSITIVE_INFINITY)
  await chats.stopAll()
}, 20_000)

test('a limit hit while the crew winds down stops the round with its reason', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', { name: 'pub', members: [friend], text: `@${friend} anything?` }),
        tool('reply_user', { text: 'Done.', final: true }),
      ]
    },
  ])
  // Still talking when the round's time runs out.
  scripted(resolver, 'mock/friend', [
    async () => {
      await Bun.sleep(4000)
      return ['late']
    },
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Quick one', { ...config, wallMinutes: 0.03 })
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.status).toBe('stopped')
  expect(state.statusReason).toContain('wall time')
  await chats.stopAll()
}, 20_000)

test('a crewmate already told the chat is winding down hears it is open again when the person writes', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  let later = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', { name: 'pub', members: [friend], text: `@${friend} have a think` }),
        tool('reply_user', { text: 'First answer.', final: true }),
      ]
    },
    [tool('reply_user', { text: 'Second answer.', final: true })],
  ])
  scripted(resolver, 'mock/friend', [
    // Mid-step when the wind-down note arrives, and still when the person writes again.
    async () => {
      await Bun.sleep(800)
      return ['thinking']
    },
    (ctx) => {
      later = JSON.stringify(ctx.messages)
      return ['ok']
    },
  ])
  const chats = chatService(resolver, 'off', 3_000)
  const { chatId, colonyId } = await chats.send('Think about brains', config)
  await waitFor(colonyId, (s) => s.chatMessages.some((m) => m.final))
  await chats.send('And chips?', config, chatId)
  await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  // Told it is winding down, then that it is open again (and, after the next answer, winding down once more).
  expect(later).toContain('winding down')
  expect(later.indexOf('open again')).toBeGreaterThan(later.indexOf('winding down'))
  await chats.stopAll()
}, 20_000)

test('a second final answer while a review is still running waits for that review instead of failing', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  const lead: string[] = []
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', { name: 'pub', members: [friend], text: `@${friend} anything?` }),
        tool('reply_user', { text: 'First answer.', final: true }),
      ]
    },
    ...Array.from({ length: 4 }, () => (ctx: LlmContext) => {
      lead.push(JSON.stringify(ctx.messages.at(-1)))
      return [tool('reply_user', { text: 'Better answer.', final: true })]
    }),
  ])
  scripted(resolver, 'mock/friend', [[tool('message', { to: 'pub', text: 'One more point.' })], ['done']])
  // A reviewer slow enough that the second answer comes while it still reads the first.
  const slow = createMockModel({
    handler: async () => {
      await Bun.sleep(600)
      return { content: ['{"score": 0.9, "reasons": "complete"}'] }
    },
  })
  resolver.register('mock/judge', { model: slow.model, streamFn: slow.stream })
  const chats = chatService(resolver, 'always')
  const { colonyId } = await chats.send('Quick one', { ...config, judgeModel: 'mock/judge' })
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  expect(lead.join('\n')).not.toContain('already running')
  await chats.stopAll()
}, 20_000)

test('a third failed review stops the round: every turn ends, and nothing is left waiting on it', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', { name: 'pub', members: [friend], text: `@${friend} keep digging` }),
        tool('reply_user', { text: 'First answer.', final: true }),
      ]
    },
    ...Array.from({ length: 6 }, () => [tool('reply_user', { text: 'Another answer.', final: true })]),
  ])
  // Still busy when the round stops.
  scripted(
    resolver,
    'mock/friend',
    Array.from({ length: 80 }, () => async () => {
      await Bun.sleep(50)
      return [tool('read_notes', {})]
    }),
  )
  const failing = createMockModel({
    handler: () => ({ content: ['{"score": 0.1, "reasons": "incomplete"}'] }),
  })
  resolver.register('mock/judge', { model: failing.model, streamFn: failing.stream })
  const chats = chatService(resolver, 'always')
  const { colonyId } = await chats.send('Quick one', { ...config, judgeModel: 'mock/judge' })
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason).toBe('verification failed 3 times; see the last verdict')
  const log = await events(colonyId)
  const failed = log.filter(
    (e) => e.type === 'verifier/verdict' && !(e.payload as EventPayloads['verifier/verdict']).pass,
  )
  expect(failed).toHaveLength(3)
  expect(log.filter((e) => e.type === 'verifier/requested')).toHaveLength(3)
  // Shutting down finds the round already wound up, so nothing is left to wait for.
  const t = Date.now()
  await chats.stopAll()
  expect(Date.now() - t).toBeLessThan(1000)
  const after = (await events(colonyId)).slice(log.findIndex((e) => e.type === 'colony/stopped'))
  expect(after.filter((e) => e.type === 'tool/call')).toEqual([])
  for (const name of ['lead', friend]) {
    const turns = after.filter(
      (e) => e.type === 'agent/turn' && (e.payload as EventPayloads['agent/turn']).agent === name,
    )
    expect(turns.every((e) => (e.payload as EventPayloads['agent/turn']).phase === 'end')).toBe(true)
  }
}, 20_000)
