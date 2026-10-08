import { Check, Copy } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { copy } from '../copy.ts'
import { useCopy } from '../ui/hooks.ts'

const INLINE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])[*_][^*_\s][^*_\n]*(?<!\s)[*_](?![\w*])|\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

const LINK =
  'font-medium text-accent-fg underline decoration-accent/30 underline-offset-2 hover:decoration-accent break-words'

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const token = m[0]
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    if (token.startsWith('`')) {
      out.push(
        <code key={at} className="rounded-md border border-line bg-code px-1.5 py-px font-mono text-[0.86em]">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**'))
      // Emphasis carries its own markup (`**`calc.py`**`); its inside is strictly shorter, so this ends.
      out.push(
        <strong key={at} className="font-semibold text-fg">
          {inline(token.slice(2, -2))}
        </strong>,
      )
    else if (token.startsWith('*') || token.startsWith('_'))
      out.push(
        <em key={at} className="italic">
          {inline(token.slice(1, -1))}
        </em>,
      )
    else if (token.startsWith('[') && !/\]\(https?:\/\//.test(token))
      // Anchors and relative paths have nowhere to go outside the document, so keep just the label.
      out.push(token.slice(1, token.indexOf(']')))
    else if (token.startsWith('[')) {
      out.push(
        <a
          key={at}
          className={LINK}
          href={token.slice(token.indexOf('(') + 1, -1)}
          target="_blank"
          rel="noreferrer"
        >
          {token.slice(1, token.indexOf(']'))}
        </a>,
      )
    } else {
      out.push(
        <a key={at} className={LINK} href={token} target="_blank" rel="noreferrer">
          {token}
        </a>,
      )
    }
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copyCode] = useCopy()
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex items-center justify-between border-b border-line bg-surface-2 py-1 pl-3.5 pr-1.5 text-[11.5px] text-muted">
        <span className="font-mono">{lang || copy.markdown.codeFallback}</span>
        <button
          type="button"
          onClick={() => copyCode(code)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors hover:bg-surface-3 hover:text-fg"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? copy.markdown.copied : copy.markdown.copy}
        </button>
      </div>
      <pre className="max-h-[480px] overflow-auto p-3.5 font-mono text-[12.5px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

const CELLS = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

/**
 * Small, safe Markdown subset for agent replies and Markdown artifacts: code fences, tables, headings,
 * lists, quotes, rules, bold, italics, inline code and links. It builds React elements only, so model output can never inject HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let key = 0
  const isList = (l: string) => /^\s*([-*]|\d+\.)\s+/.test(l)
  while (i < lines.length) {
    const line = lines[i] as string
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] as string).startsWith('```')) body.push(lines[i++] as string)
      i++
      blocks.push(<CodeBlock key={key++} lang={lang} code={body.join('\n')} />)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = CELLS(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string))
        rows.push(CELLS(lines[i++] as string))
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="bg-surface-2">
              <tr>
                {head.map((h, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                  <th key={n} className="border-b border-line px-3 py-2 text-left font-semibold">
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional
                <tr key={n} className="border-b border-line last:border-0">
                  {r.map((c, m) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                    <td key={m} className="px-3 py-2 align-top">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-5 border-line" />)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        quoted.push((lines[i++] as string).replace(/^\s*>\s?/, ''))
      blocks.push(
        <blockquote key={key++} className="my-3 border-l-2 border-line-strong pl-4 text-muted">
          <Markdown text={quoted.join('\n')} />
        </blockquote>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 1
      // A reply sits under the page's own headings, so its `#` starts at h3.
      const Heading = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5'
      blocks.push(
        <Heading
          key={key++}
          className={
            level === 1
              ? 'mb-2 mt-4 text-[18px] font-semibold tracking-tight'
              : level === 2
                ? 'mb-1.5 mt-4 text-[16px] font-semibold tracking-tight'
                : 'mb-1 mt-3 text-[15px] font-semibold'
          }
        >
          {inline(heading[2] ?? '')}
        </Heading>,
      )
      i++
      continue
    }
    if (isList(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length && isList(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List
          key={key++}
          className={`my-2 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-muted`}
        >
          {items.map((it, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
            <li key={n} className="pl-1">
              {inline(it)}
            </li>
          ))}
        </List>,
      )
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== '' &&
      !(lines[i] as string).startsWith('```') &&
      !/^(#{1,4})\s/.test(lines[i] as string) &&
      !isList(lines[i] as string) &&
      !/^\s*>/.test(lines[i] as string) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i] as string) &&
      !/^\s*\|.*\|\s*$/.test(lines[i] as string)
    ) {
      para.push(lines[i++] as string)
    }
    if (para.length === 0) {
      para.push(lines[i++] as string)
    }
    blocks.push(
      <p key={key++} className="my-2 first:mt-0 last:mb-0">
        {para.map((p, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return (
    <div className="select-text break-words text-[14px] leading-[1.65] text-fg [&>*:first-child]:mt-0">
      {blocks}
    </div>
  )
}
