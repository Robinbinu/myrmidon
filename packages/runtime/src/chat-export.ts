/**
 * A chat as one HTML page that stands alone: every run's messages, the crew's messages folded, tool steps summed up
 * and small files embedded. It is meant to leave Myrmidon (sent on, opened offline, sealed into a share file), so
 * secrets are redacted on the way in, everything is escaped, and the page loads nothing: its own policy forbids
 * scripts and every request but its inline styles and embedded pictures.
 *
 * omp exports a session the same way (`/export`, export/html in pi-coding-agent): one file with its CSS inline,
 * `color-scheme: light dark` following the system, and no referrer. omp's page is a viewer app that renders session
 * JSON with scripts; a Myrmidon chat is rounds of colony events, so this page is rendered here instead and needs none.
 */

import {
  type ColonyState,
  type EventPayloads,
  foldColony,
  type MyrEvent,
  roundSlice,
} from '@myrmidon/protocol'
import { CHAT_EXPORT } from './config.ts'
import { prompts } from './prompts.ts'
import { redactSecrets } from './secrets.ts'

export interface ExportMessage {
  readonly from: string
  readonly text: string
  readonly attachments?: readonly string[]
}

export interface ExportCrewMessage {
  readonly from: string
  readonly to: string
  readonly text: string
}

export interface ExportStep {
  readonly tool: string
  readonly label: string
  readonly failed?: boolean
}

export interface ExportFile {
  readonly name: string
  readonly size: number
  /** A text file small enough to show. */
  readonly text?: string
  /** A picture small enough to show, as a data: URL. */
  readonly image?: string
}

export interface ExportRound {
  readonly round: number
  readonly request: string
  readonly status: string
  readonly messages: readonly ExportMessage[]
  readonly crew: readonly ExportCrewMessage[]
  readonly steps: readonly ExportStep[]
  readonly files: readonly ExportFile[]
}

/** What the page shows, already redacted. */
export interface ChatExportDoc {
  readonly title: string
  readonly exportedAt: string
  readonly project?: string
  /** The chat it was forked from, by title; `null` when that chat was deleted. */
  readonly forkOf?: string | null
  readonly imported?: { readonly source: string; readonly title: string }
  readonly rounds: readonly ExportRound[]
}

/** Where a chat's rounds are read from. */
export interface ExportSource {
  /** A colony's whole log. */
  events(colonyId: string): Promise<MyrEvent[]>
  /** A stored file's bytes, by blob hash. */
  blob(colonyId: string, hash: string): Promise<Uint8Array>
}

export interface ExportChat {
  readonly title: string
  readonly rounds: readonly { readonly colonyId: string; readonly round: number }[]
  readonly project?: string
  readonly forkOf?: string | null
  readonly imported?: { readonly source: string; readonly title: string }
}

const r = redactSecrets

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Media types shown as text; anything else that is not a picture is named only. */
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql|graphql))/
/** Pictures a browser shows from a data: URL without running anything (an SVG in <img> runs no script). */
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/

/** The argument a step is best known by: the file, command, query or address it was called on. */
const STEP_KEYS = ['path', 'file', 'command', 'cmd', 'query', 'url', 'pattern', 'name', 'to', 'code'] as const

function stepLabel(tool: string, args: unknown): string {
  let on = ''
  if (typeof args === 'string') on = args
  else if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>
    const key = STEP_KEYS.find((k) => typeof record[k] === 'string' && record[k])
    on = key ? String(record[key]) : ''
  }
  const line = on.replace(/\s+/g, ' ').trim()
  return clip(r(line ? `${tool} ${line}` : tool), CHAT_EXPORT.stepChars)
}

/** Reads a chat's rounds into what its page shows, redacting every text on the way. */
export async function exportDoc(
  chat: ExportChat,
  source: ExportSource,
  now = new Date(),
): Promise<ChatExportDoc> {
  const colonies = new Map<string, { events: MyrEvent[]; state: ColonyState }>()
  let embedded = 0
  const rounds: ExportRound[] = []
  for (const ref of chat.rounds) {
    let colony = colonies.get(ref.colonyId)
    if (!colony) {
      const events = await source.events(ref.colonyId)
      colony = { events, state: foldColony(ref.colonyId, events) }
      colonies.set(ref.colonyId, colony)
    }
    const { state, info } = roundSlice(colony.state, colony.events, ref.round)
    const from = info?.startSeq ?? 0
    const to = info?.endSeq ?? Number.POSITIVE_INFINITY
    const inRound = (seq: number) => seq >= from && seq <= to
    const messages = state.chatMessages.map((m) => ({
      from: m.from,
      text: r(m.plan ? `${m.text}\n\n${m.plan}` : m.text),
      ...(m.attachments?.length ? { attachments: m.attachments.map(r) } : {}),
    }))
    const crew: ExportCrewMessage[] = [
      ...state.mail
        .filter((m) => inRound(m.seq))
        .map((m) => ({
          seq: m.seq,
          from: m.from,
          to: m.to,
          text: m.subject ? `${m.subject}\n\n${m.body}` : m.body,
        })),
      ...state.board
        .filter((b) => inRound(b.seq))
        .map((b) => ({ seq: b.seq, from: b.agent, to: prompts.exportPage.teamChat, text: b.text })),
    ]
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ from: m.from, to: r(m.to), text: clip(r(m.text), CHAT_EXPORT.crewChars) }))
    const failed = new Set(
      colony.events
        .filter((e) => e.type === 'tool/result' && inRound(e.seq))
        .map((e) => e.payload as EventPayloads['tool/result'])
        .filter((p) => !p.ok)
        .map((p) => p.callId),
    )
    const steps = colony.events
      .filter((e) => e.type === 'tool/call' && inRound(e.seq))
      .map((e) => {
        const p = e.payload as EventPayloads['tool/call']
        return {
          tool: p.tool,
          label: stepLabel(p.tool, p.args),
          ...(failed.has(p.callId) ? { failed: true } : {}),
        }
      })
    const files: ExportFile[] = []
    for (const [name, versions] of Object.entries(state.artifacts)) {
      const latest = versions.filter((v) => inRound(v.seq) && v.author !== 'user').at(-1)
      if (!latest) continue
      const file = { name: r(name), size: latest.size }
      const room = CHAT_EXPORT.totalBytes - embedded
      const text = TEXT_TYPE.test(latest.mediaType) && latest.size <= Math.min(CHAT_EXPORT.textBytes, room)
      const image = IMAGE_TYPE.test(latest.mediaType) && latest.size <= Math.min(CHAT_EXPORT.imageBytes, room)
      if (!text && !image) {
        files.push(file)
        continue
      }
      const bytes = await source.blob(ref.colonyId, latest.blob).catch(() => undefined)
      if (!bytes) {
        files.push(file)
        continue
      }
      if (image) {
        embedded += bytes.byteLength
        files.push({
          ...file,
          image: `data:${latest.mediaType};base64,${Buffer.from(bytes).toString('base64')}`,
        })
        continue
      }
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        embedded += bytes.byteLength
        files.push({ ...file, text: r(decoded) })
      } catch {
        // Typed as text but not UTF-8 (a mislabelled binary): named, never shown as garbage.
        files.push(file)
      }
    }
    rounds.push({
      round: ref.round,
      request: r(info?.request ?? ''),
      status: info?.status ?? state.status,
      messages,
      crew,
      steps,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
  return {
    title: r(chat.title),
    exportedAt: now.toISOString(),
    ...(chat.project ? { project: r(chat.project) } : {}),
    ...(chat.forkOf !== undefined ? { forkOf: chat.forkOf === null ? null : r(chat.forkOf) } : {}),
    ...(chat.imported ? { imported: { source: chat.imported.source, title: r(chat.imported.title) } } : {}),
    rounds,
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/**
 * A message's Markdown, as far as a reader needs it: code blocks, inline code, bold and paragraphs. Escaped first, so
 * nothing in the text can become markup; links stay text, so the page points nowhere.
 */
function prose(text: string): string {
  const parts = text.split(/^```[^\n]*\n?/m)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`
      return part
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map(
          (p) =>
            `<p>${escapeHtml(p)
              .replace(/`([^`\n]+)`/g, '<code>$1</code>')
              .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
              .replace(/\n/g, '<br>')}</p>`,
        )
        .join('')
    })
    .join('')
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The most used tools first, as `read ×5, bash ×4`. */
function topTools(steps: readonly ExportStep[]): string {
  const counts = new Map<string, number>()
  for (const s of steps) counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([tool, n]) => `${tool} ×${n}`)
    .join(', ')
}

function roundHtml(round: ExportRound): string {
  const t = prompts.exportPage
  const messages = round.messages.length
    ? round.messages
        .map((m) => {
          const you = m.from === 'user'
          const attached = m.attachments?.length
            ? `<p class="note">${escapeHtml(t.attached(m.attachments.join(', ')))}</p>`
            : ''
          return `<article class="msg${you ? ' you' : ''}"><div class="who">${escapeHtml(you ? t.you : m.from)}</div><div class="body">${prose(m.text)}${attached}</div></article>`
        })
        .join('')
    : `<p class="note">${escapeHtml(t.noMessages)}</p>`
  const crew = round.crew.length
    ? `<details class="fold"><summary>${escapeHtml(t.crew(round.crew.length))}</summary>${round.crew
        .map(
          (m) =>
            `<div class="crew"><div class="who">${escapeHtml(t.crewTo(m.from, m.to))}</div><div class="body">${prose(m.text)}</div></div>`,
        )
        .join('')}</details>`
    : ''
  const failed = round.steps.filter((s) => s.failed).length
  const listed = round.steps.slice(0, CHAT_EXPORT.stepsListed)
  const steps = round.steps.length
    ? `<details class="fold"><summary>${escapeHtml(t.steps(round.steps.length, topTools(round.steps)))}${
        failed ? ` · <span class="bad">${escapeHtml(t.stepsFailed(failed))}</span>` : ''
      }</summary><ol class="steps">${listed
        .map(
          (s) =>
            `<li><code>${escapeHtml(s.label)}</code>${s.failed ? ` <span class="bad">${escapeHtml(t.stepFailed)}</span>` : ''}</li>`,
        )
        .join('')}</ol>${
        round.steps.length > listed.length
          ? `<p class="note">${escapeHtml(t.moreSteps(round.steps.length - listed.length))}</p>`
          : ''
      }</details>`
    : ''
  const files = round.files.length
    ? `<div class="files"><h3>${escapeHtml(t.files)}</h3>${round.files
        .map((f) => {
          const name = `<code>${escapeHtml(f.name)}</code>`
          if (f.image)
            return `<figure><img src="${escapeHtml(f.image)}" alt="${escapeHtml(f.name)}"><figcaption>${name} · ${size(f.size)}</figcaption></figure>`
          if (f.text !== undefined)
            return `<details class="fold"><summary>${name} · ${size(f.size)}</summary><pre><code>${escapeHtml(f.text)}</code></pre></details>`
          return `<p class="file">${name} · ${escapeHtml(t.fileLeftOut(size(f.size)))}</p>`
        })
        .join('')}</div>`
    : ''
  const status = t.status[round.status] ?? round.status
  return `<section class="run" id="run-${round.round}"><h2>${escapeHtml(t.run(round.round))} <span class="status ${escapeHtml(round.status)}">${escapeHtml(status)}</span></h2>${messages}${crew}${steps}${files}</section>`
}

/**
 * Light and dark follow the reader's system, after the app's tokens (tokens.css) and system fonts: the page loads
 * no fonts, since it must look the same offline.
 */
const STYLE = `
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--fg2:#424245;--muted:#616166;--line:rgb(0 0 0/.1);--fill:#f2f2f7;--accent:#ffb31a;--accent-soft:rgb(255 179 26/.16);--accent-text:#8a5a00;--ok:#007928;--bad:#d70015;--code:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--card:#2c2c2e;--fg:#f5f5f7;--fg2:#d1d1d6;--muted:#a1a1a6;--line:rgb(255 255 255/.12);--fill:#3a3a3c;--accent-soft:rgb(255 179 26/.2);--accent-text:#ffc94d;--ok:#30d158;--bad:#ff6961;--code:#1c1c1e}}
*{box-sizing:border-box}
html{background:var(--bg);min-height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:820px;margin:0 auto;padding:40px 20px 64px}
header{margin-bottom:28px}
.eyebrow{margin:0;color:var(--accent-text);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
h1{margin:4px 0 6px;font-size:26px;line-height:1.25;letter-spacing:-.01em}
h2{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:17px}
h3{margin:16px 0 8px;font-size:13px;color:var(--muted);font-weight:600}
.meta,.note,.file{margin:2px 0;color:var(--muted);font-size:13px}
.run{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 16px}
.status{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--fill);color:var(--fg2)}
.status.completed{color:var(--ok)}.status.failed{color:var(--bad)}
.msg{margin:0 0 14px}.msg.you .body{background:var(--accent-soft);border-radius:12px;padding:8px 12px}
.who{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:2px}
.body p{margin:0 0 8px}.body p:last-child{margin-bottom:0}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.45}
code{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
p code,li code{background:var(--fill);border-radius:4px;padding:0 4px}
.fold{border-top:1px solid var(--line);padding:8px 0 0;margin-top:10px}
summary{cursor:pointer;color:var(--fg2);font-size:13px;font-weight:600}
.crew{margin:10px 0 0 4px;padding-left:10px;border-left:2px solid var(--line)}
.steps{margin:8px 0 0;padding-left:22px;font-size:13px;color:var(--fg2)}
.bad{color:var(--bad);font-weight:600}
figure{margin:8px 0}img{max-width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
figcaption{color:var(--muted);font-size:12px;margin-top:4px}
footer{color:var(--muted);font-size:12px;margin-top:24px}
`
  .replace(/\n/g, '')
  .trim()

/**
 * Nothing may load or run: no script, no fetch, no form, no frame; only the inline styles and data: pictures. The
 * page is sent to people and opened from disk, where it must neither phone home nor run anything a chat contained.
 */
export const EXPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

/** The page, as one self-contained HTML file. */
export function renderChatHtml(doc: ChatExportDoc): string {
  const t = prompts.exportPage
  const when = new Date(doc.exportedAt).toUTCString()
  const meta = [
    t.exported(when),
    t.runs(doc.rounds.length),
    ...(doc.project ? [t.project(doc.project)] : []),
  ].join(' · ')
  const origin =
    doc.forkOf !== undefined
      ? doc.forkOf === null
        ? t.forkOfGone
        : t.forkOf(doc.forkOf)
      : doc.imported
        ? t.imported(t.tools[doc.imported.source] ?? doc.imported.source, doc.imported.title)
        : ''
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    `<title>${escapeHtml(doc.title)}</title><style>${STYLE}</style></head>`,
    '<body><main><header>',
    `<p class="eyebrow">${escapeHtml(t.eyebrow)}</p><h1>${escapeHtml(doc.title)}</h1>`,
    `<p class="meta">${escapeHtml(meta)}</p>`,
    origin ? `<p class="meta">${escapeHtml(origin)}</p>` : '',
    '</header>',
    ...doc.rounds.map(roundHtml),
    `<footer>${escapeHtml(t.footer)}</footer>`,
    '</main></body></html>',
  ].join('')
}
