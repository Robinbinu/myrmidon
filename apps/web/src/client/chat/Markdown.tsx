import { Fragment, type ReactNode } from 'react'

const INLINE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const token = m[0]
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    if (token.startsWith('`')) out.push(<code key={at}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) out.push(<strong key={at}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'))
      const href = token.slice(token.indexOf('(') + 1, -1)
      out.push(
        <a key={at} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      )
    } else
      out.push(
        <a key={at} href={token} target="_blank" rel="noreferrer">
          {token}
        </a>,
      )
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Small, safe Markdown subset for agent replies: fenced code, headings, lists, bold, inline code, and
 * links. It builds React elements only, so model output can never inject HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] as string).startsWith('```')) body.push(lines[i++] as string)
      i++
      blocks.push(
        <pre key={key++} className="md-code" data-lang={lang || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string))
        rows.push(cells(lines[i++] as string))
      blocks.push(
        <div key={key++} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((h, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                  <th key={n}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional
                <tr key={n}>
                  {r.map((c, m) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                    <td key={m}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        <p key={key++} className={`md-h md-h${heading[1]?.length}`}>
          {inline(heading[2] ?? '')}
        </p>,
      )
      i++
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] as string)) {
        items.push((lines[i] as string).replace(/^\s*([-*]|\d+\.)\s+/, ''))
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List key={key++}>
          {items.map((it, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
            <li key={n}>{inline(it)}</li>
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
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] as string)
    ) {
      para.push(lines[i++] as string)
    }
    blocks.push(
      <p key={key++}>
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
  return <div className="md">{blocks}</div>
}
