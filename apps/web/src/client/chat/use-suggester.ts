import { useEffect, useState } from 'react'
import { api, post } from '../api.ts'
import { SUGGEST_MODEL_DEBOUNCE_MS } from '../ui-config.ts'
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

/**
 * The word the next-word model expects after `text` (`/api/suggestions/next`), once typing pauses; only ever for the
 * text it was asked about, so a late answer never lands on newer text.
 */
export function useModelWord(text: string, on: boolean): string | undefined {
  const [got, setGot] = useState<{ text: string; word: string }>()
  useEffect(() => {
    if (!on) return
    let live = true
    const timer = setTimeout(() => {
      post<{ word?: string }>('/api/suggestions/next', { text }).then(
        (r) => live && r.word && setGot({ text, word: r.word }),
        // A guess that fails is a guess not shown; the draft is unaffected.
        () => {},
      )
    }, SUGGEST_MODEL_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [text, on])
  return on && got?.text === text ? got.word : undefined
}
