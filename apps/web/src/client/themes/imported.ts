import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { SETTINGS_SAVED } from '../mascot.ts'
import type { ImportedTheme } from './vscode.ts'

/** The themes the person imported (Settings → Appearance); undefined until the settings have loaded. */
export function useImportedThemes(): ImportedTheme[] | undefined {
  const [list, setList] = useState<ImportedTheme[]>()
  useEffect(() => {
    const load = () =>
      api<{ settings: { appearance?: { imported?: ImportedTheme[] } } }>('/api/settings')
        .then((r) => setList(r.settings.appearance?.imported ?? []))
        .catch(() => {})
    load()
    window.addEventListener(SETTINGS_SAVED, load)
    return () => window.removeEventListener(SETTINGS_SAVED, load)
  }, [])
  return list
}
