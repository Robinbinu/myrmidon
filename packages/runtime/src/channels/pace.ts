/** Waiting, backing off and pacing, for the adapters that hold a connection open (IRC, Twitch, Nostr). */

/** Waits `ms`, ending early when the signal aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

/**
 * Reconnect delays, after OpenClaw's IRC policy: doubling from `minMs` to `maxMs`, ±20% jitter (so many gateways
 * recovering together do not reconnect at the same moment), and back to the start only after a connection held for
 * `stableMs`, so a server that drops every connection at once keeps the delay growing.
 */
export class Backoff {
  private _attempt = 0
  private _upSince?: number

  constructor(
    private readonly minMs: number,
    private readonly maxMs: number,
    private readonly stableMs = 60_000,
  ) {}

  /** The connection is up. */
  up() {
    this._upSince = Date.now()
  }

  next(): number {
    if (this._upSince !== undefined && Date.now() - this._upSince >= this.stableMs) this._attempt = 0
    this._upSince = undefined
    const base = Math.min(this.maxMs, this.minMs * 2 ** this._attempt)
    this._attempt += 1
    return Math.round(base * (0.8 + Math.random() * 0.4))
  }
}

/**
 * Flood control as a token bucket: a burst of `burst` lines at once, then one every `everyMs`. Servers disconnect a
 * client that sends faster ("Excess Flood"), and Twitch silently drops its messages.
 */
export class Pacer {
  private _tokens: number
  private _at = Date.now()
  private _queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly burst: number,
    private readonly everyMs: number,
  ) {
    this._tokens = burst
  }

  /** Resolves when the caller may send one line; callers go in the order they asked. */
  take(signal?: AbortSignal): Promise<void> {
    const turn = this._queue.then(async () => {
      this._refill()
      if (this._tokens < 1) {
        await sleep(Math.ceil((1 - this._tokens) * this.everyMs), signal)
        this._refill()
      }
      this._tokens = Math.max(0, this._tokens - 1)
    })
    this._queue = turn.catch(() => {})
    return turn
  }

  private _refill() {
    const now = Date.now()
    this._tokens = Math.min(this.burst, this._tokens + (now - this._at) / this.everyMs)
    this._at = now
  }
}
