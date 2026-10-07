import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { Glob } from 'bun'

const CLIENT = join(import.meta.dir, '../src/client')

// React calls whatever an effect returns as its cleanup unless it is undefined. An arrow written without braces
// returns its expression, so `useEffect(() => el.scrollIntoView())` breaks as soon as that call returns something:
// in Chrome 152 scrollIntoView returns a Promise, and unmounting the component crashed the whole window.
test('effects have block bodies, so they never return a value by accident', async () => {
  const bad: string[] = []
  for await (const file of new Glob('**/*.{ts,tsx,js,jsx}').scan(CLIENT)) {
    const text = await Bun.file(join(CLIENT, file)).text()
    for (const m of text.matchAll(
      /use(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\)\s*=>(?!\s*\{|\s*\(\)\s*=>)/g,
    )) {
      const line = text.slice(0, m.index).split('\n').length
      bad.push(`${file}:${line}`)
    }
  }
  expect(bad).toEqual([])
})
