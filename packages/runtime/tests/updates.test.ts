import { expect, test } from 'bun:test'
import { UPDATE_CHECK_TTL_MS } from '../src/config.ts'
import { UpdateChecker } from '../src/updates.ts'

/** A GitHub that answers `releases/latest` with `status` and `body`, counting the calls it gets. */
function github(status: number, body: unknown = {}) {
  const calls: string[] = []
  const fetch = async (input: string | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify(body), { status })
  }
  return { fetch, calls }
}

test('a newer release is offered with its page; the same or an older one is current', async () => {
  const newer = github(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0' })
  expect(
    await new UpdateChecker({ fetch: newer.fetch, repo: 'o/r', current: '0.1.0' }).check(),
  ).toMatchObject({
    status: 'available',
    current: '0.1.0',
    latest: '0.2.0',
    url: 'https://github.com/o/r/releases/tag/v0.2.0',
  })
  expect(newer.calls).toEqual(['https://api.github.com/repos/o/r/releases/latest'])
  const same = github(200, { tag_name: 'v0.1.0' })
  expect(await new UpdateChecker({ fetch: same.fetch, current: '0.1.0' }).check()).toMatchObject({
    status: 'current',
    latest: '0.1.0',
  })
  const older = github(200, { tag_name: '0.0.9' })
  expect((await new UpdateChecker({ fetch: older.fetch, current: '0.1.0' }).check()).status).toBe('current')
})

test('no release yet, a tag that is not a version, or an error says so instead of guessing', async () => {
  expect((await new UpdateChecker({ fetch: github(404).fetch }).check()).status).toBe('none')
  expect(
    (await new UpdateChecker({ fetch: github(200, { tag_name: 'nightly' }).fetch }).check()).status,
  ).toBe('none')
  expect(await new UpdateChecker({ fetch: github(503).fetch }).check()).toMatchObject({
    status: 'unreachable',
    error: 'GitHub answered 503',
  })
  const offline = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com')
  }
  expect(await new UpdateChecker({ fetch: offline }).check()).toMatchObject({
    status: 'unreachable',
    error: 'getaddrinfo ENOTFOUND api.github.com',
  })
})

test('an answer is reused for an hour unless forced, and a failure is never reused', async () => {
  let now = 1_000
  const gh = github(200, { tag_name: 'v0.1.0' })
  const checker = new UpdateChecker({ fetch: gh.fetch, now: () => now, current: '0.1.0' })
  await checker.check()
  await checker.check()
  expect(gh.calls).toHaveLength(1)
  await checker.check(true)
  expect(gh.calls).toHaveLength(2)
  now += UPDATE_CHECK_TTL_MS
  await checker.check()
  expect(gh.calls).toHaveLength(3)

  let fail = true
  const flaky = new UpdateChecker({
    fetch: async () => (fail ? new Response('', { status: 500 }) : new Response('{"tag_name":"v0.1.0"}')),
    current: '0.1.0',
  })
  expect((await flaky.check()).status).toBe('unreachable')
  fail = false
  expect((await flaky.check()).status).toBe('current')
})
