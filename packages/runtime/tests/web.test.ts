import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bunShim } from '../../../tests/platform.ts'
import { BrowserHub, findChrome, navigate, startBrowserProxy } from '../src/browser.ts'
import type { OmpRuntime, ReadResult } from '../src/omp/runtime.ts'
import { prompts } from '../src/prompts.ts'
import {
  assertPublicUrl,
  isPublicAddress,
  ompWebTools,
  pinnedFetch,
  quickRefusal,
  type ReaderPrograms,
  reachableAddresses,
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
    // example.com resolves from a table: the system's DNS (slow or down under load) is not what this checks.
    const web = ompWebTools(omp, () => 'auto', resolver({ 'example.com': ['93.184.216.34'] }))
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
      // The agent's own proxy refused the picture from the other local server, and said why.
      expect(tab.refusal(0)).toContain(`localhost:${other.port} is not a server`)
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

test('full access reaches local and private addresses; without it they stay refused', async () => {
  const lookup = resolver({ 'sneaky.example': ['127.0.0.1'], 'nas.local': ['192.168.1.20'] })
  const all = () => 'all' as const
  const none = () => new Set<number>()
  expect(await reachableAddresses('127.0.0.1', 4318, all, lookup)).toEqual(['127.0.0.1'])
  expect(await reachableAddresses('sneaky.example', 80, all, lookup)).toEqual(['127.0.0.1'])
  expect(await reachableAddresses('nas.local', 80, all, lookup)).toEqual(['192.168.1.20'])
  await expect(reachableAddresses('127.0.0.1', 4318, none, lookup)).rejects.toBeInstanceOf(UnreachableError)
  await expect(reachableAddresses('sneaky.example', 80, none, lookup)).rejects.toBeInstanceOf(
    UnreachableError,
  )
  await expect(reachableAddresses('nas.local', 80, none, lookup)).rejects.toBeInstanceOf(UnreachableError)
  expect(quickRefusal(new URL('http://169.254.169.254/'), all)).toBeUndefined()
  expect(quickRefusal(new URL('http://localhost:4318/'), all)).toBeUndefined()
  expect(quickRefusal(new URL('http://169.254.169.254/'), none)).toBeInstanceOf(UnreachableError)
  expect(quickRefusal(new URL('http://localhost:4318/'), none)).toBeInstanceOf(UnreachableError)

  const dashboard = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('dashboard') })
  try {
    const url = `http://127.0.0.1:${dashboard.port}/`
    expect(await (await pinnedFetch(url, {}, { localPorts: all })).text()).toBe('dashboard')
    await expect(pinnedFetch(url, {}, { localPorts: none })).rejects.toBeInstanceOf(UnreachableError)
    const proxy = await startBrowserProxy({ localPorts: all })
    try {
      expect(
        await viaProxy(proxy.port, `GET ${url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
      ).toContain('dashboard')
    } finally {
      proxy.close()
    }
  } finally {
    dashboard.stop(true)
  }
})

test.skipIf(!findChrome())(
  'a full-access tab reaches any local server, while a confined tab beside it still cannot',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myr-reach-full-'))
    const other = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<title>Local</title>', { headers: { 'content-type': 'text/html' } }),
    })
    const otherUrl = `http://127.0.0.1:${other.port}/`
    const hub = new BrowserHub(join(dir, 'profile'))
    try {
      const free = await hub.tab('c1', 'wren', { localPorts: () => 'all' })
      await navigate(free, free.page, otherUrl)
      expect(await free.page.title()).toBe('Local')
      const confined = await hub.tab('c2', 'kai', { localPorts: () => new Set<number>() })
      await expect(navigate(confined, confined.page, otherUrl)).rejects.toThrow(
        `localhost:${other.port} is not a server`,
      )
    } finally {
      await hub.close()
      other.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  },
  60_000,
)

/** A stand-in yt-dlp: it fetches `targets` through the proxy it was given, as yt-dlp would, and reports what it saw. */
function standInYtDlp(dir: string, targets: string[]): string {
  const script = join(dir, 'yt-dlp.ts')
  writeFileSync(
    script,
    `const args = process.argv.slice(2)
const proxy = args[args.indexOf('--proxy') + 1]
const results = []
for (const target of ${JSON.stringify(targets)}) {
  try {
    const res = await fetch(target, { proxy })
    results.push(res.status + ' ' + (await res.text()))
  } catch (err) {
    results.push('error ' + err)
  }
}
console.log(JSON.stringify({ args, cwd: process.cwd(), envProxy: process.env.HTTPS_PROXY, results }))
`,
  )
  return bunShim(join(dir, 'yt-dlp'), script)
}

/** A stand-in page reader (trafilatura or lynx): it reports its arguments and what came on stdin. */
function standInPageReader(dir: string, name: string): string {
  const script = join(dir, 'page-reader.ts')
  writeFileSync(
    script,
    'console.log(JSON.stringify({ args: process.argv.slice(2), input: await Bun.stdin.text() }))\n',
  )
  return bunShim(join(dir, name), script)
}

test('a YouTube video is read by yt-dlp, and every connection it makes goes through the guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-readers-'))
  const reachedOther: string[] = []
  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      reachedOther.push(req.url)
      return new Response('dashboard')
    },
  })
  const own = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new URL(req.url).pathname === '/away'
        ? Response.redirect(`http://127.0.0.1:${other.port}/`, 302)
        : new Response('the transcript'),
  })
  try {
    const ytDlp = standInYtDlp(dir, [
      `http://localhost:${own.port}/subs`,
      `http://127.0.0.1:${other.port}/`,
      `http://localhost:${own.port}/away`,
      `http://sneaky.example:${own.port}/`,
    ])
    // A stand-in for omp's reader: like its YouTube handler, it runs yt-dlp on the video and reads its output.
    const omp = {
      async read(url: string): Promise<ReadResult> {
        if (new URL(url).hostname !== 'www.youtube.com')
          return { url, method: 'native', contentType: 'text/html', output: 'a page' }
        const proc = Bun.spawn(
          [ytDlp, '--dump-json', '--no-warnings', '--no-playlist', '--skip-download', url],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const output = await new Response(proc.stdout).text()
        return { url, method: 'youtube', contentType: 'text/plain', output }
      },
    } as unknown as OmpRuntime
    const web = ompWebTools(
      omp,
      () => 'auto',
      resolver({ 'www.youtube.com': ['93.184.216.34'], 'sneaky.example': ['127.0.0.1'] }),
      async () => ({ 'yt-dlp': ytDlp }),
    )
    const video = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const page = await web.read(video, () => new Set([own.port as number]))
    expect(page.method).toBe('youtube')
    const seen = JSON.parse(page.output) as {
      args: string[]
      cwd: string
      envProxy: string
      results: string[]
    }
    const proxy = seen.args[2] ?? ''
    expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(seen.args).toEqual([
      '--ignore-config',
      '--proxy',
      proxy,
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      video,
    ])
    expect(seen.envProxy).toBe(proxy)
    expect(seen.cwd).toContain('myrmidon-reader-')
    // Its own server is reached; another local port, a redirect into one and a name resolving to one are not.
    expect(seen.results[0]).toBe('200 the transcript')
    expect(seen.results.slice(1).map((r) => r.slice(0, 3))).toEqual(['403', '403', '403'])
    expect(reachedOther).toEqual([])
  } finally {
    own.stop(true)
    other.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reader programs take only the options omp passes them; any other program is refused', async () => {
  const ytDlp = join(tmpdir(), 'yt-dlp')
  const trafilatura = join(tmpdir(), 'trafilatura')
  const video = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  await withPinnedNetwork({ readers: true }, async (refused) => {
    for (const command of [
      ['/bin/sh', '-c', 'true'],
      [join(tmpdir(), 'uv'), 'tool', 'install', 'trafilatura'],
      [ytDlp, '--exec', 'touch pwned', video],
      [ytDlp, '--batch-file', '/etc/passwd'],
      [ytDlp, '--cookies', '/etc/passwd', video],
      [ytDlp, '-o', '/etc/out', video],
      [ytDlp, 'file:///etc/passwd'],
      [ytDlp, video, 'https://example.com/'],
      [trafilatura, '-u', 'file:///etc/passwd', '--output-format', 'markdown'],
      [trafilatura, '-i', '/etc/passwd'],
      [trafilatura, '-u', video, '--output-format', '../x'],
    ])
      expect(() => Bun.spawn(command)).toThrow('does not run other programs')
    // A private address is refused before the program starts, saying why.
    expect(() => Bun.spawn([ytDlp, 'http://169.254.169.254/latest/meta-data/'])).toThrow('private or local')
    expect(refused).toHaveLength(1)
  })
  // Without the guard proxy (no reader installed) not even a reader starts.
  await withPinnedNetwork({}, async () => {
    expect(() => Bun.spawn([ytDlp, video])).toThrow('does not run other programs')
  })
})

test('trafilatura and lynx get the page on stdin, fetched through the guard, instead of its URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-readers-'))
  const reachedOther: string[] = []
  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      reachedOther.push(req.url)
      return new Response('dashboard')
    },
  })
  const own = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new URL(req.url).pathname === '/away'
        ? Response.redirect(`http://127.0.0.1:${other.port}/`, 302)
        : new Response('<p>article</p>', { headers: { 'content-type': 'text/html' } }),
  })
  try {
    const trafilatura = standInPageReader(dir, 'trafilatura')
    const lynx = standInPageReader(dir, 'lynx')
    const lookup = resolver({ 'sneaky.example': ['127.0.0.1'] })
    const localPorts = () => new Set([own.port as number])
    await withPinnedNetwork({ readers: true, localPorts, lookup }, async (refused) => {
      const run = async (command: string[]) => {
        const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
        return JSON.parse(await new Response(proc.stdout).text()) as { args: string[]; input: string }
      }
      // omp's own command lines for both.
      const viaTrafilatura = (url: string) => run([trafilatura, '-u', url, '--output-format', 'markdown'])
      const page = `http://localhost:${own.port}/page`
      expect(await viaTrafilatura(page)).toEqual({
        args: ['--output-format', 'markdown'],
        input: '<p>article</p>',
      })
      expect(await run([lynx, '-dump', '-nolist', '-width', '250', page])).toEqual({
        args: ['-dump', '-nolist', '-width', '250', '-force_html', '-stdin'],
        input: '<p>article</p>',
      })
      // A redirect into another local port, or a name resolving to one, leaves the reader with nothing to read.
      expect((await viaTrafilatura(`http://localhost:${own.port}/away`)).input).toBe('')
      expect((await viaTrafilatura(`http://sneaky.example:${own.port}/`)).input).toBe('')
      expect(() =>
        Bun.spawn([trafilatura, '-u', `http://127.0.0.1:${other.port}/`, '--output-format', 'markdown']),
      ).toThrow(`localhost:${other.port} is not a server`)
      expect(refused).toHaveLength(3)
    })
    expect(reachedOther).toEqual([])
  } finally {
    own.stop(true)
    other.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing reader falls back and says what would enable it; a read installs nothing', async () => {
  const video = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  const download = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos'
  const attempts: string[] = []
  // A stand-in for omp's reader with no yt-dlp: like ensureTool, it tries to download yt-dlp and to install
  // trafilatura, then reports the video without a transcript, and an unconvertible page as raw HTML.
  const omp = {
    async read(url: string): Promise<ReadResult> {
      if (url === video) {
        attempts.push(
          await fetch(download).then(
            () => 'downloaded',
            (err: Error) => err.message,
          ),
        )
        try {
          Bun.spawn(['uv', 'tool', 'install', 'trafilatura'])
          attempts.push('installed')
        } catch (err) {
          attempts.push((err as Error).message)
        }
        return { url, method: 'youtube-no-ytdlp', contentType: 'text/plain', output: 'no yt-dlp' }
      }
      return { url, method: 'raw-html', contentType: 'text/html', output: '<div id="app"></div>' }
    },
  } as unknown as OmpRuntime
  const lookup = resolver({ 'www.youtube.com': ['93.184.216.34'], 'example.com': ['93.184.216.34'] })
  const none = ompWebTools(
    omp,
    () => 'auto',
    lookup,
    async () => ({}),
  )
  expect((await none.read(video)).output).toBe(prompts.toolResults.noTranscriptReader(video))
  expect(attempts).toEqual([prompts.toolResults.readerInstall, prompts.toolResults.readerProgram])
  expect((await none.read('https://example.com/app')).output).toBe(
    `${prompts.toolResults.noPageReader}\n\n<div id="app"></div>`,
  )
  // With a page reader installed, raw HTML means it was tried too: nothing to suggest.
  const installed: ReaderPrograms = { trafilatura: '/usr/bin/trafilatura' }
  const some = ompWebTools(
    omp,
    () => 'auto',
    lookup,
    async () => installed,
  )
  expect((await some.read('https://example.com/app')).output).toBe('<div id="app"></div>')
  // A release download the agent asked for itself is fetched like any page.
  const net = network({ [download]: { body: 'binary' } })
  await withPinnedNetwork(
    { url: download, fetch: net.fetch, lookup: resolver({ 'github.com': ['140.82.112.3'] }) },
    async () => {
      expect(await (await fetch(download)).text()).toBe('binary')
    },
  )
})
