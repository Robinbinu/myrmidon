import { useEffect, useState } from 'react'
import { api, post, SPECIALISTS_CHANGED, type Specialist, send } from './api.ts'

export type SpecialistDraft = Pick<Specialist, 'name' | 'specialty' | 'instructions' | 'off'> & {
  model?: string | undefined
}

/** The person's saved specialists, loaded again whenever they change anywhere on the page. */
export function useSpecialists(): Specialist[] {
  const [list, setList] = useState<Specialist[]>([])
  useEffect(() => {
    const load = () =>
      api<{ specialists: Specialist[] }>('/api/specialists')
        .then((r) => setList(r.specialists))
        .catch(() => {})
    load()
    window.addEventListener(SPECIALISTS_CHANGED, load)
    return () => window.removeEventListener(SPECIALISTS_CHANGED, load)
  }, [])
  return list
}

const changed = () => window.dispatchEvent(new Event(SPECIALISTS_CHANGED))

/** Creates a specialist, or changes the one with `id`. */
export async function saveSpecialist(draft: SpecialistDraft, id?: string): Promise<Specialist> {
  const r = id
    ? await send<{ specialist: Specialist }>('PUT', `/api/specialists/${encodeURIComponent(id)}`, draft)
    : await post<{ specialist: Specialist }>('/api/specialists', draft)
  changed()
  return r.specialist
}

export async function removeSpecialist(id: string): Promise<void> {
  await send('DELETE', `/api/specialists/${encodeURIComponent(id)}`)
  changed()
}
