import { createHash, createHmac } from 'node:crypto'
import { VOICE_LANGUAGE } from '../../config.ts'
import {
  bytesOf,
  failure,
  HttpPcmTts,
  json,
  StreamingStt,
  timed,
  type WsProtocol,
  WsTranscription,
  xmlText,
} from './common.ts'

/**
 * AWS without its SDK (after Pipecat's AWSTranscribeSTTService and its aws/utils.py): Signature Version 4 by hand,
 * Polly's SynthesizeSpeech as raw 16 kHz PCM (it streams), and Transcribe Streaming over its presigned WebSocket, whose
 * messages are AWS event-stream frames (a prelude, headers, the payload, two CRC32s). The stream ends with an empty
 * audio event, as AWS documents (Pipecat sends a JSON frame instead).
 * https://docs.aws.amazon.com/transcribe/latest/dg/streaming-setting-up.html,
 * https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html
 */
export interface AwsCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** The vault holds AWS's two parts as one JSON string. */
export function awsCredentials(key: string): AwsCredentials {
  let parsed: Partial<AwsCredentials>
  try {
    parsed = JSON.parse(key) as Partial<AwsCredentials>
  } catch {
    throw new Error(
      'the AWS key is not an access key id and secret: add it again in Settings → Models & providers',
    )
  }
  if (!parsed.accessKeyId || !parsed.secretAccessKey)
    throw new Error('the AWS key needs an access key id and a secret access key')
  return {
    accessKeyId: parsed.accessKeyId,
    secretAccessKey: parsed.secretAccessKey,
    ...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {}),
  }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding, which SigV4 wants (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

function stamp(now: Date): { amzDate: string; date: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  return { amzDate, date: amzDate.slice(0, 8) }
}

function signature(secret: string, date: string, region: string, service: string, toSign: string): string {
  const kDate = hmac(`AWS4${secret}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  return createHmac('sha256', kSigning).update(toSign).digest('hex')
}

/** Headers signing a request (SigV4, header form). */
export function signRequest(o: {
  credentials: AwsCredentials
  region: string
  service: string
  method: string
  url: URL
  headers: Record<string, string>
  body: string
  now?: Date
}): Record<string, string> {
  const { amzDate, date } = stamp(o.now ?? new Date())
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: o.url.host,
    'x-amz-date': amzDate,
    ...(o.credentials.sessionToken ? { 'x-amz-security-token': o.credentials.sessionToken } : {}),
  }
  const names = Object.keys(headers).sort()
  const query = [...o.url.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a = ''], [b = '']) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [
    o.method,
    o.url.pathname,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    sha256(o.body),
  ].join('\n')
  const scope = `${date}/${o.region}/${o.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const sig = signature(o.credentials.secretAccessKey, date, o.region, o.service, toSign)
  const { host: _host, ...rest } = headers
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`,
  }
}

/** A presigned URL (SigV4, query form, signing only the host): how Transcribe's WebSocket is opened. */
export function presign(o: {
  credentials: AwsCredentials
  region: string
  service: string
  host: string
  path: string
  params: Record<string, string>
  expires?: number
  now?: Date
}): string {
  const { amzDate, date } = stamp(o.now ?? new Date())
  const scope = `${date}/${o.region}/${o.service}/aws4_request`
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(o.expires ?? 300),
    ...(o.credentials.sessionToken ? { 'X-Amz-Security-Token': o.credentials.sessionToken } : {}),
    'X-Amz-SignedHeaders': 'host',
    ...o.params,
  }
  const query = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k] ?? '')}`)
    .join('&')
  const canonical = ['GET', o.path, query, `host:${o.host}\n`, 'host', sha256('')].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const sig = signature(o.credentials.secretAccessKey, date, o.region, o.service, toSign)
  return `wss://${o.host}${o.path}?${query}&X-Amz-Signature=${sig}`
}

/** One AWS event-stream message: string headers (all Transcribe uses), then the payload. */
export function encodeEvent(headers: Record<string, string>, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const parts: number[] = []
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name)
    const v = enc.encode(value)
    parts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v)
  }
  const headerBytes = Uint8Array.from(parts)
  const total = 12 + headerBytes.length + payload.length + 4
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, Bun.hash.crc32(out.subarray(0, 8)))
  out.set(headerBytes, 12)
  out.set(payload, 12 + headerBytes.length)
  view.setUint32(total - 4, Bun.hash.crc32(out.subarray(0, total - 4)))
  return out
}

/** An AWS event-stream message's headers and payload; throws when its checksums do not match. */
export function decodeEvent(bytes: Uint8Array): { headers: Record<string, string>; payload: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const total = view.getUint32(0)
  const headersLength = view.getUint32(4)
  if (total !== bytes.length || view.getUint32(8) !== Bun.hash.crc32(bytes.subarray(0, 8)))
    throw new Error('a damaged AWS event (prelude)')
  if (view.getUint32(total - 4) !== Bun.hash.crc32(bytes.subarray(0, total - 4)))
    throw new Error('a damaged AWS event')
  const dec = new TextDecoder()
  const headers: Record<string, string> = {}
  let at = 12
  const end = 12 + headersLength
  while (at < end) {
    const nameLength = bytes[at] ?? 0
    const name = dec.decode(bytes.subarray(at + 1, at + 1 + nameLength))
    at += 1 + nameLength
    const type = bytes[at] ?? 0
    at += 1
    // Sizes of the fixed-size header types (bool true/false, byte, short, int, long, timestamp, uuid).
    const fixed: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
    if (type === 6 || type === 7) {
      const length = view.getUint16(at)
      const value = bytes.subarray(at + 2, at + 2 + length)
      if (type === 7) headers[name] = dec.decode(value)
      at += 2 + length
    } else if (type in fixed) at += fixed[type] ?? 0
    else throw new Error(`an AWS event header of unknown type ${type}`)
  }
  return { headers, payload: bytes.subarray(end, total - 4) }
}

const AUDIO_EVENT = {
  ':content-type': 'application/octet-stream',
  ':event-type': 'AudioEvent',
  ':message-type': 'event',
}

export interface AwsOptions {
  readonly key: string
  readonly region: string
  readonly language?: string
  readonly log?: (line: string) => void
  /** Tests point it at a stand-in (a ws:// or http:// address). */
  readonly ws?: string
  readonly api?: string
}

export function transcribeProtocol(o: AwsOptions, sampleRate: number): WsProtocol {
  return {
    what: 'AWS Transcribe',
    url: () => {
      const host = `transcribestreaming.${o.region}.amazonaws.com:8443`
      const signed = presign({
        credentials: awsCredentials(o.key),
        region: o.region,
        service: 'transcribe',
        host,
        path: '/stream-transcription-websocket',
        params: {
          'language-code': o.language ?? VOICE_LANGUAGE,
          'media-encoding': 'pcm',
          'sample-rate': String(sampleRate),
          'enable-partial-results-stabilization': 'true',
          'partial-results-stability': 'high',
        },
      })
      return o.ws ? `${o.ws}${signed.slice(signed.indexOf('/stream-transcription-websocket'))}` : signed
    },
    audio: (pcm) => encodeEvent(AUDIO_EVENT, bytesOf(pcm)),
    // An empty audio event ends the stream: AWS sends the last results, then closes.
    end: () => [encodeEvent(AUDIO_EVENT, new Uint8Array(0))],
    read(message) {
      if (typeof message === 'string') return {}
      const { headers, payload } = decodeEvent(message)
      const body = json(payload)
      if (headers[':message-type'] === 'exception')
        return { error: `${headers[':exception-type'] ?? 'error'}: ${String(body?.Message ?? '')}` }
      if (headers[':event-type'] !== 'TranscriptEvent') return {}
      const results =
        (
          body?.Transcript as {
            Results?: { IsPartial?: boolean; Alternatives?: { Transcript?: string }[] }[]
          }
        )?.Results ?? []
      const result = results[0]
      if (!result) return {}
      const text = result.Alternatives?.[0]?.Transcript ?? ''
      return result.IsPartial ? { partial: text } : { final: text }
    },
  }
}

/** Transcribe has no quick batch API (a job reads from S3): a whole turn goes through a stream of its own. */
export function awsStt(o: AwsOptions): StreamingStt {
  return new StreamingStt(
    (sampleRate, heard, options) =>
      new WsTranscription(transcribeProtocol(o, sampleRate), sampleRate, heard, options.log),
    o.log,
  )
}

/** Polly's PCM is 8 or 16 kHz. */
export function pollyTts(o: AwsOptions & { voice: string; engine: string; speed?: number }): HttpPcmTts {
  const rate = 16_000
  return new HttpPcmTts('AWS Polly speech', rate, (text, signal) => {
    const url = new URL(`${o.api ?? `https://polly.${o.region}.amazonaws.com`}/v1/speech`)
    const speed = o.speed && o.speed !== 1 ? `${Math.round(o.speed * 100)}%` : undefined
    const body = JSON.stringify({
      Engine: o.engine,
      OutputFormat: 'pcm',
      SampleRate: String(rate),
      Text: speed ? `<speak><prosody rate="${speed}">${xmlText(text)}</prosody></speak>` : text,
      TextType: speed ? 'ssml' : 'text',
      VoiceId: o.voice,
    })
    const headers = signRequest({
      credentials: awsCredentials(o.key),
      region: o.region,
      service: 'polly',
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      body,
    })
    return fetch(url, { method: 'POST', headers, body, signal })
  })
}

export async function pollyVoices(
  o: AwsOptions & { engine: string },
): Promise<{ id: string; label: string }[]> {
  const url = new URL(`${o.api ?? `https://polly.${o.region}.amazonaws.com`}/v1/voices`)
  url.searchParams.set('Engine', o.engine)
  url.searchParams.set('LanguageCode', o.language ?? VOICE_LANGUAGE)
  const headers = signRequest({
    credentials: awsCredentials(o.key),
    region: o.region,
    service: 'polly',
    method: 'GET',
    url,
    headers: {},
    body: '',
  })
  const res = await fetch(url, { headers, signal: timed() })
  if (!res.ok) throw await failure('AWS Polly voices', res)
  const body = (await res.json()) as { Voices?: { Id?: string; Name?: string; Gender?: string }[] }
  return (body.Voices ?? []).flatMap((v) => (v.Id ? [{ id: v.Id, label: v.Name ?? v.Id }] : []))
}

/** Polly's engines are its "models". */
export const POLLY_ENGINES = [
  { id: 'neural', label: 'Neural' },
  { id: 'generative', label: 'Generative' },
  { id: 'standard', label: 'Standard' },
] as const
export const POLLY_VOICES = [
  { id: 'Joanna', label: 'Joanna' },
  { id: 'Matthew', label: 'Matthew' },
  { id: 'Ruth', label: 'Ruth' },
  { id: 'Stephen', label: 'Stephen' },
  { id: 'Danielle', label: 'Danielle' },
] as const
export const TRANSCRIBE_MODELS = [{ id: 'streaming', label: 'Streaming' }] as const
