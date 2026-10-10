import { VOICE_DOWNLOAD_IDLE_MS } from '../config.ts'
import { prompts } from '../prompts.ts'

/**
 * A voice model's file, whole: fails once the connection goes quiet for `idleMs` (no reply, or no new data), since a
 * stuck connection (seen: IPv6 SYN_SENT to a CDN) would otherwise hang the download, and the call waiting on it,
 * for good. `what` names the file in errors ("the speech detector").
 */
export async function fetchBytes(
  url: string,
  what: string,
  idleMs = VOICE_DOWNLOAD_IDLE_MS,
): Promise<Uint8Array> {
  const quiet = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const heard = () => {
    clearTimeout(timer)
    timer = setTimeout(() => quiet.abort(), idleMs)
  }
  const parts: Uint8Array[] = []
  try {
    heard()
    const res = await fetch(url, { signal: quiet.signal })
    if (!res.ok || !res.body) throw new Error(`downloading ${what} failed (${res.status})`)
    for await (const part of res.body) {
      heard()
      parts.push(part)
    }
  } catch (err) {
    if (quiet.signal.aborted)
      throw new Error(prompts.voice.downloadStalled(what, new URL(url).host, Math.ceil(idleMs / 1000)))
    throw err
  } finally {
    clearTimeout(timer)
  }
  return new Uint8Array(Buffer.concat(parts))
}
