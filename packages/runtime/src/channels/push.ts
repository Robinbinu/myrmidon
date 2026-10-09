import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelCopy } from './copy.ts'
import type { AdapterIO, InboundFile, OutFile } from './types.ts'

/** What the platforms that push messages to the gateway by webhook (Teams, Google Chat, LINE) share. */

/** The platform refused the credentials: trying again will not help until the person changes them. */
export class RefusedError extends Error {}

const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** Files coming in larger than this are not downloaded (the hub refuses more than 10 MB anyway). */
export const DOWNLOAD_MAX = 20 * 1024 * 1024

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
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
 * Brings a webhook platform up: an error without the gateway's public address (nothing could reach it), otherwise
 * its credentials checked (and `setup` run), retrying with backoff through network trouble and stopping on a
 * refusal. Resolves once on, refused or stopped.
 */
export async function connectPushed(
  label: string,
  io: AdapterIO,
  signal: AbortSignal,
  check: () => Promise<string>,
  setup?: (webhookUrl: string) => Promise<void>,
): Promise<void> {
  const { webhookUrl } = io
  if (!webhookUrl) return io.status({ state: 'error', error: channelCopy.needsPublicUrl(label) })
  io.status({ state: 'connecting' })
  let backoff = BACKOFF_MIN_MS
  while (!signal.aborted) {
    try {
      const account = await check()
      await setup?.(webhookUrl)
      return io.status({ state: 'on', account })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (err instanceof RefusedError) return io.status({ state: 'error', error })
      io.status({ state: 'retrying', error })
      await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }
}

/** Compares a secret in constant time. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

/** A file's media type from its name (Bun's table), without parameters. */
export const mimeOf = (name: string) =>
  Bun.file(name.toLowerCase()).type.split(';')[0] || 'application/octet-stream'

export const kindOf = (mime: string): InboundFile['kind'] =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : mime.startsWith('video/')
        ? 'video'
        : 'document'

/** Reads a download, refusing one larger than `DOWNLOAD_MAX`; `what` names the platform in errors. */
export async function download(what: string, res: Response): Promise<Uint8Array> {
  if (!res.ok) throw new Error(`${what} answered ${res.status} for the file`)
  if (Number(res.headers.get('content-length') ?? 0) > DOWNLOAD_MAX)
    throw new Error(`${what}: the file is larger than 20 MB`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.byteLength > DOWNLOAD_MAX) throw new Error(`${what}: the file is larger than 20 MB`)
  return data
}

/** How long a file handed out as a link can be downloaded. */
export const HOSTED_DAYS = 7
const HOSTED_MS = HOSTED_DAYS * 24 * 3600_000
/** 24 random bytes in base64url: unguessable, and safe as a file name. */
const HOSTED_TOKEN = /^[\w-]{32}$/
/** Shown in place where a browser opens them; anything else is a download, so nothing can run on the gateway's origin. */
const HOSTED_INLINE = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/)/

interface HostedMeta {
  readonly name: string
  readonly mimeType: string
  readonly expires: number
}

const hostedDir = (io: AdapterIO) => join(io.dir, 'hosted')

/** Drops hosted files past their time (and any without readable details). */
function pruneHosted(dir: string, now: number) {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const token = entry.slice(0, -5)
    let expires = 0
    try {
      expires = (JSON.parse(readFileSync(join(dir, entry), 'utf8')) as HostedMeta).expires
    } catch {
      // Unreadable details: dropped like an expired file.
    }
    if (!(expires > now)) for (const f of [entry, token]) rmSync(join(dir, f), { force: true })
  }
}

/**
 * Keeps a file in the channel's own folder under an unguessable name and says where it can be downloaded: the
 * channel's webhook address with `?file=<token>`, which `serveHosted` answers for `HOSTED_DAYS`. For platforms that
 * fetch a file from a URL instead of taking its bytes (LINE) or take no file from a bot at all (Google Chat, Teams
 * beyond small images). Unlike Synology Chat's, whose NAS fetches its file at once, these links are opened by people
 * whenever they get to them, so they last days and are kept on disk across restarts. As with any shared download
 * link, the link is the only key. Undefined without an HTTPS public address, so no file goes out over plain HTTP.
 */
export function hostFile(io: AdapterIO | undefined, file: OutFile, now = Date.now()): string | undefined {
  const base = io?.webhookUrl
  if (!io || !base?.startsWith('https://')) return undefined
  const dir = hostedDir(io)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  pruneHosted(dir, now)
  const token = randomBytes(24).toString('base64url')
  const meta: HostedMeta = { name: file.name, mimeType: file.mimeType, expires: now + HOSTED_MS }
  writeFileSync(join(dir, token), file.data, { mode: 0o600 })
  writeFileSync(join(dir, `${token}.json`), JSON.stringify(meta), { mode: 0o600 })
  const url = new URL(base)
  url.searchParams.set('file', token)
  return url.toString()
}

/** Answers a download of a hosted file (a GET carrying `?file=`); undefined for any other request. */
export function serveHosted(io: AdapterIO | undefined, req: Request, now = Date.now()): Response | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined
  const token = new URL(req.url).searchParams.get('file')
  if (token === null) return undefined
  const gone = () => new Response('not found', { status: 404 })
  if (!io || !HOSTED_TOKEN.test(token)) return gone()
  const dir = hostedDir(io)
  let meta: HostedMeta
  let data: Uint8Array<ArrayBuffer>
  try {
    meta = JSON.parse(readFileSync(join(dir, `${token}.json`), 'utf8')) as HostedMeta
    if (!(meta.expires > now)) {
      pruneHosted(dir, now)
      return gone()
    }
    data = new Uint8Array(readFileSync(join(dir, token)))
  } catch {
    return gone()
  }
  const inline = HOSTED_INLINE.test(meta.mimeType)
  return new Response(req.method === 'HEAD' ? null : data, {
    headers: {
      'content-type': meta.mimeType,
      'content-length': String(data.byteLength),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })
}

/** Cuts a label to a platform's limit, marking the cut. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
