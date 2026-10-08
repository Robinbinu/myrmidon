import QRCode from 'qrcode'
import { setupCopy } from './copy.ts'
import type { Call, Terminal } from './setup.ts'

const t = setupCopy.channels

/** A channel as the server lists it (secret values never included). */
export interface ChannelView {
  id: string
  label: string
  setup?: string
  fields: { key: string; label: string; secret?: boolean; optional?: boolean }[]
  configured: boolean
  enabled: boolean
  status:
    | { state: 'off' | 'connecting' }
    | { state: 'on'; account: string }
    | { state: 'retrying' | 'error'; error: string }
    | { state: 'linking'; qr: string; image: string; hint?: string }
  people: { id: string; name: string; handle?: string; role: 'owner' | 'member' }[]
  approvedGroups: { id: string; title: string }[]
  pending: {
    id: string
    kind: 'person' | 'group'
    sender: { name: string; handle?: string }
    chat: { title?: string }
    expires: string
  }[]
}

export const statusText = (s: ChannelView['status']) =>
  s.state === 'on'
    ? t.status.on(s.account)
    : s.state === 'retrying'
      ? t.status.retrying(s.error)
      : s.state === 'error'
        ? t.status.error(s.error)
        : s.state === 'linking'
          ? (s.hint ?? t.status.linking)
          : t.status[s.state]

export const listChannels = async (call: Call) =>
  (await call<{ channels: ChannelView[] }>('GET', '/api/channels')).channels

/** A `set` from the command line as the server takes it; undefined for an unknown name or value. */
function settingPatch(name: string, value: string): Record<string, unknown> | undefined {
  const flag =
    value === 'on' || value === 'true' ? true : value === 'off' || value === 'false' ? false : undefined
  if (name === 'dm' && ['pairing', 'allowlist', 'open', 'disabled'].includes(value)) return { dm: value }
  if (name === 'groups' && ['approve', 'open', 'disabled'].includes(value)) return { groups: value }
  if (name === 'stream' && ['progress', 'partial', 'final'].includes(value)) return { stream: value }
  if (name === 'mention' && flag !== undefined) return { mention: flag }
  if (name === 'per-person' && flag !== undefined) return { perPerson: flag }
  if (name === 'allow')
    return {
      allow: value
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    }
  if (name === 'project') return { project: value || null }
  return undefined
}

/**
 * `myrmidon channels …`: see channels, set one up (its settings asked one by one, secrets hidden; a lone secret may
 * be piped, never on the command line), switch it on or off, choose who may write, and approve or revoke people,
 * all through the running server.
 */
export async function channels(call: Call, term: Terminal, args: string[]): Promise<void> {
  const all = await listChannels(call)
  const find = (id: string | undefined) => {
    const c = all.find((x) => x.id === id)
    if (!c)
      throw new Error(
        id
          ? t.unknown(
              id,
              all.map((x) => x.id),
            )
          : t.usage,
      )
    return c
  }
  const [first, second, third] = args
  if (!first) {
    for (const c of all) {
      term.print(`${term.style.bold(c.label)}: ${c.configured ? statusText(c.status) : t.notSet(c.id)}`)
      if (!c.configured) continue
      const names = [
        ...c.people.map((p) => (p.role === 'owner' ? `${p.name} (owner)` : p.name)),
        ...c.approvedGroups.map((g) => g.title),
      ]
      term.print(`  ${names.length ? t.people(names) : t.nobody}`)
      for (const p of c.pending)
        term.print(
          `  ${term.style.yellow(t.waiting(p.kind === 'group' ? (p.chat.title ?? p.sender.name) : p.sender.name, new Date(p.expires).toLocaleTimeString()))}`,
        )
    }
    return
  }
  if (first === 'approve') {
    const c = find(second)
    if (!third) throw new Error(t.usage)
    const r = await call<{ person?: { name: string; role: string }; group?: { title: string } }>(
      'POST',
      `/api/channels/${c.id}/approve`,
      { code: third },
    )
    term.print(
      term.style.green(t.approved(r.person?.name ?? r.group?.title ?? '', r.person?.role === 'owner')),
    )
    return
  }
  if (first === 'revoke') {
    const c = find(second)
    const who = (third ?? '').replace(/^@/, '').toLowerCase()
    if (!who) throw new Error(t.usage)
    const person = c.people.find(
      (p) => p.id === who || p.name.toLowerCase() === who || p.handle?.toLowerCase() === who,
    )
    const group = person
      ? undefined
      : c.approvedGroups.find((g) => g.id === who || g.title.toLowerCase() === who)
    if (!person && !group) throw new Error(t.noMatch(third ?? ''))
    await call(
      'DELETE',
      `/api/channels/${c.id}/${person ? 'person' : 'group'}/${encodeURIComponent(person?.id ?? group?.id ?? '')}`,
    )
    term.print(term.style.green(t.revoked(person?.name ?? group?.title ?? '')))
    return
  }
  const c = find(first)
  if (second === 'on' || second === 'off') {
    await call('PUT', `/api/channels/${c.id}`, { enabled: second === 'on' })
    term.print(t.turned(c.label, second === 'on'))
    return
  }
  // Access rules and the rest: myrmidon channels telegram set dm allowlist | allow @a,@b | stream partial …
  if (second === 'set') {
    const [, , name, ...rest] = args
    const value = rest.join(' ').trim()
    const patch = settingPatch(name ?? '', value)
    if (!patch) throw new Error(t.setUsage)
    await call('PUT', `/api/channels/${c.id}`, patch)
    term.print(term.style.green(t.setDone(name ?? '', value)))
    return
  }
  // Each setting the platform needs; a lone secret may be piped (`myrmidon channels telegram < token.txt`).
  const piped = await term.piped()
  const values: Record<string, string> = {}
  const only = c.fields.length === 1 ? c.fields[0] : undefined
  if (piped !== undefined && only?.secret) values[only.key] = piped.trim()
  else {
    if (c.setup) term.print(term.style.dim(c.setup))
    for (const f of c.fields) {
      const answer = (
        await term.ask(t.field(f.label, Boolean(f.secret), Boolean(f.optional)), {
          hidden: Boolean(f.secret),
        })
      ).trim()
      if (answer) values[f.key] = answer
    }
  }
  // A platform with nothing to fill in (WhatsApp links by QR code) is switched on by saving no values.
  if (!Object.keys(values).length && c.fields.length) return
  const { channel } = await call<{ channel: ChannelView }>('PUT', `/api/channels/${c.id}`, { values })
  // It starts at once; give it a moment to say who it is.
  let shown = channel
  for (let i = 0; i < 20 && shown.status.state === 'connecting'; i++) {
    await Bun.sleep(250)
    shown = (await listChannels(call)).find((x) => x.id === c.id) ?? shown
  }
  // Linking by QR (WhatsApp): show the code in the terminal and wait for the phone to scan it.
  for (let i = 0; i < 240 && shown.status.state === 'linking'; i++) {
    if (i === 0 || i % 40 === 0) {
      term.print(statusText(shown.status))
      term.print(await QRCode.toString(shown.status.qr, { type: 'terminal', small: true }))
    }
    await Bun.sleep(500)
    shown = (await listChannels(call)).find((x) => x.id === c.id) ?? shown
  }
  if (shown.status.state === 'on') {
    term.print(term.style.green(t.connected(c.label, shown.status.account)))
    term.print(t.approveHint(c.id))
  } else term.print(statusText(shown.status))
}
