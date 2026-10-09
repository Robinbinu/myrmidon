/** What computer use waits for before it can run, shared by both engines: Cua Driver installed, and macOS's grants. */
import { agentActor, type ColonyHost } from '../host.ts'
import { prompts } from '../prompts.ts'

const t = prompts.computer

/** What computer use waited for that the person was already shown this round. */
const blockedOnce = new WeakMap<ColonyHost, Set<string>>()

/** Tells the person, once per round, what computer use is waiting for (the chat shows a card with the way out). */
export async function blocked(
  host: ColonyHost,
  agent: string,
  reason: 'install' | 'grants',
  missing?: ('accessibility' | 'screen-recording')[],
) {
  const told = blockedOnce.get(host) ?? new Set<string>()
  blockedOnce.set(host, told)
  if (told.has(reason)) return
  told.add(reason)
  await host.append({
    type: 'computer/blocked',
    actor: agentActor(agent),
    payload: { agent, reason, ...(missing ? { missing } : {}) },
  })
}

/** Throws, after telling the person, while macOS has not given Myrmidon Screen Recording or Accessibility. */
export async function needGrants(host: ColonyHost, agent: string) {
  const grants = host.computer?.grants()
  const missing = [
    ...(grants && !grants.screenRecording ? (['screen-recording'] as const) : []),
    ...(grants && !grants.accessibility ? (['accessibility'] as const) : []),
  ]
  if (!missing.length) return
  await blocked(host, agent, 'grants', [...missing])
  throw new Error(
    t.grants(missing.map((m) => (m === 'screen-recording' ? 'Screen Recording' : 'Accessibility'))),
  )
}
