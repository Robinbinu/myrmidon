import { timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import type { AdapterIO, InboundFile } from './types.ts'

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

/** Cuts a label to a platform's limit, marking the cut. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
