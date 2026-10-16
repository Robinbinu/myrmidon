import type { Page } from 'puppeteer-core'
import type { BrowserTab } from './browser.ts'
import { CdmError } from './cdm.ts'
import { BROWSER_COMPACT_CHARS, BROWSER_OUTLINE_LINES, SNAPSHOT_CHARS } from './config.ts'
import { loadReadable } from './omp/readers.ts'
import { prompts } from './prompts.ts'

/**
 * The agents' side of the browser: what the browser_* tools do with the engine (chrome-devtools-mcp, cdm.ts) on the
 * agent's own pages (browser.ts). Pages are read two ways, after Manus's "visible elements plus the whole page as
 * Markdown": a compact snapshot of what can be acted on, and the page's readable text saved to a file with only its
 * outline returned. Actions come in batches that report what changed, after Agent-E's skills. Whatever a page says
 * is data: the injection signs below are flagged to the agent and the person, and never followed.
 */

/** One line of the engine's snapshot: `uid=1_6 button "Place order" focusable`. */
export interface SnapNode {
  readonly uid: string
  readonly role: string
  readonly name: string
  readonly depth: number
  readonly attrs: string
  readonly line: string
}

export interface Snapshot {
  readonly url: string
  readonly title: string
  readonly nodes: readonly SnapNode[]
  readonly text: string
}

/** Roles a person acts on: what the compact snapshot keeps, with headings and alerts for where things are. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'listbox',
  'treeitem',
])
const LANDMARKS = new Set(['heading', 'alert', 'dialog', 'alertdialog', 'status', 'form'])

/** Reads the engine's snapshot text (after its "## Latest page snapshot" heading) into nodes by uid. */
export function parseSnapshot(raw: string): Snapshot {
  const at = raw.indexOf('## Latest page snapshot')
  const body = at >= 0 ? raw.slice(at + '## Latest page snapshot'.length) : raw
  const text = body.replace(/^\n+/, '').replace(/\n+$/, '')
  const nodes: SnapNode[] = []
  let url = ''
  let title = ''
  for (const line of text.split('\n')) {
    const m = /^(\s*)uid=(\S+)(?: ([A-Za-z][\w-]*))?(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(line)
    if (!m) continue
    const role = m[3] ?? 'text'
    const name = m[4] ?? ''
    const attrs = (m[5] ?? '').trim()
    if (role === 'RootWebArea') {
      title = name
      url = /url="([^"]*)"/.exec(attrs)?.[1] ?? ''
    }
    nodes.push({ uid: m[2] ?? '', role, name, depth: Math.floor((m[1] ?? '').length / 2), attrs, line })
  }
  return { url, title, nodes, text }
}

/** What an agent acts on: interactive elements, headings and alerts, each with its uid, cut at `limit`. */
export function compactSnapshot(s: Snapshot, limit = BROWSER_COMPACT_CHARS): string {
  const lines = [`url: ${s.url}`, `title: ${s.title}`]
  for (const n of s.nodes)
    if (INTERACTIVE.has(n.role) || LANDMARKS.has(n.role) || /\bvalue="/.test(n.attrs))
      lines.push(n.line.trimEnd())
  return cut(lines.join('\n'), limit, prompts.toolResults.browserCompactCut)
}

/** The full snapshot, page text included, cut at the snapshot limit. */
export function fullSnapshot(s: Snapshot, limit = SNAPSHOT_CHARS): string {
  return cut(`url: ${s.url}\ntitle: ${s.title}\n${s.text}`, limit, prompts.toolResults.snapshotCut)
}

const cut = (text: string, limit: number, note: string) =>
  text.length > limit ? `${text.slice(0, limit)}${note}` : text

const key = (n: SnapNode) => `${n.role} "${n.name}"`

/** What an action changed, as an agent needs it: where it is now, and the elements that came and went. */
export function changes(before: Snapshot | undefined, after: Snapshot): string {
  const out: string[] = []
  if (!before) return ''
  if (before.url !== after.url) out.push(prompts.toolResults.browserMoved(before.url, after.url))
  if (before.title !== after.title && after.title) out.push(`title: ${after.title}`)
  const acted = (n: SnapNode) => INTERACTIVE.has(n.role) || LANDMARKS.has(n.role)
  const had = new Set(before.nodes.filter(acted).map(key))
  const has = new Set(after.nodes.filter(acted).map(key))
  const added = after.nodes.filter((n) => acted(n) && !had.has(key(n)))
  const gone = [...had].filter((k) => !has.has(k))
  if (added.length)
    out.push(
      `appeared (${added.length}): ${added
        .slice(0, 12)
        .map((n) => `${key(n)} [${n.uid}]`)
        .join(', ')}${added.length > 12 ? ', …' : ''}`,
    )
  if (gone.length)
    out.push(`gone (${gone.length}): ${gone.slice(0, 12).join(', ')}${gone.length > 12 ? ', …' : ''}`)
  if (out.length === 0) out.push(prompts.toolResults.browserNoChange)
  return out.join('\n')
}

/** What the engine said about an action besides the snapshot: navigation, a dialog, pages that opened. */
export function engineNotes(raw: string): string {
  const at = raw.indexOf('## Latest page snapshot')
  const head = (at >= 0 ? raw.slice(0, at) : raw).trim()
  return head
    .split('\n')
    .filter((l) => l.trim() && !/^Successfully /.test(l.trim()))
    .join('\n')
}

// The page's readable text

export interface ReadablePage {
  readonly url: string
  readonly title: string
  readonly markdown: string
}

/** The page as Markdown (omp's Readability path), from the HTML the page has now, scripts' changes included. */
export async function readablePage(page: Page): Promise<ReadablePage> {
  const [html, url, title] = await Promise.all([page.content(), page.url(), page.title().catch(() => '')])
  const { extractReadableFromHtml } = await loadReadable()
  const read = await extractReadableFromHtml(html, url, 'markdown').catch(() => null)
  const markdown =
    read?.markdown ?? (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) ?? ''
  return { url, title: read?.title ?? title, markdown }
}

/** The headings of a Markdown page, as an indented outline, at most `max` lines. */
export function outlineOf(markdown: string, max = BROWSER_OUTLINE_LINES): string {
  const heads = markdown
    .split('\n')
    .map((l) => /^(#{1,6})\s+(.+?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${'  '.repeat((m[1]?.length ?? 1) - 1)}- ${m[2]}`)
  return heads.length > max
    ? `${heads.slice(0, max).join('\n')}\n  … (${heads.length - max} more)`
    : heads.join('\n')
}

/** The Markdown sections whose heading contains `name` (case ignored), each with what is under it. */
export function sectionOf(markdown: string, name: string): string {
  const lines = markdown.split('\n')
  const needle = name.trim().toLowerCase()
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? '')
    if (!m || !(m[2] ?? '').toLowerCase().includes(needle)) continue
    const level = m[1]?.length ?? 1
    let end = i + 1
    while (end < lines.length) {
      const next = /^(#{1,6})\s/.exec(lines[end] ?? '')
      if (next && (next[1]?.length ?? 1) <= level) break
      end++
    }
    out.push(lines.slice(i, end).join('\n').trim())
    i = end - 1
  }
  return out.join('\n\n')
}

/** Lines that contain `text` (case ignored), each with a line either side, numbered as in the saved file. */
export function findIn(markdown: string, text: string, max = 40): string {
  const lines = markdown.split('\n')
  const needle = text.toLowerCase()
  const hits: string[] = []
  for (let i = 0; i < lines.length && hits.length < max; i++)
    if ((lines[i] ?? '').toLowerCase().includes(needle))
      hits.push(
        [i - 1, i, i + 1]
          .filter((j) => j >= 0 && j < lines.length)
          .map((j) => `${j + 1}: ${lines[j]}`)
          .join('\n'),
      )
  return hits.join('\n--\n')
}

/** The start of a page: everything up to the second heading, or the first `limit` characters. */
export function firstSection(markdown: string, limit: number): string {
  const lines = markdown.split('\n')
  const second = lines.findIndex(
    (l, i) => i > 0 && /^#{1,6}\s/.test(l) && lines.slice(0, i).some((x) => /^#{1,6}\s/.test(x)),
  )
  const start = (second > 0 ? lines.slice(0, second) : lines).join('\n').trim()
  return start.length > limit ? `${start.slice(0, limit)}…` : start
}

// Consequential actions

/** What the layer learns about an element before acting on it, from the page itself. */
export interface Target {
  readonly tag: string
  readonly type: string
  readonly text: string
  /** Clicking it submits a form. */
  readonly submits: boolean
  readonly method: string
  /** The form looks like a search: role=search, or one query field. */
  readonly search: boolean
  readonly fields: number
  /** The element or its form takes a password or a card number. */
  readonly password: boolean
  readonly card: boolean
  readonly box: { x: number; y: number; width: number; height: number }
  readonly host: string
}

/** Run by the engine with the element as its argument; plain JavaScript, so it runs in any page. */
export const TARGET_SCRIPT = `(el) => {
  const form = el.form || (el.closest && el.closest('form'))
  const tag = (el.tagName || '').toLowerCase()
  const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase()
  const submits = !!form && (tag === 'button' ? (type === '' || type === 'submit') : tag === 'input' && (type === 'submit' || type === 'image'))
  const fields = form ? [...form.elements].filter((e) => /^(input|select|textarea)$/i.test(e.tagName) && !['hidden', 'submit', 'button', 'image', 'reset'].includes((e.type || '').toLowerCase())) : []
  const cardLike = (e) => /cc-|card|cvc|cvv|csc|iban/i.test([e.autocomplete, e.name, e.id].join(' '))
  const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 }
  return {
    tag, type,
    text: String(el.innerText || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '').trim().slice(0, 80),
    submits,
    method: String((form && form.method) || 'get').toLowerCase(),
    search: !!form && (form.getAttribute('role') === 'search' || !!form.closest('[role=search]') || (fields.length <= 1 && fields.every((f) => f.type === 'search' || /^(q|query|search|s|keywords?|term)$/i.test(f.name || '')))),
    fields: fields.length,
    password: el.type === 'password' || fields.some((f) => f.type === 'password'),
    card: cardLike(el) || fields.some(cardLike),
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
    host: location.host,
  }
}`

/** The focused element, for a key press: Enter in a form field submits it. */
export const FOCUSED_SCRIPT = TARGET_SCRIPT.replace(
  '(el) => {',
  '() => { const el = document.activeElement || document.body;',
)

/** Words on a control that do something for good: buy, pay, send, publish, delete… in the languages people use most. */
const CONSEQUENTIAL =
  /\b(buy|purchase|order|checkout|check out|pay|payment|donate|send|submit|post|publish|tweet|reply|comment|share|invite|delete|remove|destroy|erase|transfer|wire|withdraw|confirm|subscribe|unsubscribe|sign up|register|book|reserve|deactivate|close account|kaufen|bestellen|zahlen|bezahlen|senden|absenden|abschicken|l(ö|oe)schen|entfernen|(ü|ue)berweisen|best(ä|ae)tigen|abonnieren|ver(ö|oe)ffentlichen|buchen|acheter|commander|payer|envoyer|supprimer|virement|confirmer|publier|r(é|e)server|comprar|pedir|pagar|enviar|eliminar|borrar|transferir|publicar|suscribir|excluir|acquista|ordina|paga|invia|elimina|conferma|pubblica|kopen|betalen|verzenden|verwijderen|bevestigen|купить|заказать|оплатить|отправить|удалить|подтвердить|опубликовать)\b/i
const CONSEQUENTIAL_CJK =
  /(購入|注文|支払|送信|削除|確定|投稿|购买|購買|下单|支付|付款|发送|發送|提交|删除|刪除|确认|確認|发布|發布|구매|주문|결제|전송|보내기|삭제|게시)/

/**
 * Why an action is consequential (it places an order, sends, submits, pays or deletes), or undefined: what the
 * person is asked about before it runs. Deterministic: the control's own words and what it does on the page.
 */
export function consequence(
  action: 'click' | 'fill' | 'press',
  node: SnapNode | undefined,
  target: Target | undefined,
  key?: string,
): string | undefined {
  const label = [...new Set([node?.name, target?.text].filter(Boolean))].join(' ')
  if (action === 'fill') return target?.card ? prompts.browserSafety.card : undefined
  if (action === 'press') {
    if (!/^(Enter|NumpadEnter)$/i.test(key ?? '') || !target) return undefined
    const inForm = target.fields > 0
    if (!inForm || target.search) return undefined
    return prompts.browserSafety.submitsForm(target.fields)
  }
  if (CONSEQUENTIAL.test(label) || CONSEQUENTIAL_CJK.test(label)) return prompts.browserSafety.words(label)
  if (target?.card) return prompts.browserSafety.card
  if (target?.submits && !target.search) return prompts.browserSafety.submitsForm(target.fields)
  return undefined
}

// Prompt injection

const INJECTION: readonly [RegExp, string][] = [
  [
    /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines|tasks?)\b/i,
    'tells the reader to ignore its instructions',
  ],
  [
    /\b(new|updated|real|actual|secret)\s+(instructions?|system prompt|orders)\b/i,
    'claims to give new instructions',
  ],
  [/\b(you are now|from now on,? you|act as (an?|the) )/i, 'tries to give the reader a new role'],
  [
    /(<\/?system>|\[system\]|\bsystem prompt\b|\bdeveloper message\b|^\s*(assistant|system)\s*:)/im,
    'imitates a system or assistant message',
  ],
  [
    /\b(send|paste|post|email|upload|share|copy|enter|type|reveal|exfiltrate)\b[^.\n]{0,60}\b(cookies?|passwords?|tokens?|api[ _-]?keys?|credentials?|secrets?|session (id|token)|one[- ]time (code|password)|otp|2fa code|private key)\b/i,
    'asks for credentials or secrets to be sent',
  ],
  [
    /\b(do not|don't|never)\s+(tell|inform|mention|reveal|show)\b[^.\n]{0,30}\b(user|human|person|owner)\b/i,
    'asks to hide something from the person',
  ],
  [
    /\b(AI|assistant|agent|LLM|language model|chatbot|bot)s?\b[^.\n]{0,80}\b(must|should|need to|are instructed to|have to|will now)\b/i,
    'addresses AI agents with orders',
  ],
]

/** Signs that page text is trying to instruct the agent; empty for ordinary pages. Each sign is said once. */
export function injectionSigns(text: string): string[] {
  const out: string[] = []
  for (const [re, why] of INJECTION) {
    const m = re.exec(text)
    if (m) out.push(`${why}: "${m[0].replace(/\s+/g, ' ').slice(0, 120)}"`)
  }
  return out
}

/** Text a person cannot see but a reader of the page's HTML gets: hidden by CSS, off-screen, or nearly invisible. */
export async function hiddenText(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const out: string[] = []
      for (const el of document.querySelectorAll('body *')) {
        if (out.join(' ').length > 4000) break
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join(' ')
          .trim()
        if (own.length < 20) continue
        const s = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const hidden =
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          Number(s.opacity) < 0.05 ||
          Number.parseFloat(s.fontSize) < 2 ||
          r.right < 0 ||
          r.bottom < 0 ||
          r.left > innerWidth * 4 ||
          (s.color === s.backgroundColor && s.color !== 'rgba(0, 0, 0, 0)') ||
          el.closest('[aria-hidden="true"]') !== null
        if (hidden) out.push(own)
      }
      return out.join('\n').slice(0, 4000)
    })
    .catch(() => '')
}

/** The value an engine script returned, from its "returned:" JSON block. */
export function scriptResult<T>(raw: string): T | undefined {
  const m = /```json\n([\s\S]*?)\n```/.exec(raw)
  try {
    return m ? (JSON.parse(m[1] ?? '') as T) : undefined
  } catch {
    return undefined
  }
}

/** The engine's words for a stale uid or a closed page, turned into what the agent should do next. */
export function engineError(err: unknown): Error {
  if (!(err instanceof CdmError)) return err instanceof Error ? err : new Error(String(err))
  if (/no longer exists|not found|stale|uid/i.test(err.message))
    return new Error(`${err.message} ${prompts.toolResults.browserStale}`)
  return err
}

// Snapshots the agent has seen

const seen = new WeakMap<BrowserTab, Snapshot>()

/** The latest snapshot of the agent's active page, through the engine; remembered for the next action's check. */
export async function snapshot(tab: BrowserTab, verbose = false): Promise<Snapshot> {
  const pageId = await tab.idOf(tab.page)
  const raw = (await tab.engine().call('take_snapshot', { pageId, ...(verbose ? { verbose: true } : {}) }))
    .text
  const s = parseSnapshot(raw)
  seen.set(tab, s)
  return s
}

/** The snapshot the agent acted on last, if it is of the page it is on now. */
export function lastSeen(tab: BrowserTab): Snapshot | undefined {
  const s = seen.get(tab)
  return s && s.url === tab.page.url() ? s : s
}

/** Remembers a snapshot that came with an action's result. */
export function remember(tab: BrowserTab, s: Snapshot): void {
  seen.set(tab, s)
}

/** Reads tables, links, or repeating items from a page's DOM (browser_extract and saved browser flows). */
export function extractFromPage(
  page: Page,
  what: 'tables' | 'links' | 'items',
  selector: string,
  fields: Record<string, string>,
  limit: number,
): Promise<unknown[]> {
  return page.evaluate(
    (what, selector, fields, limit) => {
      const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const roots = selector ? [...document.querySelectorAll(selector)] : [document.body]
      if (what === 'links') {
        const out: { text: string; href: string }[] = []
        for (const root of roots)
          for (const a of root.querySelectorAll('a[href]')) {
            if (out.length >= limit) break
            out.push({ text: text(a), href: (a as HTMLAnchorElement).href })
          }
        return out
      }
      if (what === 'tables') {
        const tables = roots.flatMap((r) => (r.matches('table') ? [r] : [...r.querySelectorAll('table')]))
        return tables.slice(0, 20).map((t) => {
          const rows = [...t.querySelectorAll('tr')]
          const head = rows.find((r) => r.querySelector('th')) ?? rows[0]
          const headers = [...(head?.children ?? [])].map((c, i) => text(c) || `col${i + 1}`)
          const body = rows.filter((r) => r !== head)
          return {
            caption: text(t.querySelector('caption')),
            headers,
            rows: body
              .slice(0, limit)
              .map((r) =>
                Object.fromEntries([...r.children].map((c, i) => [headers[i] ?? `col${i + 1}`, text(c)])),
              ),
          }
        })
      }
      return roots.slice(0, limit).map((item) =>
        Object.fromEntries(
          Object.entries(fields).map(([name, spec]) => {
            const [css = '', attr] = spec.split('@')
            const el = css ? item.querySelector(css) : item
            if (!el) return [name, null]
            if (!attr) return [name, text(el)]
            // href and src come back absolute, the way a person would copy them.
            const value =
              attr === 'href' || attr === 'src'
                ? (((el as unknown as Record<string, unknown>)[attr] as string | undefined) ??
                  el.getAttribute(attr))
                : el.getAttribute(attr)
            return [name, value]
          }),
        ),
      )
    },
    what,
    selector,
    fields,
    limit,
  ) as Promise<unknown[]>
}
