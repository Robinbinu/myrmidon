import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_UI_KIT } from '@myrmidon/protocol'
import type { PluginInfo } from '@myrmidon/runtime'
import type { BunPlugin } from 'bun'

/**
 * Builds a plugin's UI (`ui/index.tsx`, or `myrmidon.json` "ui") into one browser module. React, its JSX runtime and
 * `@myrmidon/ui` are not bundled: they resolve to the copies the page already runs (`globalThis.__myrmidon`), so
 * plugin components share the app's hooks, theme and components instead of carrying a second React.
 */

/** The global the page sets before loading plugin UI. */
export const HOST_GLOBAL = '__myrmidon'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** Module source that re-exports one of the host's modules under its names. */
function reexport(key: string, names: readonly string[]): string {
  const valid = names.filter((n) => IDENT.test(n) && n !== 'default')
  return [
    `const m = globalThis.${HOST_GLOBAL}.${key};`,
    'export default m;',
    valid.length ? `export const { ${valid.join(', ')} } = m;` : '',
  ].join('\n')
}

async function hostModules(): Promise<Record<string, { key: string; names: readonly string[] }>> {
  const react = Object.keys(await import('react'))
  return {
    react: { key: 'React', names: react },
    'react/jsx-runtime': { key: 'jsxRuntime', names: ['jsx', 'jsxs', 'Fragment'] },
    'react/jsx-dev-runtime': { key: 'jsxRuntime', names: ['jsxDEV', 'Fragment'] },
    '@myrmidon/ui': { key: 'ui', names: PLUGIN_UI_KIT },
  }
}

/** Changes whenever a file the UI is built from changes, so the page knows to load it again. */
export function uiStamp(plugin: PluginInfo): string | undefined {
  if (!plugin.ui) return undefined
  let newest = 0
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  walk(plugin.dir)
  return String(Math.round(newest))
}

const built = new Map<string, { stamp: string; code: string }>()

export async function buildPluginUI(plugin: PluginInfo): Promise<string> {
  const entry = plugin.ui
  if (!entry) throw new Error(`${plugin.name} has no UI`)
  const stamp = uiStamp(plugin) ?? ''
  const cached = built.get(plugin.name)
  if (cached?.stamp === stamp) return cached.code
  const modules = await hostModules()
  const host: BunPlugin = {
    name: 'myrmidon-host',
    setup(build) {
      build.onResolve(
        { filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|@myrmidon\/ui)$/ },
        (args) => ({
          path: args.path,
          namespace: 'myrmidon-host',
        }),
      )
      build.onLoad({ filter: /.*/, namespace: 'myrmidon-host' }, (args) => {
        const m = modules[args.path]
        if (!m) throw new Error(`unknown host module ${args.path}`)
        return { contents: reexport(m.key, m.names), loader: 'js' }
      })
    },
  }
  const out = await Bun.build({
    entrypoints: [join(plugin.dir, entry)],
    target: 'browser',
    format: 'esm',
    plugins: [host],
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!out.success) throw new Error(out.logs.map((l) => l.message).join('\n') || 'the build failed')
  const file = out.outputs.find((o) => o.kind === 'entry-point')
  if (!file) throw new Error('the build produced nothing')
  const code = await file.text()
  built.set(plugin.name, { stamp, code })
  return code
}
