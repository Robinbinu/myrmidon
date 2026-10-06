import type { LoginResult, OmpRuntime } from '@myrmidon/runtime'

/** What the settings page shows while a sign-in runs. */
export interface LoginState {
  readonly id: string
  readonly login: string
  readonly status: 'waiting' | 'done' | 'failed' | 'cancelled'
  /** Where the user signs in; the flow completes on its own when the provider redirects back. */
  readonly url?: string
  readonly instructions?: string
  /** A question the flow is waiting on, such as a pasted authorization code. */
  readonly prompt?: { readonly message: string; readonly placeholder?: string }
  readonly progress?: string
  readonly result?: LoginResult
  readonly error?: string
}

interface Session {
  state: LoginState
  readonly prompts: { message: string; placeholder?: string; resolve(value: string): void }[]
  readonly abort: AbortController
  readonly changed: Set<() => void>
}

const TIMEOUT_MS = 10 * 60_000
/** How long `start` waits for the flow to produce a sign-in URL before returning. */
const FIRST_STEP_MS = 15_000

/**
 * Interactive OAuth sign-ins driven from the browser. omp runs the flow in this process (including its
 * loopback callback server), and the settings page polls the session for the URL to open and for any
 * code it should paste.
 */
export class Logins {
  readonly #sessions = new Map<string, Session>()
  #next = 0

  constructor(private readonly omp: OmpRuntime) {}

  async start(login: string): Promise<LoginState> {
    // Flows share one loopback callback port, so only one sign-in runs at a time.
    for (const s of this.#sessions.values()) if (s.state.status === 'waiting') this.#finish(s, 'cancelled')
    const id = `login-${++this.#next}`
    const session: Session = {
      state: { id, login, status: 'waiting' },
      prompts: [],
      abort: new AbortController(),
      changed: new Set(),
    }
    this.#sessions.set(id, session)
    const update = (patch: Partial<LoginState>) => {
      if (session.state.status !== 'waiting') return
      session.state = { ...session.state, ...patch }
      for (const fn of session.changed) fn()
    }
    const showPrompt = () => {
      const next = session.prompts[0]
      update({
        prompt: next
          ? { message: next.message, ...(next.placeholder ? { placeholder: next.placeholder } : {}) }
          : undefined,
      })
    }
    const timer = setTimeout(() => this.#finish(session, 'failed', 'sign-in timed out'), TIMEOUT_MS)
    this.omp
      .login(login, {
        signal: session.abort.signal,
        onAuth: (url, instructions) => update({ url, ...(instructions ? { instructions } : {}) }),
        onProgress: (progress) => update({ progress }),
        onPrompt: (message, placeholder) =>
          new Promise<string>((resolve, reject) => {
            session.prompts.push({ message, ...(placeholder ? { placeholder } : {}), resolve })
            session.abort.signal.addEventListener('abort', () => reject(new Error('sign-in cancelled')), {
              once: true,
            })
            showPrompt()
          }),
      })
      .then((result) => this.#finish(session, 'done', undefined, result))
      .catch((err) => this.#finish(session, 'failed', err instanceof Error ? err.message : String(err)))
      .finally(() => clearTimeout(timer))

    // Return once there is something to show, so the page can open the URL straight away.
    await new Promise<void>((resolve) => {
      const done = () => {
        session.changed.delete(done)
        resolve()
      }
      session.changed.add(done)
      setTimeout(done, FIRST_STEP_MS)
    })
    return session.state
  }

  get(id: string): LoginState | undefined {
    return this.#sessions.get(id)?.state
  }

  answer(id: string, value: string): LoginState | undefined {
    const session = this.#sessions.get(id)
    if (session?.state.status !== 'waiting') return session?.state
    const prompt = session.prompts.shift()
    prompt?.resolve(value)
    const next = session.prompts[0]
    session.state = {
      ...session.state,
      prompt: next
        ? { message: next.message, ...(next.placeholder ? { placeholder: next.placeholder } : {}) }
        : undefined,
    }
    return session.state
  }

  cancel(id: string): LoginState | undefined {
    const session = this.#sessions.get(id)
    if (session) this.#finish(session, 'cancelled')
    return session?.state
  }

  #finish(session: Session, status: LoginState['status'], error?: string, result?: LoginResult) {
    if (session.state.status !== 'waiting') return
    const { prompt: _prompt, ...rest } = session.state
    session.state = { ...rest, status, ...(error ? { error } : {}), ...(result ? { result } : {}) }
    if (status !== 'done') session.abort.abort()
    for (const fn of session.changed) fn()
    setTimeout(() => this.#sessions.delete(session.state.id), TIMEOUT_MS).unref?.()
  }
}
