import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// omp serves this page in the browser after a provider sign-in; Myrmidon replaces it with its own through
// patches/@oh-my-pi%2Fpi-ai@*.patch (package.json patchedDependencies). A patch is pinned to one omp version, so an
// upgrade that leaves it behind brings omp's page back: this fails first.
test("the sign-in page a provider's OAuth lands on is Myrmidon's, its mascot winking on the new-chat screen", () => {
  const ai = dirname(require.resolve('@oh-my-pi/pi-ai/package.json'))
  const page = readFileSync(join(ai, 'src/registry/oauth/oauth.html'), 'utf8')
  expect(page).toContain('<title>Myrmidon · sign-in</title>')
  for (const frame of ['open', 'blink', 'wink', 'error']) expect(page).toContain(`class="frame ${frame}"`)
  expect(page).not.toContain('class="wordmark">omp<')
  // omp fills this slot with the sign-in's outcome; without it the page could not say whether it worked.
  expect(page).toContain('__OAUTH_STATE__')
})
