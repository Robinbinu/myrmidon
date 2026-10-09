import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOSTED_DAYS, hostFile, serveHosted } from '../src/channels/push.ts'
import { testIO } from './fixtures/channel-server.ts'

const HOOK = 'https://box.example/hooks/channels/line'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function io(webhookUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'myr-hosted-'))
  dirs.push(dir)
  return testIO(webhookUrl, dir).handle
}

const pdf = { name: 'report (final).pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }

test('a hosted file is served from the webhook address by its token, as a download', async () => {
  const handle = io(HOOK)
  const url = hostFile(handle, pdf)
  expect(url).toMatch(/^https:\/\/box\.example\/hooks\/channels\/line\?file=[\w-]{32}$/)
  const res = serveHosted(handle, new Request(url ?? ''))
  expect(res?.status).toBe(200)
  expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(pdf.data)
  expect(res?.headers.get('content-type')).toBe('application/pdf')
  // Never rendered on the gateway's own origin: a download, sandboxed, not sniffed.
  expect(res?.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report%20(final).pdf")
  expect(res?.headers.get('content-security-policy')).toContain('sandbox')
  expect(res?.headers.get('x-content-type-options')).toBe('nosniff')

  const png = hostFile(handle, { name: 'chart.png', mimeType: 'image/png', data: new Uint8Array([9]) })
  const head = serveHosted(handle, new Request(png ?? '', { method: 'HEAD' }))
  expect(head?.headers.get('content-disposition')).toStartWith('inline;')
  expect(head?.headers.get('content-length')).toBe('1')
})

test('only a GET carrying a file token is a download; a wrong or expired token is not found', () => {
  const handle = io(HOOK)
  const url = hostFile(handle, pdf) ?? ''
  // Webhooks (POSTs, a GET without the parameter) go on to the platform's own handling.
  expect(serveHosted(handle, new Request(url, { method: 'POST', body: '{}' }))).toBeUndefined()
  expect(serveHosted(handle, new Request(HOOK))).toBeUndefined()
  expect(serveHosted(handle, new Request(`${HOOK}?file=../../channels.json`))?.status).toBe(404)
  expect(serveHosted(handle, new Request(`${HOOK}?file=${'a'.repeat(32)}`))?.status).toBe(404)

  const later = Date.now() + HOSTED_DAYS * 24 * 3600_000 + 1000
  expect(serveHosted(handle, new Request(url), later)?.status).toBe(404)
  expect(readdirSync(join(handle.dir, 'hosted'))).toEqual([])
})

test('expired files are cleared as new ones are hosted', () => {
  const handle = io(HOOK)
  const old = hostFile(handle, pdf, Date.now() - HOSTED_DAYS * 24 * 3600_000 - 1000) ?? ''
  const token = new URL(old).searchParams.get('file') ?? ''
  expect(existsSync(join(handle.dir, 'hosted', token))).toBe(true)
  hostFile(handle, pdf)
  expect(existsSync(join(handle.dir, 'hosted', token))).toBe(false)
  expect(readdirSync(join(handle.dir, 'hosted'))).toHaveLength(2)
})

test('without an HTTPS public address no file is hosted', () => {
  expect(hostFile(io(undefined), pdf)).toBeUndefined()
  expect(hostFile(io('http://box.example/hooks/channels/line'), pdf)).toBeUndefined()
})
