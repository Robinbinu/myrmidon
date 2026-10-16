/** The drawing libraries' own bundle (libs.ts), served by the app's server at this address. */
export const VISUAL_LIBS_PATH = '/visual-libs.js'

let loaded: Promise<typeof import('./libs.ts')> | undefined

/** Mermaid and Vega, loaded once, the first time a reply draws with them; a failed load is tried again next time. */
export function loadVisualLibs(): Promise<typeof import('./libs.ts')> {
  loaded ??= import(/* @vite-ignore */ new URL(VISUAL_LIBS_PATH, location.origin).href).catch((err) => {
    loaded = undefined
    throw err
  })
  return loaded
}
