import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { type ComponentType, createElement, useEffect, useState } from 'react'
import { continueRender, delayRender } from 'remotion'

// Every weight the film sets (design.ts WEIGHT), in both faces. Text is measured (fitText) as well as drawn, and
// @remotion/layout-utils caches each measurement, so nothing may render until Geist is in or a fallback face's widths
// would be cached for good.
const loaded = Promise.all(
  [400, 500, 600, 700].flatMap((w) => [
    document.fonts.load(`${w} 40px "Geist Variable"`),
    document.fonts.load(`${w} 40px "Geist Mono Variable"`),
  ]),
)

/** False until Geist and Geist Mono are loaded; holds the render until then. */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false)
  const [handle] = useState(() => delayRender('Loading Geist'))
  useEffect(() => {
    loaded
      .then(() => setReady(true))
      .catch((err: unknown) => {
        throw err instanceof Error ? err : new Error(String(err))
      })
  }, [])
  // Released only once the ready render has committed, so the first screenshot already has the real type in it.
  useEffect(() => {
    if (ready) continueRender(handle)
  }, [ready, handle])
  return ready
}

/** A composition that draws nothing until the fonts are in, for compositions that do not wait on their own. */
export function withFonts(Component: ComponentType): ComponentType {
  return function WithFonts() {
    return useFontsReady() ? createElement(Component) : null
  }
}
