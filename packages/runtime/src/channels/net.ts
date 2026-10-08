import { timingSafeEqual } from 'node:crypto'

/**
 * What the Feishu, DingTalk, WeCom, WeChat and QQ adapters share: waits that end when the channel stops, reconnect
 * delays, a cached access token, constant-time comparison, Markdown flattened for platforms that show plain text,
 * and splitting by bytes for platforms that count them.
 */

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

/** A reconnect delay with jitter, so many gateways recovering together do not hit a platform at the same moment. */
export const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5)

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Two secrets compared without leaking, through timing, how much of them matched. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * An access token fetched once and reused until shortly before it expires; concurrent callers share one fetch.
 * `reset` drops it when the platform says it is no longer valid.
 */
export class AccessToken {
  private _value?: { token: string; until: number }
  private _pending?: Promise<string>

  constructor(private readonly fetchToken: () => Promise<{ token: string; expiresIn: number }>) {}

  async get(): Promise<string> {
    if (this._value && Date.now() < this._value.until) return this._value.token
    this._pending ??= this.fetchToken()
      .then(({ token, expiresIn }) => {
        // A minute early, so a token never expires between being handed out and being used.
        this._value = { token, until: Date.now() + Math.max(60, expiresIn - 60) * 1000 }
        return token
      })
      .finally(() => {
        this._pending = undefined
      })
    return this._pending
  }

  reset() {
    this._value = undefined
  }
}

/** Markdown as readable plain text, for platforms that show it literally (WeCom text, QQ without markdown). */
export function plainText(markdown: string): string {
  const out: string[] = []
  let inCode = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    out.push(
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/^>\s?/, '')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
        .replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '$1')
        .replace(/__(?!\s)([^_\n]+?)__/g, '$1')
        .replace(/~~(?!\s)([^~\n]+?)~~/g, '$1')
        .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1'),
    )
  }
  return out.join('\n')
}

/** Text in pieces of at most `max` UTF-8 bytes, cut at line breaks or spaces where it can. */
export function splitBytes(text: string, max: number): string[] {
  const size = (s: string) => Buffer.byteLength(s, 'utf8')
  const pieces: string[] = []
  let rest = text
  while (size(rest) > max) {
    // The longest prefix that fits, found by characters (so a multi-byte character is never cut).
    let end = 0
    let bytes = 0
    for (const ch of rest) {
      const n = size(ch)
      if (bytes + n > max) break
      bytes += n
      end += ch.length
    }
    const window = rest.slice(0, end)
    let cut = window.lastIndexOf('\n')
    if (cut < window.length / 3) cut = window.lastIndexOf(' ')
    if (cut < window.length / 3) cut = window.length
    pieces.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) pieces.push(rest)
  return pieces
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  amr: 'audio/amr',
  silk: 'audio/silk',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** A file's type from its name, for platforms that send names without types. */
export const mimeOf = (name: string) =>
  MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
