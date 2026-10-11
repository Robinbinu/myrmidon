import { PowerAssertion } from './omp/natives.ts'
import { prompts } from './prompts.ts'

/**
 * Keeps the computer from idle-sleeping while a round runs (omp's PowerAssertion: IOKit on macOS, login1 on Linux,
 * the execution state on Windows; a no-op elsewhere), and lets it sleep again once no round runs. Only while the
 * person turned it on (`enabled`), which is off by default: nothing changes until they do.
 */
export class KeepAwake {
  private readonly _rounds = new Set<string>()
  private _held?: { stop(): void }

  constructor(
    private readonly _enabled: () => boolean,
    private readonly _start: () => { stop(): void } = () =>
      PowerAssertion.start({ reason: prompts.keepAwake.reason, idle: true }),
  ) {}

  /** A round started. */
  hold(round: string): void {
    this._rounds.add(round)
    this.sync()
  }

  /** A round ended; ending one twice is harmless. */
  release(round: string): void {
    this._rounds.delete(round)
    this.sync()
  }

  /** Takes or lets go of the assertion as the rounds and the setting now say, e.g. after the setting changed. */
  sync(): void {
    const want = this._rounds.size > 0 && this._enabled()
    if (want && !this._held) {
      try {
        this._held = this._start()
      } catch (err) {
        // A system without a power service (a container, say) runs the round awake or not, as before.
        console.warn(`keeping the computer awake failed: ${err instanceof Error ? err.message : err}`)
      }
    } else if (!want && this._held) {
      this._held.stop()
      this._held = undefined
    }
  }

  /** Whether the computer is being kept awake now. */
  get holding(): boolean {
    return !!this._held
  }
}
