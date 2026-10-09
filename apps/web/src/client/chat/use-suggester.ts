import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { buildSuggester, type Said, type Suggester } from './suggest.ts'

let loading: Promise<Suggester> | undefined

/**
 * The page's suggester, built once from what the person wrote before (`/api/suggestions`) and kept for the page's
 * life; it learns each message as it is sent. Undefined until it is ready, or when suggestions are off.
 */
export function useSuggester(on: boolean): Suggester | undefined {
  const [suggester, setSuggester] = useState<Suggester>()
  useEffect(() => {
    if (!on) return
    let live = true
    loading ??= api<{ said: Said[] }>('/api/suggestions').then(
      (r) => buildSuggester(r.said),
      // Without history (a failed load) it still suggests from the built-in phrases.
      () => buildSuggester([]),
    )
    void loading.then((s) => live && setSuggester(s))
    return () => {
      live = false
    }
  }, [on])
  return on ? suggester : undefined
}
