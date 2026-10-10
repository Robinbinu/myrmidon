import { expect, test } from 'bun:test'
import { shutdownSignals } from '../src/shutdown.ts'

test('Ctrl+C and SIGTERM stop the server everywhere; Windows adds Ctrl+Break and closing the console', () => {
  expect(shutdownSignals('darwin')).toEqual(['SIGINT', 'SIGTERM'])
  expect(shutdownSignals('linux')).toEqual(['SIGINT', 'SIGTERM'])
  expect(shutdownSignals('win32')).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])
})
