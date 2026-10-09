/**
 * Times as agents see them: in the person's time zone, the machine's, which is also what the shell's `date` and `ls`
 * print. One zone everywhere (the prompt, read_log, the mirror's notes), so agents never mix UTC with local times.
 * Everything goes through Intl with that zone named, so the zone a text names and the times it shows always agree.
 */

/** The person's time zone, e.g. Europe/Berlin. */
export function personZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const formats = new Map<string, Intl.DateTimeFormat>()

function part(at: Date | string, kind: 'date' | 'time' | 'offset'): string {
  const zone = personZone()
  const key = `${zone}/${kind}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(
      kind === 'date' ? 'en-CA' : 'en-GB',
      kind === 'date'
        ? { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }
        : kind === 'time'
          ? { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }
          : { timeZone: zone, timeZoneName: 'longOffset' },
    )
    formats.set(key, format)
  }
  const date = new Date(at)
  if (kind !== 'offset') return format.format(date)
  const name = format.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  return name === 'GMT' ? 'UTC+00:00' : name.replace('GMT', 'UTC')
}

/** The zone's offset from UTC at `at`, e.g. "UTC+05:30". */
export function zoneOffset(at: Date = new Date()): string {
  return part(at, 'offset')
}

/** YYYY-MM-DD in the person's zone. */
export function localDate(at: Date | string = new Date()): string {
  return part(at, 'date')
}

/** HH:MM:SS in the person's zone. */
export function clockTime(at: Date | string): string {
  return part(at, 'time')
}
