/**
 * Keeps secrets out of what Myrmidon stores: the event log and agents' transcripts are written to disk and replayed
 * in the UI, so a key an agent read from a .env file, a token in a command's output, or one the person pasted
 * must not land there in clear. The live model call is untouched; only what is persisted is redacted.
 */

const PATTERNS: [kind: string, re: RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ['api key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe key', /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer token', /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g],
]

/** `NAME_KEY=value`, `"apiToken": "value"`, `password: value`: the name stays, the value goes. */
const ASSIGNMENT =
  /((?:^|[\s"'{,])[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|credential|access[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gim

/** Secret values the server itself holds in its environment, matched exactly wherever they appear. */
const known = (() => {
  const values: string[] = []
  for (const [name, value] of Object.entries(process.env))
    if (value && value.length >= 12 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) values.push(value)
  return values.sort((a, b) => b.length - a.length)
})()

const mark = (kind: string) => `[${kind} redacted]`

export function redactSecrets(text: string): string {
  if (text.length < 8) return text
  let out = text
  for (const value of known) if (out.includes(value)) out = out.replaceAll(value, mark('secret'))
  for (const [kind, re] of PATTERNS) out = out.replace(re, mark(kind))
  return out.replace(ASSIGNMENT, (whole, name: string, value: string) =>
    value.startsWith('[') && value.endsWith(']') ? whole : `${name}${mark('secret')}`,
  )
}

/** Redacts every string in a JSON-like value (an event payload, a transcript message). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
    return out as T
  }
  return value
}
