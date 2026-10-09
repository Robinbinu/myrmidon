import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserHub, findChrome, navigate, startBrowserProxy } from '../src/browser.ts'
import type { OmpRuntime } from '../src/omp/runtime.ts'
import {
  assertPublicUrl,
  isPublicAddress,
  ompWebTools,
  pinnedFetch,
  UnreachableError,
  withPinnedNetwork,
} from '../src/web.ts'

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

const resolver = (table: Record<string, string[] | (() => string[])>) => {
  const calls: string[] = []
  const lookup = async (host: string) => {
    calls.push(host)
    const found = table[host]
    if (!found) throw new Error(`ENOTFOUND ${host}`)
    return typeof found === 'function' ? found() : found
  }
  return Object.assign(lookup, { calls })
}

/** A stand-in for the network: records what was sent where, and answers from `routes` (keyed by the URL as named). */
function network(routes: Record<string, { status?: number; location?: string; body?: string }> = {}) {
  const sent: { url: string; host: string | null; serverName?: string }[] = []
  const fetcher = (async (url: string, init: RequestInit & { tls?: { serverName?: string } }) => {
    const headers = new Headers(init.headers)
    const named = new URL(url)
    named.host = headers.get('host') ?? named.host
    sent.push({
      url,
      host: headers.get('host'),
      ...(init.tls?.serverName ? { serverName: init.tls.serverName } : {}),
    })
    const route = routes[named.href] ?? {}
    return new Response(route.body ?? 'ok', {
      status: route.status ?? 200,
      headers: route.location ? { location: route.location } : {},
    })
  }) as unknown as typeof fetch
  return { sent, fetch: fetcher }
}

test('private addresses in every spelling are refused before anything is sent', async () => {
  const net = network()
  for (const url of [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.5.4/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0:4318/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    // Decimal, hex and octal forms; the URL parser turns them into dotted form, which the check sees.
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://metadata.google.internal/',
    'http://printer.local/',
  ])
    await expect(pinnedFetch(url, {}, { fetch: net.fetch, lookup: resolver({}) })).rejects.toBeInstanceOf(
      UnreachableError,
    )
  expect(net.sent).toEqual([])
})

test('a name that resolves to a private address is refused, even next to a public one', async () => {
  const lookup = resolver({
    'sneaky.example': ['127.0.0.1'],
    'mixed.example': ['93.184.216.34', '10.0.0.5'],
    'meta.example': ['169.254.169.254'],
  })
  const net = network()
  await expect(pinnedFetch('https://sneaky.example/', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    'resolves to 127.0.0.1',
  )
  await expect(pinnedFetch('https://mixed.example/', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    'resolves to 10.0.0.5',
  )
  await expect(pinnedFetch('http://meta.example/', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    'resolves to 169.254.169.254',
  )
  // Even with a port the run opened: only localhost names reach a dev server, not a public name pointed at it.
  await expect(
    pinnedFetch(
      'http://sneaky.example:5173/',
      {},
      { fetch: net.fetch, lookup, localPorts: () => new Set([5173]) },
    ),
  ).rejects.toThrow('resolves to 127.0.0.1')
  expect(net.sent).toEqual([])
})

test('a public address is fetched, pinned to the address that was checked', async () => {
  const lookup = resolver({ 'example.com': ['93.184.216.34'], 'v6.example': ['2606:4700:4700::1111'] })
  const net = network({ 'https://example.com/a?b=1': { body: 'hello' } })
  const res = await pinnedFetch('https://example.com/a?b=1', {}, { fetch: net.fetch, lookup })
  expect(await res.text()).toBe('hello')
  expect(res.url).toBe('https://example.com/a?b=1')
  await pinnedFetch('http://v6.example:8080/', {}, { fetch: net.fetch, lookup })
  expect(net.sent).toEqual([
    // TLS is still checked against the name; only the connection goes to the checked address.
    { url: 'https://93.184.216.34/a?b=1', host: 'example.com', serverName: 'example.com' },
    { url: 'http://[2606:4700:4700::1111]:8080/', host: 'v6.example:8080' },
  ])
})

test('DNS rebinding cannot reach a private address: the checked answer is the one connected to', async () => {
  let answers = 0
  // Public for the check, private for whoever asks next: the classic rebinding server.
  const lookup = resolver({ 'rebind.example': () => (answers++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']) })
  const net = network()
  await pinnedFetch('http://rebind.example/', {}, { fetch: net.fetch, lookup })
  expect(lookup.calls).toEqual(['rebind.example'])
  expect(net.sent).toEqual([{ url: 'http://93.184.216.34/', host: 'rebind.example' }])
  // The next request looks the name up again and is refused on what it gets now.
  await expect(pinnedFetch('http://rebind.example/', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    'resolves to 127.0.0.1',
  )
  expect(net.sent).toHaveLength(1)
})

test('every redirect hop is checked before it is requested', async () => {
  const lookup = resolver({
    'a.example': ['93.184.216.34'],
    'b.example': ['1.1.1.1'],
    'metadata.example': ['169.254.169.254'],
  })
  const net = network({
    'https://a.example/start': { status: 302, location: 'https://b.example/next' },
    'https://b.example/next': { status: 301, location: '/final' },
    'https://b.example/final': { body: 'done' },
    'https://a.example/bad': { status: 302, location: 'http://metadata.example/latest/meta-data/' },
    'https://a.example/literal': { status: 307, location: 'http://10.0.0.5/admin' },
    'https://a.example/loop': { status: 302, location: 'https://a.example/loop' },
  })
  const res = await pinnedFetch('https://a.example/start', {}, { fetch: net.fetch, lookup })
  expect([res.url, res.redirected, await res.text()]).toEqual(['https://b.example/final', true, 'done'])
  expect(net.sent.map((s) => `${s.host} via ${new URL(s.url).hostname}`)).toEqual([
    'a.example via 93.184.216.34',
    'b.example via 1.1.1.1',
    'b.example via 1.1.1.1',
  ])

  net.sent.length = 0
  await expect(pinnedFetch('https://a.example/bad', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    'resolves to 169.254.169.254',
  )
  await expect(pinnedFetch('https://a.example/literal', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    '10.0.0.5 is a private',
  )
  // The private hops were refused before anything was sent to them.
  expect(net.sent.map((s) => s.host)).toEqual(['a.example', 'a.example'])
  await expect(pinnedFetch('https://a.example/loop', {}, { fetch: net.fetch, lookup })).rejects.toThrow(
    'too many redirects',
  )
})

test("the run's own dev-server port is reachable on localhost; other localhost ports are not", async () => {
  const own = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('my app') })
  const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('dashboard') })
  try {
    const localPorts = () => new Set([own.port as number])
    for (const url of [`http://localhost:${own.port}/`, `http://127.0.0.1:${own.port}/`]) {
      const res = await pinnedFetch(url, {}, { localPorts })
      expect(await res.text()).toBe('my app')
    }
    for (const url of [
      `http://localhost:${other.port}/`,
      `http://127.0.0.1:${other.port}/`,
      `http://[::1]:${other.port}/`,
    ])
      await expect(pinnedFetch(url, {}, { localPorts })).rejects.toThrow(
        `localhost:${other.port} is not a server`,
      )
    // Without the run's ports, no localhost port is reachable at all.
    await expect(pinnedFetch(`http://localhost:${own.port}/`)).rejects.toBeInstanceOf(UnreachableError)
    // A redirect from the run's own server to another local port is checked like any other hop.
    const hop = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.redirect(`http://127.0.0.1:${other.port}/`, 302),
    })
    try {
      await expect(
        pinnedFetch(`http://localhost:${hop.port}/`, {}, { localPorts: () => new Set([hop.port as number]) }),
      ).rejects.toThrow(`localhost:${other.port} is not a server`)
    } finally {
      hop.stop(true)
    }
  } finally {
    own.stop(true)
    other.stop(true)
  }
})

test('inside an agent read every fetch is pinned and no program can start', async () => {
  const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('private') })
  try {
    const url = `http://127.0.0.1:${local.port}/`
    await withPinnedNetwork({}, async (refused) => {
      await expect(fetch(url)).rejects.toBeInstanceOf(UnreachableError)
      expect(() => Bun.spawn(['true'])).toThrow('does not run other programs')
      expect(() => Bun.spawnSync(['true'])).toThrow('does not run other programs')
      expect(refused).toHaveLength(1)
    })
    // Outside one, the process's fetch and spawn work as before.
    expect(await (await fetch(url)).text()).toBe('private')
    expect(Bun.spawnSync(['true']).exitCode).toBe(0)
  } finally {
    local.stop(true)
  }
})

test("web_fetch says why when the reader's fetch was refused", async () => {
  const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('secret') })
  try {
    // A stand-in for omp's reader: like it, it fetches with the global fetch and reports failure as a result.
    const omp = {
      async read(url: string) {
        const target = url.includes('alternate') ? `http://127.0.0.1:${local.port}/` : url
        try {
          const res = await fetch(target)
          return { url: res.url, method: 'native', contentType: 'text/plain', output: await res.text() }
        } catch {
          return { url, method: 'failed', contentType: '', output: 'Failed to fetch URL' }
        }
      },
    } as unknown as OmpRuntime
    const web = ompWebTools(omp, () => 'auto')
    await expect(web.read('https://example.com/alternate')).rejects.toThrow(
      `localhost:${local.port} is not a server`,
    )
    await expect(web.read(`http://localhost:${local.port}/`)).rejects.toThrow('is not a server')
    expect(
      (await web.read(`http://localhost:${local.port}/`, () => new Set([local.port as number]))).output,
    ).toBe('secret')
  } finally {
    local.stop(true)
  }
})

/** Sends one raw request to the proxy and returns the start of what comes back. */
async function viaProxy(port: number, head: string): Promise<string> {
  const { connect } = await import('node:net')
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(head))
    let got = ''
    socket.on('data', (d) => {
      got += d.toString()
      if (
        got.includes('\r\n\r\n') &&
        (got.startsWith('HTTP/1.1 200 Connection') || got.includes('\r\n\r\n'))
      ) {
        socket.destroy()
        resolve(got)
      }
    })
    socket.on('error', reject)
  })
}

test("the browser's proxy checks and pins every connection", async () => {
  const own = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => new Response(`app ${new URL(req.url).pathname}`),
  })
  const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('dashboard') })
  const refusals: string[] = []
  const proxy = await startBrowserProxy({
    localPorts: () => new Set([own.port as number]),
    lookup: resolver({ 'sneaky.example': ['127.0.0.1'] }),
    onRefused: (reason) => refusals.push(reason),
  })
  try {
    const get = (url: string) =>
      viaProxy(proxy.port, `GET ${url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    expect(await get(`http://localhost:${own.port}/page`)).toContain('app /page')
    expect(await get(`http://localhost:${other.port}/`)).toStartWith('HTTP/1.1 403')
    expect(await get(`http://sneaky.example:${own.port}/`)).toStartWith('HTTP/1.1 403')
    expect(await get('http://2130706433/')).toStartWith('HTTP/1.1 403')
    const tunnel = (target: string) =>
      viaProxy(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    expect(await tunnel('169.254.169.254:443')).toStartWith('HTTP/1.1 403')
    expect(await tunnel(`2130706433:${other.port}`)).toStartWith('HTTP/1.1 403')
    expect(await tunnel(`[::ffff:127.0.0.1]:${own.port}`)).toStartWith('HTTP/1.1 403')
    expect(await tunnel(`localhost:${own.port}`)).toStartWith('HTTP/1.1 200 Connection Established')
    expect(refusals.length).toBe(6)
    expect(refusals[0]).toContain(`localhost:${other.port} is not a server`)
  } finally {
    proxy.close()
    own.stop(true)
    other.stop(true)
  }
})

test.skipIf(!findChrome())(
  "the agents' browser reaches its own server but no other private address, redirects and subresources included",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myr-reach-'))
    const reachedOther: string[] = []
    const other = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        reachedOther.push(req.url)
        return new Response('dashboard')
      },
    })
    const otherUrl = `http://127.0.0.1:${other.port}/`
    const hits: string[] = []
    const own = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname
        hits.push(path)
        if (path === '/away') return Response.redirect(otherUrl, 302)
        return new Response(`<title>Mine</title><img src="${otherUrl}pixel.png"><p>hello</p>`, {
          headers: { 'content-type': 'text/html' },
        })
      },
    })
    const hub = new BrowserHub(join(dir, 'profile'))
    try {
      const tab = await hub.tab('c1', 'wren', { localPorts: () => new Set([own.port as number]) })
      await navigate(tab, tab.page, `http://localhost:${own.port}/`)
      expect(await tab.page.title()).toBe('Mine')
      await tab.page.waitForNetworkIdle({ idleTime: 300, timeout: 5_000 }).catch(() => {})
      expect(tab.logs.some((l) => l.includes(`blocked: ${otherUrl}pixel.png`))).toBe(true)
      await expect(navigate(tab, tab.page, otherUrl)).rejects.toThrow(
        `localhost:${other.port} is not a server`,
      )
      await expect(navigate(tab, tab.page, `http://localhost:${own.port}/away`)).rejects.toThrow(
        'the browser did not load',
      )
      await expect(navigate(tab, tab.page, 'http://169.254.169.254/')).rejects.toThrow('private or local')
    } finally {
      await hub.close()
      own.stop(true)
      other.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
    expect(hits).toContain('/away')
    expect(reachedOther).toEqual([])
  },
  60_000,
)
