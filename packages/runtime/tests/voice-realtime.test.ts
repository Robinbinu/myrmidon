import { afterEach, expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import type { ServerWebSocket } from 'bun'
import { ModelResolver } from '../src/models.ts'
import { prompts } from '../src/prompts.ts'
import type { CallChats, CallOutput } from '../src/voice/call.ts'
import type { RealtimeConnection, RealtimeEvent, RealtimeSetup } from '../src/voice/realtime/connection.ts'
import { GeminiLive } from '../src/voice/realtime/gemini.ts'
import { OpenAiRealtime } from '../src/voice/realtime/openai.ts'
import { RealtimeCallSession } from '../src/voice/realtime/session.ts'

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(5)
  }
}
const b64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')

/** A realtime model's socket, stood in: what it was sent (JSON), and `reply` to each message. */
function socket(reply: (ws: ServerWebSocket<unknown>, message: Record<string, unknown>) => void) {
  const got: Record<string, unknown>[] = []
  let headers = new Headers()
  let url = ''
  let open: ServerWebSocket<unknown> | undefined
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      headers = req.headers
      url = req.url
      if (srv.upgrade(req, { data: undefined })) return undefined
      return new Response('no', { status: 400 })
    },
    websocket: {
      open(ws) {
        open = ws
      },
      message(ws, m) {
        const msg = JSON.parse(String(m)) as Record<string, unknown>
        got.push(msg)
        reply(ws, msg)
      },
    },
  })
  servers.push(server)
  return {
    url: `ws://127.0.0.1:${server.port}`,
    got,
    headers: () => headers,
    path: () => url,
    send: (m: unknown) => open?.send(JSON.stringify(m)),
  }
}

/** Fake chats: what the call sent the crew, its approvals decided, and a way to send it the crew's events. */
function crew() {
  const sent: string[] = []
  const decided: [string, boolean][] = []
  let listener: ((colonyId: string, events: readonly MyrEvent[]) => void) | undefined
  const chats: CallChats = {
    send: async (text, chatId) => {
      sent.push(text)
      return { chatId: chatId ?? 'chat-1', colonyId: 'col-1', started: true, round: 1 }
    },
    onEvents: (l) => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    decideApproval: async (_colony, id, approved) => {
      decided.push([id, approved])
    },
  }
  const events = (list: { type: string; payload: Record<string, unknown> }[]) =>
    listener?.('col-1', list as unknown as MyrEvent[])
  return { chats, sent, decided, events }
}

const OPTIONS = {
  model: 'openai/x',
  name: 'Robin',
  start: 0.5,
  hold: 0.35,
  threshold: 400,
  sampleRate: 16_000,
}

test('OpenAI Realtime: the session is set up with the call tools, and a tool call goes round to the crew and back', async () => {
  const model = socket((ws, m) => {
    if (m.type === 'session.update' && (m.session as { tools?: unknown }).tools)
      ws.send(JSON.stringify({ type: 'session.updated' }))
  })
  const { chats, sent } = crew()
  const out: CallOutput[] = []
  const call = new RealtimeCallSession(
    {
      chats,
      resolver: new ModelResolver(),
      realtime: new OpenAiRealtime({ key: 'sk-rt', model: 'gpt-realtime-2.1', url: model.url }),
      voice: 'marin',
    },
    OPTIONS,
    (o) => out.push(o),
  )
  await call.start()
  expect(model.headers().get('authorization')).toBe('Bearer sk-rt')
  expect(model.headers().get('openai-beta')).toBeNull()
  expect(new URL(model.path()).searchParams.get('model')).toBe('gpt-realtime-2.1')
  const setup = model.got[0]?.session as Record<string, unknown> & {
    audio: { input: { format: unknown; turn_detection: { type: string } }; output: { voice: string } }
    tools: { type: string; name: string; parameters: unknown }[]
    instructions: string
  }
  expect(setup.type).toBe('realtime')
  expect(setup.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24_000 })
  expect(setup.audio.input.turn_detection.type).toBe('semantic_vad')
  expect(setup.audio.output.voice).toBe('marin')
  expect(setup.tools.map((t) => t.name)).toEqual([
    'start_task',
    'ask_crew',
    'task_status',
    'crew_updates',
    'answer_approval',
    'end_call',
  ])
  expect(setup.tools.every((t) => t.type === 'function')).toBe(true)
  expect(setup.instructions).toContain('Notices in square brackets that start with "Myrmidon:"')
  // It is asked to greet, by Myrmidon's notice (a system item), never as the person's words.
  await until(() => model.got.some((m) => m.type === 'response.create'))
  const greet = model.got.find((m) => m.type === 'conversation.item.create')?.item as {
    role: string
    content: { text: string }[]
  }
  expect(greet.role).toBe('system')
  expect(greet.content[0]?.text).toBe(prompts.voice.realtime.greet('Robin'))
  model.send({ type: 'response.done', response: { status: 'completed' } })

  // The person's audio goes in at 24 kHz.
  call.audio(new Int16Array(1600).fill(1000))
  await until(() => model.got.some((m) => m.type === 'input_audio_buffer.append'))
  const appended = model.got.find((m) => m.type === 'input_audio_buffer.append') as { audio: string }
  expect(Buffer.from(appended.audio, 'base64').length / 2).toBeGreaterThan(2300)

  // A turn, its transcript, and the model's call to start_task.
  model.send({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
  model.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'u1',
    transcript: 'fix the login bug',
  })
  model.send({ type: 'response.created' })
  model.send({
    type: 'response.function_call_arguments.done',
    call_id: 'c1',
    name: 'start_task',
    arguments: JSON.stringify({ request: 'Fix the login bug' }),
  })
  await until(() => sent.length === 1)
  expect(sent).toEqual(['Fix the login bug'])
  await until(() =>
    model.got.some(
      (m) => m.type === 'conversation.item.create' && (m.item as { call_id?: string }).call_id === 'c1',
    ),
  )
  const result = model.got.find((m) => (m.item as { call_id?: string } | undefined)?.call_id === 'c1')?.item
  expect(result).toEqual({
    type: 'function_call_output',
    call_id: 'c1',
    output: prompts.voice.results.started,
  })
  // The answer to the result waits for the current one to end.
  const creates = () => model.got.filter((m) => m.type === 'response.create').length
  expect(creates()).toBe(1)
  model.send({ type: 'response.done', response: { status: 'completed' } })
  await until(() => creates() === 2)

  // Its speech and what it said reach the person's side, and the transcript.
  model.send({
    type: 'response.output_audio.delta',
    item_id: 'a1',
    delta: b64(new Int16Array(2400).fill(500)),
  })
  model.send({ type: 'response.output_audio_transcript.done', transcript: 'The crew is on it.' })
  await until(() => out.some((o) => o.type === 'said'))
  expect(out.find((o) => o.type === 'audio')).toMatchObject({ sampleRate: 24_000 })
  expect(out).toContainEqual({ type: 'heard', text: 'fix the login bug' })
  expect(out).toContainEqual({ type: 'task', colonyId: 'col-1', request: 'Fix the login bug' })
  // Talking over it cuts the item where it was, and stops what the person's side is playing.
  model.send({ type: 'input_audio_buffer.speech_started', item_id: 'u2' })
  await until(() => model.got.some((m) => m.type === 'conversation.item.truncate'))
  expect(model.got.find((m) => m.type === 'conversation.item.truncate')).toMatchObject({
    item_id: 'a1',
    content_index: 0,
  })
  await until(() => out.some((o) => o.type === 'stop-audio'))
  expect(call.transcript().map((t) => [t.who, t.text])).toEqual([
    ['person', 'fix the login bug'],
    ['voice', 'The crew is on it.'],
  ])
  call.hangUp()
})

/** A realtime model scripted from the test: what the call sent it, and `emit` for what it says back. */
function scripted() {
  const sent: { kind: string; id?: string; text: string }[] = []
  let on: (e: RealtimeEvent) => void = () => {}
  let setup: RealtimeSetup | undefined
  const connection: RealtimeConnection = {
    inputRate: 16_000,
    connect: async (s, listener) => {
      setup = s
      on = listener
    },
    audio: () => {},
    toolResult: (id, _name, output) => sent.push({ kind: 'result', id, text: output }),
    notice: (text) => sent.push({ kind: 'notice', text }),
    interrupt: () => {},
    close: () => {},
  }
  return { connection, sent, emit: (e: RealtimeEvent) => on(e), setup: () => setup }
}

test("an approval is put once the crew asks, through crew_updates, and a yes whose transcript comes after the model's call still decides it", async () => {
  const model = scripted()
  const { chats, sent, decided, events } = crew()
  const out: CallOutput[] = []
  const call = new RealtimeCallSession(
    { chats, resolver: new ModelResolver(), realtime: model.connection, voice: 'Kore' },
    OPTIONS,
    (o) => out.push(o),
  )
  await call.start()
  expect(model.sent).toEqual([{ kind: 'notice', text: prompts.voice.realtime.greet('Robin') }])
  model.emit({ type: 'done' })
  // The person asks for work, which starts a round the crew asks approval in.
  model.emit({ type: 'speech-started', turn: '1' })
  model.emit({ type: 'heard', turn: '1', text: 'deploy it', final: true })
  model.emit({ type: 'tool', id: 'c1', name: 'start_task', args: { request: 'Deploy it' } })
  // The crew asks while the model's call is still going: the model is told once it has answered.
  await until(() => sent.length === 1)
  events([{ type: 'approval/requested', payload: { id: 'ap-1', tool: 'shell', summary: 'run deploy.sh' } }])
  await until(() => model.sent.some((s) => s.id === 'c1'))
  expect(model.sent.filter((s) => s.kind === 'notice')).toHaveLength(1)
  model.emit({ type: 'done' })
  // The model hears there is news in Myrmidon's words, and the news itself only as crew_updates' result.
  await until(() => model.sent.filter((s) => s.kind === 'notice').length === 2)
  expect(model.sent.filter((s) => s.kind === 'notice').at(-1)?.text).toBe(prompts.voice.realtime.updates)
  expect(JSON.stringify(model.sent.filter((s) => s.kind === 'notice'))).not.toContain('deploy.sh')
  model.emit({ type: 'tool', id: 'c2', name: 'crew_updates', args: {} })
  await until(() => model.sent.some((s) => s.id === 'c2'))
  expect(model.sent.find((s) => s.id === 'c2')?.text).toContain('approval ap-1 to use shell: run deploy.sh')
  model.emit({ type: 'done' })
  // The person says yes; the model calls answer_approval before its transcript is in.
  model.emit({ type: 'speech-started', turn: '2' })
  model.emit({ type: 'tool', id: 'c3', name: 'answer_approval', args: { id: 'ap-1', approve: true } })
  await Bun.sleep(30)
  expect(decided).toEqual([])
  model.emit({ type: 'heard', turn: '2', text: 'Yes.', final: true })
  await until(() => decided.length === 1)
  expect(decided).toEqual([['ap-1', true]])
  await until(() => model.sent.some((s) => s.id === 'c3'))
  expect(model.sent.find((s) => s.id === 'c3')?.text).toBe(
    prompts.voice.results.decided(prompts.voice.decided(true, 'run deploy.sh')),
  )
  expect(out).toContainEqual({ type: 'approval-done', id: 'ap-1', approved: true })
  call.hangUp()
})

test('a yes said before the approval was heard does not decide it', async () => {
  const model = scripted()
  const { chats, decided, events } = crew()
  const call = new RealtimeCallSession(
    { chats, resolver: new ModelResolver(), realtime: model.connection, voice: 'Kore' },
    OPTIONS,
    () => {},
  )
  await call.start()
  model.emit({ type: 'done' })
  model.emit({ type: 'tool', id: 'c1', name: 'start_task', args: { request: 'Deploy it' } })
  await until(() => model.sent.some((s) => s.id === 'c1'))
  model.emit({ type: 'done' })
  model.emit({ type: 'speech-started', turn: '1' })
  model.emit({ type: 'heard', turn: '1', text: 'yes', final: true })
  events([{ type: 'approval/requested', payload: { id: 'ap-1', tool: 'shell', summary: 'run deploy.sh' } }])
  model.emit({ type: 'tool', id: 'c2', name: 'crew_updates', args: {} })
  await Bun.sleep(20)
  model.emit({ type: 'tool', id: 'c3', name: 'answer_approval', args: { id: 'ap-1', approve: true } })
  await until(() => model.sent.some((s) => s.id === 'c3'))
  expect(model.sent.find((s) => s.id === 'c3')?.text).toBe(prompts.voice.results.notAnswered)
  expect(decided).toEqual([])
  call.hangUp()
})

test('end_call hangs up once the goodbye is over; a model that cannot be reached ends the call with why', async () => {
  const model = scripted()
  const { chats } = crew()
  const out: CallOutput[] = []
  const call = new RealtimeCallSession(
    { chats, resolver: new ModelResolver(), realtime: model.connection, voice: 'Kore' },
    OPTIONS,
    (o) => out.push(o),
  )
  await call.start()
  model.emit({ type: 'tool', id: 'c1', name: 'end_call', args: {} })
  await until(() => model.sent.some((s) => s.id === 'c1'))
  model.emit({ type: 'done' })
  await until(() => out.at(-1)?.type === 'ended')
  expect(out.at(-1)).toEqual({ type: 'ended', reason: 'agent' })

  const failing: RealtimeConnection = {
    ...scripted().connection,
    connect: () => Promise.reject(new Error('OpenAI closed the connection (4001 invalid key)')),
  }
  const failed: CallOutput[] = []
  const other = new RealtimeCallSession(
    { chats, resolver: new ModelResolver(), realtime: failing, voice: 'Kore' },
    OPTIONS,
    (o) => failed.push(o),
  )
  await other.start()
  expect(failed).toContainEqual({
    type: 'error',
    message: prompts.voice.realtime.failed('OpenAI closed the connection (4001 invalid key)'),
  })
  expect(failed.at(-1)).toEqual({ type: 'ended', reason: 'error' })
})

test('Gemini Live: tools are BLOCKING with its schema types, turns come from its transcripts, tool results go back', async () => {
  const model = socket((ws, m) => {
    if (m.setup) ws.send(JSON.stringify({ setupComplete: {} }))
  })
  const events: RealtimeEvent[] = []
  const gemini = new GeminiLive({ key: 'g-key', model: 'gemini-3.8-live', url: model.url })
  await gemini.connect(
    {
      instructions: 'Be brief.',
      voice: 'Kore',
      tools: [
        {
          name: 'start_task',
          description: 'Hand work on.',
          parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
        },
        {
          name: 'task_status',
          description: 'What is going on.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    (e) => events.push(e),
  )
  expect(model.headers().get('x-goog-api-key')).toBe('g-key')
  // The key is never in the address.
  expect(model.path()).not.toContain('g-key')
  const setup = model.got[0]?.setup as {
    model: string
    generationConfig: { responseModalities: string[]; speechConfig: unknown }
    systemInstruction: unknown
    tools: { functionDeclarations: Record<string, unknown>[] }[]
    inputAudioTranscription: unknown
  }
  expect(setup.model).toBe('models/gemini-3.8-live')
  expect(setup.generationConfig.responseModalities).toEqual(['AUDIO'])
  expect(setup.generationConfig.speechConfig).toEqual({
    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
  })
  expect(setup.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] })
  expect(setup.inputAudioTranscription).toEqual({})
  expect(setup.tools[0]?.functionDeclarations).toEqual([
    {
      name: 'start_task',
      description: 'Hand work on.',
      behavior: 'BLOCKING',
      parameters: { type: 'OBJECT', properties: { request: { type: 'STRING' } }, required: ['request'] },
    },
    // A tool that takes nothing declares no parameters.
    { name: 'task_status', description: 'What is going on.', behavior: 'BLOCKING' },
  ])

  gemini.audio(new Int16Array(320).fill(10))
  await until(() => model.got.some((m) => m.realtimeInput))
  const input = model.got.find((m) => m.realtimeInput)?.realtimeInput as { audio?: { mimeType?: string } }
  expect(input.audio?.mimeType).toBe('audio/pcm;rate=16000')
  model.send({ serverContent: { inputTranscription: { text: 'what is ' } } })
  model.send({ serverContent: { inputTranscription: { text: 'going on' } } })
  model.send({ toolCall: { functionCalls: [{ id: 'f1', name: 'task_status', args: {} }] } })
  await until(() => events.some((e) => e.type === 'tool'))
  expect(events.filter((e) => e.type !== 'ready')).toEqual([
    { type: 'speech-started', turn: '1' },
    { type: 'heard', turn: '1', text: 'what is', final: false },
    { type: 'heard', turn: '1', text: 'what is going on', final: false },
    // The model's answer begins: the person's turn is over.
    { type: 'heard', turn: '1', text: 'what is going on', final: true },
    { type: 'tool', id: 'f1', name: 'task_status', args: {} },
  ])
  gemini.toolResult('f1', 'task_status', 'Nothing running.')
  await until(() => model.got.some((m) => m.toolResponse))
  expect(model.got.find((m) => m.toolResponse)).toEqual({
    toolResponse: {
      functionResponses: [{ id: 'f1', name: 'task_status', response: { result: 'Nothing running.' } }],
    },
  })
  model.send({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: b64(new Int16Array(480).fill(9)) } }],
      },
      outputTranscription: { text: 'Nothing is running.' },
    },
  })
  model.send({ serverContent: { generationComplete: true } })
  await until(() => events.some((e) => e.type === 'done'))
  expect(events.find((e) => e.type === 'audio')).toMatchObject({ sampleRate: 24_000 })
  expect(events).toContainEqual({ type: 'said', text: 'Nothing is running.' })
  // A notice goes in as Myrmidon's own words, in a turn of its own.
  gemini.notice(prompts.voice.realtime.updates)
  await until(() => model.got.some((m) => m.clientContent))
  expect(model.got.find((m) => m.clientContent)).toEqual({
    clientContent: {
      turns: [{ role: 'user', parts: [{ text: prompts.voice.realtime.updates }] }],
      turnComplete: true,
    },
  })
  gemini.close()
})
