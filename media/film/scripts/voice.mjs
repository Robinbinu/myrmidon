// Synthesizes the film's voice-over with Azure Speech (standard neural voices, which the free F0 tier covers):
// `bun scripts/voice.mjs` makes every line of src/vo.ts that is missing or changed into public/vo/<id>.mp3 and
// records its length in src/vo-manifest.json. `--audition` instead reads one short line in each of a few voices into
// out/audition/, to choose by ear.
//
// The key and region come from the environment (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION), or from the file
// VOICE_ENV_FILE names, of which only those two lines are read. They are never printed. A line already synthesized
// with the same voice, text and rate is never sent again, and every run adds the characters it sent to a running
// count in out/vo-chars.json, so the free allowance is easy to watch. Any refusal (quota, 401/403/429) stops the run.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { VO_LINES, VOICES } from '../src/vo.ts'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'public/vo')
const manifestPath = path.join(root, 'src/vo-manifest.json')
const countPath = path.join(root, 'out/vo-chars.json')
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
/** A hard ceiling on characters sent across every run, well inside the free tier's monthly allowance. */
const CAP = 15000

function credentials() {
  const env = { key: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION }
  const file = process.env.VOICE_ENV_FILE
  if ((!env.key || !env.region) && file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^(AZURE_SPEECH_KEY|AZURE_SPEECH_REGION)\s*=\s*(.*)$/.exec(line.trim())
      if (!m) continue
      const value = (m[2] ?? '').replace(/^["']|["']$/g, '')
      if (m[1] === 'AZURE_SPEECH_KEY') env.key ||= value
      else env.region ||= value
    }
  }
  if (!env.key || !env.region) throw new Error('Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION, or VOICE_ENV_FILE')
  return env
}

function ssml(voice, text, rate) {
  const body = rate ? `<prosody rate="${rate}">${text}</prosody>` : text
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">${body}</voice></speak>`
}

const counted = existsSync(countPath) ? JSON.parse(readFileSync(countPath, 'utf8')) : { total: 0 }
let sent = 0

async function synthesize(cred, doc, file) {
  if (counted.total + sent + doc.length > CAP) throw new Error(`Stopping: this would pass the ${CAP}-character cap`)
  const res = await fetch(`https://${cred.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cred.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
      'User-Agent': 'myrmidon-film',
    },
    body: doc,
  })
  sent += doc.length
  if (!res.ok) {
    // Only the status: the body may echo request details, and a refusal means stop, not retry.
    throw new Error(`Azure Speech refused the request (HTTP ${res.status}); stopping without retrying`)
  }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

/** A file's length in seconds, from ffmpeg decoding it. */
function seconds(file) {
  // ffmpeg reports progress on stderr; the last time= is the decoded length.
  const run = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  const last = [...String(run.stderr).matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1)
  if (!last) throw new Error(`Could not measure ${file}`)
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
}

/** Where a file is speech, as [start, end] seconds: the gaps between ffmpeg's detected silences. */
function speech(file, length) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-45dB:d=0.15', '-f', 'null', '-'], {
    encoding: 'utf8',
  })
  const marks = [...String(run.stderr).matchAll(/silence_(start|end): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])])
  const spans = []
  let from = 0
  for (const [kind, t] of marks) {
    if (kind === 'start') {
      if (t - from > 0.05) spans.push([from, t])
    } else from = t
  }
  const lastKind = marks.at(-1)?.[0]
  if (lastKind !== 'start' && length - from > 0.05) spans.push([from, length])
  return spans.map(([a, b]) => [Number(a.toFixed(3)), Number(b.toFixed(3))])
}

const cred = credentials()
try {
  if (process.argv.includes('--audition')) {
    const dir = path.join(root, 'out/audition')
    mkdirSync(dir, { recursive: true })
    const line = 'Ten AI tools. Ten tabs. None of them talk to each other.'
    for (const voice of ['en-US-AndrewMultilingualNeural', 'en-US-BrianMultilingualNeural', 'en-US-AvaMultilingualNeural']) {
      const file = path.join(dir, `${voice}.mp3`)
      if (!existsSync(file)) await synthesize(cred, ssml(voice, line), file)
      console.log(`${voice}: ${seconds(file).toFixed(2)} s`)
    }
  } else {
    mkdirSync(outDir, { recursive: true })
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
    for (const line of VO_LINES) {
      const doc = ssml(VOICES[line.speaker], line.text, line.rate)
      const hash = createHash('sha256').update(doc).digest('hex').slice(0, 16)
      const file = path.join(outDir, `${line.id}.mp3`)
      if (manifest[line.id]?.hash !== hash || !existsSync(file)) {
        await synthesize(cred, doc, file)
        manifest[line.id] = { hash, seconds: seconds(file) }
        console.log(`made ${line.id}: ${manifest[line.id].seconds.toFixed(2)} s`)
      } else console.log(`kept ${line.id}`)
      manifest[line.id].speech = speech(file, manifest[line.id].seconds)
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
} finally {
  mkdirSync(path.dirname(countPath), { recursive: true })
  counted.total += sent
  writeFileSync(countPath, `${JSON.stringify(counted)}\n`)
  console.log(`characters sent: ${sent} this run, ${counted.total} in all (cap ${CAP})`)
}

