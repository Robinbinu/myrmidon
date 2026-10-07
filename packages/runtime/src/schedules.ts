import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rounds that start on their own: a request with a cron schedule ("every weekday at 9:00"), optionally in a
 * project. The server checks every half minute and starts the ones that are due as ordinary chats, so their
 * results, verification and notifications are the same as for a request typed in the composer.
 */

export interface Schedule {
  readonly id: string
  readonly name: string
  readonly request: string
  /** Five-field cron, local time: minute hour day-of-month month day-of-week. */
  readonly cron: string
  readonly project?: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly nextRun?: string
  readonly lastRun?: { at: string; chatId?: string; error?: string }
}

const FIELDS: [min: number, max: number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

/** The values one cron field allows: `*`, lists, ranges and steps (`1-5`, `*\/15`, `0,30`). */
function field(text: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) throw new Error(`bad cron field "${text}"`)
    const step = m[4] ? Number(m[4]) : 1
    const from = m[1] === '*' ? min : Number(m[2])
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from
    if (from < min || to > max || from > to || step < 1)
      throw new Error(`cron field "${text}" is out of range`)
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

/** Parses a five-field cron expression; throws with what is wrong. */
export function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('a schedule needs five fields: minute hour day month weekday')
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, FIELDS[i] as [number, number]))
  if (weekday?.has(7)) weekday.add(0)
  return { minute, hour, day, month, weekday, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' }
}

/** The first time after `after` the expression matches (local time), within the next year and a bit. */
export function nextRun(expr: string, after: Date): Date {
  const c = parseCron(expr)
  const t = new Date(after)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  for (let i = 0; i < 60 * 24 * 400; i++) {
    // Classic cron: when both day fields are restricted, either one matching is enough.
    const dayOk =
      c.anyDay && c.anyWeekday
        ? true
        : c.anyDay
          ? c.weekday?.has(t.getDay())
          : c.anyWeekday
            ? c.day?.has(t.getDate())
            : c.day?.has(t.getDate()) || c.weekday?.has(t.getDay())
    if (!c.month?.has(t.getMonth() + 1) || !dayOk) {
      t.setHours(0, 0, 0, 0)
      t.setDate(t.getDate() + 1)
      continue
    }
    if (!c.hour?.has(t.getHours())) {
      t.setMinutes(0)
      t.setHours(t.getHours() + 1)
      continue
    }
    if (c.minute?.has(t.getMinutes())) return t
    t.setMinutes(t.getMinutes() + 1)
  }
  throw new Error(`"${expr}" never runs`)
}

export class ScheduleStore {
  private readonly _file: string

  constructor(home: string) {
    this._file = join(home, 'schedules.json')
  }

  list(): Schedule[] {
    if (!existsSync(this._file)) return []
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as Schedule[]).filter((s) => s && typeof s.cron === 'string') : []
    } catch {
      return []
    }
  }

  add(input: { name?: string; request: string; cron: string; project?: string }, now = new Date()): Schedule {
    const request = input.request.trim()
    if (!request) throw new Error('a schedule needs a request')
    const schedule: Schedule = {
      id: `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: (input.name?.trim() || request.split('\n')[0] || 'Scheduled').slice(0, 80),
      request,
      cron: input.cron.trim(),
      ...(input.project ? { project: input.project } : {}),
      enabled: true,
      createdAt: now.toISOString(),
      nextRun: nextRun(input.cron, now).toISOString(),
    }
    this._write([...this.list(), schedule])
    return schedule
  }

  update(
    id: string,
    patch: { name?: string; request?: string; cron?: string; enabled?: boolean; project?: string | null },
    now = new Date(),
  ): Schedule {
    const list = this.list()
    const current = list.find((s) => s.id === id)
    if (!current) throw new Error('no such schedule')
    const { project: _p, ...rest } = current
    const cron = patch.cron?.trim() ?? current.cron
    const project = patch.project === null ? undefined : (patch.project ?? current.project)
    const next: Schedule = {
      ...rest,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) || current.name } : {}),
      ...(patch.request !== undefined && patch.request.trim() ? { request: patch.request.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(project ? { project } : {}),
      cron,
      nextRun: nextRun(cron, now).toISOString(),
    }
    this._write(list.map((s) => (s.id === id ? next : s)))
    return next
  }

  remove(id: string) {
    this._write(this.list().filter((s) => s.id !== id))
  }

  /** Records a run and moves the schedule to its next time. */
  ran(id: string, result: { chatId?: string; error?: string }, now = new Date()) {
    this._write(
      this.list().map((s) =>
        s.id === id
          ? {
              ...s,
              lastRun: { at: now.toISOString(), ...result },
              nextRun: nextRun(s.cron, now).toISOString(),
            }
          : s,
      ),
    )
  }

  /** Enabled schedules whose time has come. */
  due(now = new Date()): Schedule[] {
    return this.list().filter(
      (s) => s.enabled && s.nextRun !== undefined && Date.parse(s.nextRun) <= now.getTime(),
    )
  }

  private _write(list: Schedule[]) {
    writeFileSync(`${this._file}.tmp`, `${JSON.stringify(list, null, 2)}\n`)
    renameSync(`${this._file}.tmp`, this._file)
  }
}

/**
 * Starts due schedules every `everyMs`. `start` sends the request (as a new chat) and returns its chat id; a
 * failure is recorded on the schedule and does not stop the others.
 */
export function startScheduler(
  store: ScheduleStore,
  start: (s: Schedule) => Promise<string>,
  everyMs = 30_000,
): () => void {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      for (const s of store.due()) {
        try {
          store.ran(s.id, { chatId: await start(s) })
        } catch (err) {
          store.ran(s.id, { error: err instanceof Error ? err.message : String(err) })
        }
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), everyMs)
  void tick()
  return () => clearInterval(timer)
}
