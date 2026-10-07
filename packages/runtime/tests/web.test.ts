import { expect, test } from 'bun:test'
import { assertPublicTarget, assertPublicUrl, followPublicRedirects, isPublicAddress } from '../src/web.ts'

test('private, local, reserved and special-purpose addresses are not public', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '192.0.2.10',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
  ])
    expect([ip, isPublicAddress(ip)]).toEqual([ip, false])
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'])
    expect([ip, isPublicAddress(ip)]).toEqual([ip, true])
})

test('URLs with credentials, other schemes, or private hosts are refused before any lookup', () => {
  expect(() => assertPublicUrl('http://user:pass@example.com/')).toThrow('credentials')
  expect(() => assertPublicUrl('file:///etc/passwd')).toThrow('http(s)')
  expect(() => assertPublicUrl('http://localhost:4318/api')).toThrow('private')
  // The URL parser turns other spellings of an address into dotted form, which the check sees.
  expect(() => assertPublicUrl('http://2130706433/')).toThrow('private')
  expect(() => assertPublicUrl('http://[::ffff:7f00:1]/')).toThrow('private')
  expect(assertPublicUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
})

const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const found = table[host]
  if (!found) throw new Error(`ENOTFOUND ${host}`)
  return found
}

test('a public name that resolves to a private address is refused', async () => {
  const lookup = resolver({
    'example.com': ['93.184.216.34'],
    'sneaky.example': ['127.0.0.1'],
    'mixed.example': ['93.184.216.34', '10.0.0.5'],
  })
  expect(await assertPublicTarget('https://example.com/', lookup)).toBe('https://example.com/')
  await expect(assertPublicTarget('https://sneaky.example/', lookup)).rejects.toThrow('resolves to 127.0.0.1')
  await expect(assertPublicTarget('https://mixed.example/', lookup)).rejects.toThrow('resolves to 10.0.0.5')
  await expect(assertPublicTarget('https://gone.example/', lookup)).rejects.toThrow('ENOTFOUND')
})

test('every redirect hop is checked before it is requested', async () => {
  const lookup = resolver({
    'a.example': ['93.184.216.34'],
    'b.example': ['1.1.1.1'],
    'metadata.example': ['169.254.169.254'],
  })
  const requested: string[] = []
  const fetcher = (async (url: string) => {
    requested.push(url)
    const to: Record<string, string> = {
      'https://a.example/start': 'https://b.example/next',
      'https://b.example/next': '/final',
      'https://a.example/bad': 'http://metadata.example/latest/meta-data/',
    }
    const next = to[url]
    return next ? new Response(null, { status: 302, headers: { location: next } }) : new Response('ok')
  }) as unknown as typeof fetch
  expect(await followPublicRedirects('https://a.example/start', { lookup, fetch: fetcher })).toBe(
    'https://b.example/final',
  )
  expect(requested).toEqual(['https://a.example/start', 'https://b.example/next', 'https://b.example/final'])

  requested.length = 0
  await expect(followPublicRedirects('https://a.example/bad', { lookup, fetch: fetcher })).rejects.toThrow(
    'resolves to 169.254.169.254',
  )
  // The private hop was refused before anything was sent to it.
  expect(requested).toEqual(['https://a.example/bad'])
})
