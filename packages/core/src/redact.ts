export const REDACTED = '[REDACTED]'

const PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?<=Bearer\s)[A-Za-z0-9._~+/-]{16,}=*/g,
]

/** Strips known secret shapes and registered secret values from any JSON-like value. */
export class Redactor {
  private readonly _secrets = new Set<string>()

  addSecret(value: string): () => void {
    // Short values would redact ordinary words all over the log.
    if (value.length < 8) throw new RangeError('secrets shorter than 8 characters cannot be redacted safely')
    this._secrets.add(value)
    return () => this._secrets.delete(value)
  }

  redactString(input: string): string {
    let out = input
    for (const secret of [...this._secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED)
    }
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED)
    return out
  }

  redact<T>(value: T): T {
    if (typeof value === 'string') return this.redactString(value) as T
    if (Array.isArray(value)) return value.map((v) => this.redact(v)) as T
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = this.redact(v)
      return out as T
    }
    return value
  }
}
