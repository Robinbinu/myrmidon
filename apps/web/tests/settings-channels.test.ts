import { expect, test } from 'bun:test'
import { channelStatusText } from '../src/client/channel-status.ts'

test('a channel that is set up but switched off says so, rather than reading as connected or plain "Off"', () => {
  const off = { state: 'off' as const }
  expect(channelStatusText({ configured: true, enabled: false, status: off })).toBe('Set up · off')
  expect(channelStatusText({ configured: false, enabled: false, status: off })).toBe('Setup not finished')
  expect(channelStatusText({ configured: false, enabled: true, status: off })).toBe('Setup not finished')
  expect(
    channelStatusText({ configured: true, enabled: true, status: { state: 'on', account: '@mybot' } }),
  ).toBe('Connected as @mybot')
})
