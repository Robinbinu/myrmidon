import { expect, test } from 'bun:test'
import { setPlistString } from '../src/plist.ts'

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
</dict>
</plist>
`
const KEY = 'NSMicrophoneUsageDescription'

test('adds a string key to the top-level dict, escaped', () => {
  expect(setPlistString(PLIST, KEY, 'Calls <voice> & more')).toContain(
    `    <key>${KEY}</key>\n    <string>Calls &lt;voice&gt; &amp; more</string>\n</dict>`,
  )
})

test('replaces the value a build already wrote, once', () => {
  const generic = setPlistString(PLIST, KEY, 'This app requires access for audio input')
  const ours = setPlistString(generic, KEY, 'Voice calls')
  expect(ours).toContain(`<key>${KEY}</key>\n    <string>Voice calls</string>`)
  expect(ours).not.toContain('requires access')
  expect(ours.match(new RegExp(KEY, 'g'))).toHaveLength(1)
  expect(setPlistString(ours, KEY, 'Voice calls')).toBe(ours)
})

test('refuses a plist without a dict', () => {
  expect(() => setPlistString('<plist/>', 'K', 'v')).toThrow()
})
