import { join } from 'node:path'
import { prebuiltVisualLibs } from './visual-libs-prebuilt.ts'

/**
 * The drawing libraries of visual answers (client/chat/visuals/libs.ts: Mermaid, Vega, Vega-Lite) as one browser
 * module of their own. The page's HTML bundle has no code splitting, so imported there they would load with every
 * page (about 4 MB more); apart, they load the first time a reply draws a chart or a diagram. Run from source, the
 * server bundles them on first use; a compiled Myrmidon carries them (apps/desktop/scripts/build-sidecar.ts).
 */
export const VISUAL_LIBS_ENTRY = join(import.meta.dir, 'client', 'chat', 'visuals', 'libs.ts')

/** Bundles the drawing libraries for the browser. */
export async function buildVisualLibs(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [VISUAL_LIBS_ENTRY],
    target: 'browser',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const file = out.outputs.find((o) => o.kind === 'entry-point')
  if (!out.success || !file)
    throw new Error(out.logs.map((l) => l.message).join('\n') || 'the build produced nothing')
  return file.text()
}

let built: Promise<string> | undefined

/** The drawing libraries' module text: carried by a compiled Myrmidon, else bundled once and kept. */
export function visualLibs(): Promise<string> {
  if (prebuiltVisualLibs !== undefined) return Promise.resolve(prebuiltVisualLibs)
  built ??= buildVisualLibs().catch((err) => {
    built = undefined
    throw err
  })
  return built
}
