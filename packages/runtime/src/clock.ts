/**
 * Times as agents see them: in the person's time zone, the machine's, which is also what the shell's `date` and `ls`
 * print. One zone everywhere (the prompt, read_log, the mirror's notes), so agents never mix UTC with local times.
 * Everything goes through Intl with that zone named, so the zone a text names and the times it shows always agree.
 */

/** The person's time zone, e.g. Europe/Berlin. */
export function personZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Deprecated IANA names (backward links in tzdata) that systems still report, to the name the zone has now: agents
 * told "Asia/Calcutta" look up the wrong name or doubt the right one.
 */
const ZONE_LINKS: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Ujung_Pandang': 'Asia/Makassar',
  'Asia/Ashkhabad': 'Asia/Ashgabat',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Chungking': 'Asia/Shanghai',
  'Asia/Harbin': 'Asia/Shanghai',
  'Asia/Tel_Aviv': 'Asia/Jerusalem',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Europe/Nicosia': 'Asia/Nicosia',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Godthab': 'America/Nuuk',
  'America/Montreal': 'America/Toronto',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Africa/Asmera': 'Africa/Asmara',
  'Australia/ACT': 'Australia/Sydney',
  'Australia/NSW': 'Australia/Sydney',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
  'US/Alaska': 'America/Anchorage',
  'US/Hawaii': 'Pacific/Honolulu',
  'US/Arizona': 'America/Phoenix',
  'Etc/UTC': 'UTC',
  'Etc/UCT': 'UTC',
  'Etc/GMT': 'UTC',
  'Etc/Universal': 'UTC',
  'Etc/Zulu': 'UTC',
  GMT: 'UTC',
  UCT: 'UTC',
  Universal: 'UTC',
  Zulu: 'UTC',
}

/** The zone's current IANA name, e.g. Asia/Kolkata for a system that reports Asia/Calcutta. */
export function canonicalZone(zone: string = personZone()): string {
  return ZONE_LINKS[zone] ?? zone
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

/** HH:MM in the person's zone. */
export function clockMinutes(at: Date | string): string {
  return part(at, 'time').slice(0, 5)
}

/** HH:MM:SS in the person's zone. */
export function clockTime(at: Date | string): string {
  return part(at, 'time')
}
