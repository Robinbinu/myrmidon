import { expect, test } from 'bun:test'
import { type Call, callbackPort, key, login, model, type Terminal } from '../src/setup.ts'

const plain = (s: string) => s
const style = { dim: plain, bold: plain, green: plain, red: plain, yellow: plain, cyan: plain }

/** A terminal that answers from a script and records what it printed and asked. */
function scripted(answers: (string | ((q: string) => Promise<string>))[], piped?: string) {
  const out: string[] = []
  const asked: { question: string; hidden: boolean }[] = []
  const term: Terminal = {
    print: (line = '') => out.push(line),
    ask: async (question, options = {}) => {
      asked.push({ question, hidden: Boolean(options.hidden) })
      const next = answers.shift()
      if (next === undefined) throw new Error(`unexpected question: ${question}`)
      return typeof next === 'string' ? next : next(question)
    },
    piped: async () => piped,
    interactive: true,
    headless: true,
    onInterrupt: () => () => {},
    style,
  }
  return { term, out, asked }
}

/** A stand-in for the server's API: each route answers from a handler; every call is recorded. */
function api(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { route: string; body: unknown }[] = []
  const call: Call = async <T>(method: string, path: string, body?: unknown) => {
    const route = `${method} ${path}`
    calls.push({ route, body })
    const handler = routes[route]
    if (!handler) throw new Error(`no route ${route}`)
    return handler(body) as T
  }
  return { call, calls }
}

test('a default model is saved only once it answers, keeping the rest of the settings', async () => {
  const models = [
    { ref: 'openai/gpt-x', provider: 'openai', name: 'GPT X' },
    { ref: 'anthropic/claude-y', provider: 'anthropic', name: 'Claude Y' },
  ]
  const settings = { team: { leadModel: 'openai/gpt-x', workers: 3 }, profile: { name: 'R' } }
  let works = false
  const { call, calls } = api({
    'GET /api/models': () => ({ models, defaults: settings.team }),
    'POST /api/models/test': () => (works ? { ok: true, ms: 1200 } : { ok: false, error: '401 bad key' }),
    'GET /api/settings': () => ({ settings }),
    'PUT /api/settings': (body) => ({ settings: body }),
  })

  const failing = scripted(['claude', '1'])
  await model(call, failing.term)
  expect(failing.out.join('\n')).toContain('did not answer: 401 bad key')
  expect(calls.some((c) => c.route === 'PUT /api/settings')).toBe(false)
  process.exitCode = 0

  works = true
  const ok = scripted([])
  await model(call, ok.term, 'anthropic/claude-y')
  const put = calls.find((c) => c.route === 'PUT /api/settings')
  expect(put?.body).toEqual({ team: { leadModel: 'anthropic/claude-y', workers: 3 }, profile: { name: 'R' } })

  await expect(model(call, scripted([]).term, 'nope/none')).rejects.toThrow('not a ready model')
})

test('a key is read from a pipe when there is one, never asked for in the open, and then tried', async () => {
  const { call, calls } = api({
    'PUT /api/credentials/openai': () => ({ ok: true }),
    'GET /api/models': () => ({ models: [{ ref: 'openai/gpt-x', provider: 'openai', name: 'GPT X' }] }),
    'POST /api/models/test': () => ({ ok: true, ms: 800 }),
  })
  const piped = scripted([], 'sk-test-123\n')
  await key(call, piped.term, 'openai')
  expect(calls[0]).toEqual({ route: 'PUT /api/credentials/openai', body: { apiKey: 'sk-test-123' } })
  expect(piped.asked).toEqual([])
  expect(piped.out.join('\n')).toContain('It answers')
  // Nothing printed ever contains the key.
  expect(piped.out.join('\n')).not.toContain('sk-test-123')

  const typed = scripted(['sk-typed'])
  await key(call, typed.term, 'openai')
  expect(typed.asked).toEqual([{ question: 'API key for openai (hidden)', hidden: true }])
})

test('a sign-in prints the link, takes a pasted redirect, and finishes', async () => {
  let polls = 0
  const { call, calls } = api({
    'GET /api/logins': () => ({
      logins: [{ id: 'openai-codex', name: 'ChatGPT', provider: 'openai', ready: false }],
    }),
    'POST /api/logins': () => ({
      id: 'login-1',
      status: 'waiting',
      url: 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    }),
    'GET /api/logins/login-1': () =>
      ++polls < 2
        ? {
            id: 'login-1',
            status: 'waiting',
            url: 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
          }
        : {
            id: 'login-1',
            status: 'waiting',
            url: 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
            prompt: { message: 'Paste the redirect URL', placeholder: 'code#state or URL' },
          },
    'POST /api/logins/login-1': () => ({
      id: 'login-1',
      status: 'done',
      result: { email: 'me@example.com' },
    }),
  })
  const { term, out } = scripted(['1', 'http://127.0.0.1:1455/auth/callback?code=abc&state=s'])
  await login(call, term)
  expect(out).toContain(
    '  https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
  )
  // Headless with a loopback redirect: the advice to paste the address back, and the tunnel that avoids it.
  expect(out.join('\n')).toContain('copy the whole address')
  expect(out.join('\n')).toContain('ssh -N -L 1455:127.0.0.1:1455')
  expect(out.at(-1)).toBe('Signed in as me@example.com.')
  expect(calls.find((c) => c.route === 'POST /api/logins/login-1')?.body).toEqual({
    answer: 'http://127.0.0.1:1455/auth/callback?code=abc&state=s',
  })
})

test('a sign-in that completes by itself withdraws the question it was asking', async () => {
  let polls = 0
  let withdrawn = false
  const { call, calls } = api({
    'GET /api/logins': () => ({
      logins: [{ id: 'gemini', name: 'Gemini', provider: 'google', ready: false }],
    }),
    'POST /api/logins': () => ({
      id: 'login-2',
      status: 'waiting',
      url: 'https://auth.example/g',
      prompt: { message: 'Paste the redirect URL' },
    }),
    // The callback was forwarded over SSH, so the flow finishes without the paste.
    'GET /api/logins/login-2': () =>
      ++polls < 2
        ? {
            id: 'login-2',
            status: 'waiting',
            url: 'https://auth.example/g',
            prompt: { message: 'Paste the redirect URL' },
          }
        : { id: 'login-2', status: 'done', result: {} },
  })
  // The question is never answered; the poll ends the sign-in and withdraws it.
  const { term, out } = scripted([(_q) => new Promise<string>(() => {})])
  const originalAsk = term.ask
  term.ask = (q, o) => {
    o?.signal?.addEventListener('abort', () => {
      withdrawn = true
    })
    return originalAsk(q, o)
  }
  await login(call, term, 'gemini')
  expect(withdrawn).toBe(true)
  expect(out.at(-1)).toBe('Signed in.')
  expect(calls.some((c) => c.route === 'DELETE /api/logins/login-2')).toBe(false)
})

test('the SSH tunnel hint names the port a loopback callback uses, and nothing else', () => {
  const at = (redirect: string) =>
    `https://auth.example/authorize?client_id=x&redirect_uri=${encodeURIComponent(redirect)}`
  expect(callbackPort(at('http://localhost:1455/auth/callback'))).toBe('1455')
  expect(callbackPort(at('http://127.0.0.1:8085/oauth2callback'))).toBe('8085')
  expect(callbackPort(at('https://console.anthropic.com/oauth/code/callback'))).toBeUndefined()
  expect(callbackPort('https://github.com/login/device')).toBeUndefined()
})

test('Ctrl-C while a sign-in waits withdraws it on the server', async () => {
  const { call, calls } = api({
    'POST /api/logins': () => ({ id: 'login-3', status: 'waiting', url: 'https://github.com/login/device' }),
    'GET /api/logins': () => ({
      logins: [{ id: 'github-copilot', name: 'Copilot', provider: 'github', ready: false }],
    }),
    'GET /api/logins/login-3': () => ({
      id: 'login-3',
      status: 'waiting',
      url: 'https://github.com/login/device',
    }),
    'DELETE /api/logins/login-3': () => ({ id: 'login-3', status: 'cancelled' }),
  })
  const { term } = scripted([])
  term.onInterrupt = (fn) => {
    setTimeout(fn, 50)
    return () => {}
  }
  await expect(login(call, term, 'github-copilot')).rejects.toThrow('cancelled')
  expect(calls.at(-1)?.route).toBe('DELETE /api/logins/login-3')
})
