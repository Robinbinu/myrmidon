import { setupCopy } from './copy.ts'
import type { Call, Terminal } from './setup.ts'

const t = setupCopy.channels

/** A channel as the server lists it (no tokens). */
export interface ChannelView {
  id: string
  label: string
  configured: boolean
  enabled: boolean
  status:
    | { state: 'off' | 'connecting' }
    | { state: 'on'; account: string }
    | { state: 'retrying' | 'error'; error: string }
  people: { id: string; name: string; handle?: string; role: 'owner' | 'member' }[]
  groups: { id: string; title: string }[]
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
        : t.status[s.state]

export const listChannels = async (call: Call) =>
  (await call<{ channels: ChannelView[] }>('GET', '/api/channels')).channels

/**
 * `myrmidon channels …`: see channels, give a bot its token (typed hidden or piped, never on the command line),
 * switch it on or off, and approve or revoke people, all through the running server.
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
      term.print(`${term.style.bold(c.label)}: ${c.configured ? statusText(c.status) : t.notSet}`)
      if (!c.configured) continue
      const names = [
        ...c.people.map((p) => (p.role === 'owner' ? `${p.name} (owner)` : p.name)),
        ...c.groups.map((g) => g.title),
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
    const group = person ? undefined : c.groups.find((g) => g.id === who || g.title.toLowerCase() === who)
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
  const token = ((await term.piped()) ?? (await term.ask(t.token(c.label), { hidden: true }))).trim()
  if (!token) return
  const { channel } = await call<{ channel: ChannelView }>('PUT', `/api/channels/${c.id}`, { token })
  // It starts at once; give it a moment to say who it is.
  let shown = channel
  for (let i = 0; i < 20 && shown.status.state === 'connecting'; i++) {
    await Bun.sleep(250)
    shown = (await listChannels(call)).find((x) => x.id === c.id) ?? shown
  }
  if (shown.status.state === 'on') {
    term.print(term.style.green(t.connected(c.label, shown.status.account)))
    term.print(t.approveHint(c.id))
  } else term.print(statusText(shown.status))
}
