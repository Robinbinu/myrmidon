import { expect, test } from 'bun:test'
import { sealHtml, shareFile, UNSEAL_SOURCE } from '../src/client/chat/share.ts'

/** The decryption the share file runs, built from the very source it carries. */
const unseal = new Function(`${UNSEAL_SOURCE}\nreturn unseal`)() as (
  sealed: string,
  key: string,
) => Promise<string>

const PAGE = '<!doctype html><title>Plans</title><p>The secret plan: ship on Friday. Ünïcödé ✓</p>'

const TEXT = {
  title: 'Encrypted chat',
  body: 'Paste the key',
  keyLabel: 'Key',
  open: 'Open',
  errors: { key: 'Wrong key', sealed: 'Damaged', browser: 'Old browser' },
}

test('a sealed page opens with its key, as the address fragment carries it', async () => {
  const { sealed, key } = await sealHtml(PAGE)
  // 32 bytes of key, base64url without padding, so it can sit after # in an address as it is.
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await unseal(sealed, key)).toBe(PAGE)
  expect(await unseal(sealed, `  ${key}\n`)).toBe(PAGE)
})

test('a wrong, short or malformed key does not open it, and neither does a damaged file', async () => {
  const { sealed, key } = await sealHtml(PAGE)
  const other = await sealHtml(PAGE)
  await expect(unseal(sealed, other.key)).rejects.toThrow('key')
  await expect(unseal(sealed, key.slice(0, 20))).rejects.toThrow('key')
  await expect(unseal(sealed, '***not a key***')).rejects.toThrow('key')
  // A flipped byte fails GCM's check: a damaged file never opens as something else.
  const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0))
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
  const tampered = btoa(String.fromCharCode(...bytes))
  await expect(unseal(tampered, key)).rejects.toThrow('key')
  await expect(unseal('AAAA', key)).rejects.toThrow('sealed')
})

test('each seal has its own key and IV, so the same chat never seals the same way twice', async () => {
  const a = await sealHtml(PAGE)
  const b = await sealHtml(PAGE)
  expect(a.key).not.toBe(b.key)
  expect(a.sealed.slice(0, 16)).not.toBe(b.sealed.slice(0, 16))
})

test('the share file holds only ciphertext: no key, no text of the chat, nothing to load from elsewhere', async () => {
  const { sealed, key } = await sealHtml(PAGE)
  const file = shareFile(sealed, { ...TEXT, title: 'Encrypted <chat>' })
  expect(file).toContain(sealed)
  expect(file).not.toContain(key)
  expect(file).not.toContain('secret plan')
  expect(file).not.toContain('Plans')
  expect(file).toContain('<title>Encrypted &lt;chat&gt;</title>')
  expect(file).toContain(UNSEAL_SOURCE)
  expect(file).toContain("default-src 'none'; script-src 'unsafe-inline'")
  expect(file).not.toMatch(/(src|href)\s*=\s*["']?(https?:|\/\/)/i)
  expect(file).not.toMatch(/fetch\(|XMLHttpRequest|<link|<iframe/)
})

test('text in the file cannot close its script early', () => {
  const file = shareFile('AAAA', {
    ...TEXT,
    errors: { ...TEXT.errors, key: '</script><script>alert(1)</script>' },
  })
  expect(file).not.toContain('</script><script>alert(1)')
  expect(file).toContain('\\u003c/script>')
})
