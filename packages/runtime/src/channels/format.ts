import { channelCopy as t } from './copy.ts'

/** Longest piece of a command or path shown in a status line. */
const SHOWN = 48

const clip = (text: string, max = SHOWN) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const lastPart = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/') || path

/** What an agent is doing, from the tool it called, in a few words. */
export function toolPhrase(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const str = (key: string) => (typeof a[key] === 'string' ? (a[key] as string) : '')
  if (tool === 'shell') return t.doing.shell(clip(str('command').split('\n')[0] ?? ''))
  if (
    tool === 'fs_read' ||
    tool === 'read_artifact' ||
    tool === 'fs_list' ||
    tool === 'glob' ||
    tool === 'grep'
  )
    return t.doing.read(clip(lastPart(str('path') || str('name') || str('pattern') || '.')))
  if (tool === 'fs_write' || tool === 'fs_edit') return t.doing.edit(clip(lastPart(str('path'))))
  if (tool === 'web_search') return t.doing.search(clip(str('query')))
  if (tool === 'web_fetch') return t.doing.fetch
  if (tool.startsWith('browser_')) return t.doing.browser
  if (tool === 'publish_artifact') return t.doing.publish(clip(str('name')))
  if (tool === 'spawn_worker') return t.doing.helper
  if (tool === 'create_task' || tool === 'assign_task' || tool === 'update_todo') return t.doing.tasks
  return t.doing.tool(tool.replace(/_/g, ' '))
}

/** `2m 10s`, `45s`, `1h 3m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const money = (usd?: number) =>
  usd === undefined || usd <= 0 ? undefined : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`

const FENCE = /^\s*(```+|~~~+)(.*)$/

/**
 * Splits Markdown into pieces of at most `limit` characters: at paragraph breaks, else line breaks, else spaces. A
 * code block cut in two is closed at the end of one piece and reopened (with its language) at the start of the
 * next, so each piece renders on its own; several pieces get `(1/3)` marks.
 */
export function chunk(markdown: string, limit: number): string[] {
  const text = markdown.trim()
  // Room for the closing/reopening fence and the `(n/m)` mark.
  const room = Math.max(200, limit - 40)
  if (text.length <= limit) return [text]
  const pieces: string[] = []
  let rest = text
  let openFence: string | undefined
  while (rest.length) {
    const prefix = openFence ? `${openFence}\n` : ''
    if (prefix.length + rest.length <= room) {
      pieces.push(prefix + rest)
      break
    }
    const window = rest.slice(0, room - prefix.length)
    let cut = window.lastIndexOf('\n\n')
    if (cut < window.length / 3) cut = window.lastIndexOf('\n')
    if (cut < window.length / 3) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = window.length
    const body = rest.slice(0, cut).trimEnd()
    let piece = prefix + body
    rest = rest.slice(cut).replace(/^\s*\n/, '')
    // Which fence is still open at the end of this piece (the reopened one at its top is not new).
    let fence = openFence
    for (const line of body.split('\n')) {
      const m = FENCE.exec(line)
      if (!m) continue
      fence = fence ? undefined : `${m[1]}${(m[2] ?? '').trim()}`
    }
    if (fence) piece += `\n${fence.replace(/[^`~].*$/, '')}`
    openFence = fence
    pieces.push(piece)
  }
  return pieces.map((p, i) => `${p}\n\n(${i + 1}/${pieces.length})`)
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline Markdown (bold, italic, strike, code, links) in already-escaped text, as Telegram HTML. */
function inline(line: string): string {
  const codes: string[] = []
  // Inline code is taken out first (behind a private-use marker), so nothing inside it is formatted.
  let out = escapeHtml(line).replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\uE000${codes.length - 1}\uE000`
  })
  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
      return `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`
    })
    .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<b>$1</b>')
    .replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '<b>$1</b>')
    .replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '<s>$1</s>')
    .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, '<i>$1</i>')
    .replace(/(?<![\w_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w_])/g, '<i>$1</i>')
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => codes[Number(i)] ?? '')
}

/**
 * Markdown as the HTML subset Telegram accepts (`b`, `i`, `s`, `code`, `pre`, `a`): code blocks, headings as bold,
 * bullets as `•`, everything else escaped. Tags are always balanced, since Telegram refuses a message otherwise.
 */
export function telegramHtml(markdown: string): string {
  const out: string[] = []
  let code: { lang: string; lines: string[] } | undefined
  for (const line of markdown.split('\n')) {
    const fence = FENCE.exec(line)
    if (fence) {
      if (code) {
        const lang = code.lang ? ` class="language-${escapeHtml(code.lang)}"` : ''
        out.push(`<pre><code${lang}>${escapeHtml(code.lines.join('\n'))}</code></pre>`)
        code = undefined
      } else code = { lang: (fence[2] ?? '').trim().split(/\s/)[0] ?? '', lines: [] }
      continue
    }
    if (code) {
      code.lines.push(line)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`<b>${inline(heading[1] ?? '')}</b>`)
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      out.push(`${bullet[1] ?? ''}• ${inline(bullet[2] ?? '')}`)
      continue
    }
    out.push(inline(line.replace(/^>\s?/, '')))
  }
  // A block left open (a cut that missed its fence) is still closed.
  if (code) out.push(`<pre>${escapeHtml(code.lines.join('\n'))}</pre>`)
  return out.join('\n')
}
