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

/**
 * Markdown as Matrix's `org.matrix.custom.html`: the Telegram subset (which Matrix clients all render), with line
 * breaks as `<br>` outside code blocks, since HTML folds newlines.
 */
export function matrixHtml(markdown: string): string {
  return telegramHtml(markdown)
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\n/g, '<br>')))
    .join('')
}

type TextStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE'
interface Styled {
  text: string
  ranges: { start: number; length: number; style: TextStyle }[]
}

const INLINE_MD =
  /`([^`\n]+)`|\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*|__(?!\s)([^_\n]+?)(?<!\s)__|~~(?!\s)([^~\n]+?)(?<!\s)~~|(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])|(?<![\w_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

/** Inline Markdown appended to `out` as plain text, its markers turned into style ranges (nested ones too). */
function styledInline(line: string, out: Styled) {
  let last = 0
  for (const m of line.matchAll(INLINE_MD)) {
    out.text += line.slice(last, m.index)
    last = m.index + m[0].length
    const [, code, bold, bold2, strike, italic, italic2, label, url] = m
    const start = out.text.length
    if (code !== undefined) {
      out.text += code
      out.ranges.push({ start, length: code.length, style: 'MONOSPACE' })
    } else if (label !== undefined) out.text += label === url ? label : `${label} (${url})`
    else {
      styledInline(bold ?? bold2 ?? strike ?? italic ?? italic2 ?? '', out)
      const style =
        bold !== undefined || bold2 !== undefined ? 'BOLD' : strike !== undefined ? 'STRIKETHROUGH' : 'ITALIC'
      out.ranges.push({ start, length: out.text.length - start, style })
    }
  }
  out.text += line.slice(last)
}

/**
 * Markdown as plain text with Signal's own text styles (Hermes's `markdown_to_signal`): `start:length:STYLE` ranges
 * in UTF-16 units, which is how JavaScript counts string length. Code blocks are monospace, headings bold, bullets
 * `•`, links `label (url)`.
 */
export function signalText(markdown: string): { text: string; styles: string[] } {
  const out: Styled = { text: '', ranges: [] }
  let lines = 0
  const newLine = () => {
    if (lines++) out.text += '\n'
  }
  let code: { start?: number } | undefined
  const closeCode = () => {
    if (code?.start !== undefined && out.text.length > code.start)
      out.ranges.push({ start: code.start, length: out.text.length - code.start, style: 'MONOSPACE' })
    code = undefined
  }
  for (const line of markdown
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')) {
    if (FENCE.test(line)) {
      if (code) closeCode()
      else code = {}
      continue
    }
    newLine()
    if (code) {
      code.start ??= out.text.length
      out.text += line
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      const start = out.text.length
      styledInline(heading[1] ?? '', out)
      out.ranges.push({ start, length: out.text.length - start, style: 'BOLD' })
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      out.text += `${bullet[1] ?? ''}• `
      styledInline(bullet[2] ?? '', out)
      continue
    }
    styledInline(line, out)
  }
  closeCode()
  const styles = out.ranges
    .filter((r) => r.length > 0)
    .sort((a, b) => a.start - b.start)
    .map((r) => `${r.start}:${r.length}:${r.style}`)
  return { text: out.text, styles }
}

/** Markdown as plain text, for platforms that show no formatting (iMessage): the text of `signalText`. */
export const plainText = (markdown: string) => signalText(markdown).text

/** Slack's three escapes, which it wants everywhere (inside code too). */
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline Markdown in Slack's mrkdwn: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, `<url|label>`. */
function slackInline(line: string): string {
  const kept: string[] = []
  // Code and links are set aside first (behind private-use markers), so nothing inside them is formatted.
  const keep = (s: string) => `${kept.push(s) - 1}`
  const out = escapeSlack(
    line
      .replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`\`${escapeSlack(code)}\``))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s|>]+)\)/g, (_m, label: string, url: string) =>
        keep(`<${url.replace(/&/g, '&amp;')}|${escapeSlack(label)}>`),
      ),
  )
    // Bold goes behind a marker so the italic pass does not take its `*` for italics.
    .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '$1')
    .replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '$1')
    .replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '~$1~')
    .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, '_$1_')
    // Slack misses a closing `*` right after punctuation (and shows the rest raw): a zero-width space goes between.
    .replace(/([^]+)/g, (_m, inner: string) => `*${inner}${/\w$/.test(inner) ? '' : '​'}*`)
  return out.replace(/(\d+)/g, (_m, i: string) => kept[Number(i)] ?? '')
}

/**
 * Markdown as Slack's mrkdwn (after Hermes's `format_message`): code blocks without their language (Slack would
 * show it), headings as bold, bullets as `•`, quotes kept, and `&`, `<`, `>` escaped so no text can ping
 * `@channel` or forge a link.
 */
export function slackMrkdwn(markdown: string): string {
  const out: string[] = []
  let code: string[] | undefined
  const block = (lines: string[]) => `\`\`\`\n${escapeSlack(lines.join('\n'))}\n\`\`\``
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      if (code) {
        out.push(block(code))
        code = undefined
      } else code = []
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`*${slackInline((heading[1] ?? '').replace(/\*\*/g, ''))}*`)
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      out.push(`${bullet[1] ?? ''}• ${slackInline(bullet[2] ?? '')}`)
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    out.push(quote ? `> ${slackInline(quote[1] ?? '')}` : slackInline(line))
  }
  // A block left open (a cut that missed its fence) is still closed.
  if (code) out.push(block(code))
  return out.join('\n')
}

/**
 * Markdown for Discord, which renders nearly all of it itself: only headings deeper than `###` (which it would show
 * as typed) become bold.
 */
export function discordMarkdown(markdown: string): string {
  let inCode = false
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) inCode = !inCode
      if (inCode) return line
      const deep = /^#{4,6}\s+(.*)$/.exec(line)
      return deep ? `**${deep[1]}**` : line
    })
    .join('\n')
}
