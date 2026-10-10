import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@oh-my-pi/pi-ai'
import { HIDDEN_TEXTS_KEPT, KNOWN_SECRETS_FRESH_MS, MIN_KNOWN_SECRET, SECRET_TAG_CHARS } from './config.ts'
import { ownerOnly } from './owner-only.ts'
import { prompts } from './prompts.ts'
import { ASSIGNMENT, ENV_SECRETS, PATTERNS } from './secrets.ts'

/**
 * Keeps secrets out of what Myrmidon sends to model providers. A key an agent read in a .env file, a token a command
 * printed, a password the person pasted: each is replaced, before every model call, by a placeholder such as
 * `[[secret:api-key:7KQ2M4ZP9XRA]]`. The same secret always gets the same placeholder (a keyed hash of it), so the
 * model can tell secrets apart and refer to one, and prompt caching still sees the same text call after call.
 *
 * After omp's secrets obfuscator (pi-coding-agent/src/secrets), which is off by default and hooks the same two places:
 * the provider context before each request, and tool-call arguments before a tool runs, where a placeholder the model
 * wrote is turned back into the secret. Unlike omp, which puts it back for every tool, Myrmidon puts it back only where
 * the value stays on this machine in the agent's own folder (see `restoreSecrets`).
 *
 * What is hidden: the credential shapes secrets.ts redacts from the log, a few more vendor prefixes omp knows, quoted
 * or credential-looking values set to a secret-named key, and the exact values of the credentials Myrmidon holds (the
 * vault's keys and sign-ins, channel tokens, the server's token, secret-named environment variables), whatever their
 * shape. Images are sent as they are: text drawn in a screenshot cannot be found this way.
 */

/** Vendor prefixes omp hides (its CREDENTIAL_PATTERNS) that the log's list does not have. */
const MORE_PATTERNS: [kind: string, re: RegExp][] = [
  ['gitlab token', /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g],
  ['npm token', /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{30,}(?![A-Za-z0-9_-])/g],
  ['hugging face token', /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_-])/g],
  ['webhook secret', /(?<![A-Za-z0-9_-])whsec_[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/g],
  ['sendgrid key', /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
]
const SHAPES = [...PATTERNS, ...MORE_PATTERNS]

/**
 * Whether the value of `NAME_TOKEN = value` is a secret rather than code. The log hides every such value; a model
 * reading code must still see `apiKey = getKey(model)` or `token: process.env.TOKEN` (omp keeps keyword rules out of
 * its provider redaction for this reason). A quoted value counts; a bare one only when it looks like a credential:
 * letters and digits, nothing a call, a variable or a placeholder is written with.
 */
function assignedSecret(name: string, value: string): boolean {
  if (value.includes('[[secret:')) return false
  if (/["']$/.test(name)) return true
  return /\d/.test(value) && /[A-Za-z]/.test(value) && /^[A-Za-z0-9_+/=~.-]+$/.test(value)
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** A placeholder as prompts.secrets.placeholder writes it; the tag is what finds the secret again. */
const PLACEHOLDER = new RegExp(`\\[\\[secret:[a-z-]+:([A-Z2-7]{${SECRET_TAG_CHARS}})\\]\\]`, 'g')

type Source = () => Iterable<string | undefined>

interface Guard {
  /** The person's choice (Settings → Permissions); on when nothing says otherwise. */
  enabled: () => boolean
  /** Keeps the placeholders' hash key, so a placeholder means the same secret after a restart. */
  keyFile?: string
}

let guard: Guard = { enabled: () => true }
const sources = new Set<Source>()
let key: Buffer | undefined
/** Every secret a placeholder was made for, by its tag: what a placeholder the model writes back can stand for. */
const byTag = new Map<string, string>()
let known: { at: number; values: readonly string[] } = { at: 0, values: [] }
/**
 * Texts already hidden, by their text: a conversation is sent again with every step, and scanning a long context
 * costs about a tenth of a second per megabyte. Valid while the credentials and the key stay the same.
 */
const hidden = new Map<string, string>()
/** Sources' errors already reported, so a broken file is said once, not on every model call. */
const unreadable = new Set<string>()

/**
 * Sets whether secrets are hidden and where the placeholder key is kept, for the whole process: Myrmidon has one
 * person and one settings file. Returns what undoes it.
 */
export function guardSecrets(next: Guard): () => void {
  const before = guard
  guard = next
  key = undefined
  forget()
  return () => {
    guard = before
    key = undefined
    forget()
  }
}

/**
 * Adds credentials Myrmidon holds, hidden by value wherever they appear. Read again at most every
 * KNOWN_SECRETS_FRESH_MS, so a source may read its file. Returns what removes it.
 */
export function addKnownSecrets(source: Source): () => void {
  sources.add(source)
  forget()
  return () => {
    sources.delete(source)
    forget()
  }
}

function forget() {
  known = { at: 0, values: [] }
  hidden.clear()
}

export function secretsHidden(): boolean {
  return guard.enabled()
}

function placeholderKey(): Buffer {
  key ??= guard.keyFile ? keptKey(guard.keyFile) : randomBytes(32)
  return key
}

/** The key in its file, made there on first use; a key for this process only when the file cannot be written. */
function keptKey(file: string): Buffer {
  const saved = readKey(file)
  if (saved) return saved
  const made = randomBytes(32)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, made.toString('base64url'), { flag: 'wx', mode: 0o600 })
    ownerOnly(file)
    return made
  } catch (err) {
    // Another server process made it first: use theirs, or placeholders would differ between the two.
    const theirs = (err as NodeJS.ErrnoException).code === 'EEXIST' ? readKey(file) : undefined
    if (theirs) return theirs
    console.warn(`secret placeholders will change after a restart: ${file}: ${(err as Error).message}`)
    return made
  }
}

function readKey(file: string): Buffer | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return /^[A-Za-z0-9_-]{43}$/.test(text) ? Buffer.from(text, 'base64url') : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** The credentials to hide by value, longest first so one containing another is hidden whole. */
function knownValues(): readonly string[] {
  const now = Date.now()
  if (now - known.at < KNOWN_SECRETS_FRESH_MS) return known.values
  const values = new Set<string>(ENV_SECRETS)
  // The key itself: read from its file, it would let anyone who saw it tell which secret a placeholder is.
  values.add(placeholderKey().toString('base64url'))
  for (const source of sources) {
    try {
      for (const value of source())
        if (value && value.trim().length >= MIN_KNOWN_SECRET) values.add(value.trim())
    } catch (err) {
      // A settings file that cannot be read (channels.json) must not stop every agent; its own page reports it, and
      // the shapes above still hide most keys.
      const message = err instanceof Error ? err.message : String(err)
      if (!unreadable.has(message)) console.error(`secrets kept from model providers: ${message}`)
      unreadable.add(message)
    }
  }
  const sorted = [...values].sort((a, b) => b.length - a.length)
  if (sorted.length !== known.values.length || sorted.some((v, i) => v !== known.values[i])) hidden.clear()
  known = { at: now, values: sorted }
  return known.values
}

function placeholder(kind: string, secret: string): string {
  const digest = createHmac('sha256', placeholderKey()).update(secret).digest()
  let tag = ''
  for (let i = 0; tag.length < SECRET_TAG_CHARS; i++) tag += BASE32[(digest[i] as number) & 31]
  byTag.set(tag, secret)
  return prompts.secrets.placeholder(kind.replace(/\s+/g, '-'), tag)
}

/** One text with its secrets replaced by placeholders, when the person keeps them hidden. */
export function hideSecrets(text: string): string {
  if (text.length < MIN_KNOWN_SECRET || !guard.enabled()) return text
  const values = knownValues()
  const done = hidden.get(text)
  if (done !== undefined) return done
  if (hidden.size >= HIDDEN_TEXTS_KEPT) hidden.clear()
  const out = scan(text, values)
  hidden.set(text, out)
  return out
}

function scan(text: string, values: readonly string[]): string {
  let out = text
  for (const value of values)
    if (out.includes(value)) out = out.replaceAll(value, () => placeholder('credential', value))
  for (const [kind, re] of SHAPES) out = out.replace(re, (match) => placeholder(kind, match))
  return out.replace(ASSIGNMENT, (whole, name: string, value: string) =>
    assignedSecret(name, value) ? `${name}${placeholder('secret', value)}` : whole,
  )
}

/** Every string in a JSON-like value (tool-call arguments), keys untouched. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T
  if (Array.isArray(value)) {
    const out = value.map((v) => mapStrings(v, fn))
    return (out.some((v, i) => v !== value[i]) ? out : value) as T
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = mapStrings(v, fn)
      changed ||= out[k] !== v
    }
    return (changed ? out : value) as T
  }
  return value
}

type Block = { type?: string; text?: unknown; arguments?: unknown }

/**
 * Text, and the arguments of earlier tool calls, are hidden. Reasoning and its signatures are left byte for byte
 * (providers check them, and the model wrote them from text already hidden), as are images.
 */
function hideBlock(block: Block): Block {
  if (block?.type === 'text' && typeof block.text === 'string') {
    const text = hideSecrets(block.text)
    return text === block.text ? block : { ...block, text }
  }
  if (block?.type === 'toolCall' && block.arguments) {
    const args = mapStrings(block.arguments, hideSecrets)
    return args === block.arguments ? block : { ...block, arguments: args }
  }
  return block
}

/** A conversation's messages (pi-ai's, or an agent's before conversion) with their secrets hidden. */
export function hideInMessages<T>(messages: readonly T[]): T[] {
  if (!guard.enabled()) return messages as T[]
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content
    if (typeof content === 'string') {
      const hidden = hideSecrets(content)
      return hidden === content ? m : { ...m, content: hidden }
    }
    if (!Array.isArray(content)) return m
    const blocks = content.map((b: Block) => hideBlock(b))
    return blocks.some((b, i) => b !== content[i]) ? { ...m, content: blocks } : m
  })
}

/** A model request with its secrets hidden: the system prompt (memory, instructions) and every message. */
export function hideInContext<C extends Pick<Context, 'messages' | 'systemPrompt'>>(context: C): C {
  if (!guard.enabled()) return context
  return {
    ...context,
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt.map(hideSecrets) } : {}),
    messages: hideInMessages(context.messages),
  }
}

/** The secret behind each placeholder this process made; one it did not make stays as written. */
export function revealSecrets(text: string): string {
  if (!text.includes('[[secret:')) return text
  return text.replace(PLACEHOLDER, (whole, tag: string) => byTag.get(tag) ?? whole)
}

/** Where a tool would use a secret put back, as the agent's round sees it. */
export interface RestoreScope {
  /** Whether a file at this path stays in the agent's working folder or scratch, whatever access the round has. */
  inside(path: string): boolean
  /** Commands run in the OS sandbox, which writes only to the agent's folders. */
  readonly confined: boolean
}

/**
 * The tools a placeholder is turned back into its secret for, and when. A file the agent rewrites or edits in its own
 * folder must keep the real key (writing the placeholder would break the person's config), and a sandboxed command or
 * a search needs the value the files hold. Nothing else gets it back: messages, replies and notes go to people,
 * channels and logs; web, browser and MCP tools send it off this machine; and with full access a file outside the
 * folder, or a command that may write anywhere, is a place the person did not choose for it. omp puts secrets back
 * for every tool; this is narrower on purpose, and the agent's prompt says where it holds.
 */
const RESTORES: Readonly<Record<string, (args: Record<string, unknown>, scope: RestoreScope) => boolean>> = {
  fs_write: (a, s) => typeof a.path === 'string' && s.inside(a.path),
  fs_edit: (a, s) => typeof a.path === 'string' && s.inside(a.path),
  ast_edit: (a, s) => s.inside(typeof a.path === 'string' ? a.path : '.'),
  shell: (_, s) => s.confined,
  // A code cell runs in the same sandbox as shell, so it is a sandboxed command here.
  eval: (_, s) => s.confined,
  start_server: (_, s) => s.confined,
  grep: () => true,
  ast_grep: () => true,
}

/** A tool call's arguments with placeholders turned back into secrets, where `RESTORES` allows it. */
export function restoreSecrets(
  tool: string,
  args: Record<string, unknown>,
  scope: RestoreScope,
): Record<string, unknown> {
  if (byTag.size === 0 || !RESTORES[tool]?.(args, scope)) return args
  return mapStrings(args, revealSecrets)
}
