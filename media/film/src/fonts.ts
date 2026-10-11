import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { continueRender, delayRender } from 'remotion'

// Hold every frame until Geist is in, or the first frames render in a fallback face and the type jumps.
const handle = delayRender('Loading Geist')
Promise.all([
  document.fonts.load('400 40px "Geist Variable"'),
  document.fonts.load('700 40px "Geist Variable"'),
  document.fonts.load('400 40px "Geist Mono Variable"'),
])
  .then(() => continueRender(handle))
  .catch((err: unknown) => {
    throw err instanceof Error ? err : new Error(String(err))
  })
