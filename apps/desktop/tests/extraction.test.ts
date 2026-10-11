import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeRetainedArchives } from '../src/extraction.ts'

test("the unpacked app's retained archives go, and nothing else in its folder", () => {
  const userData = mkdtempSync(join(tmpdir(), 'myr-extraction-'))
  try {
    const folder = join(userData, 'self-extraction')
    mkdirSync(folder)
    writeFileSync(join(folder, '2awjhpteim5us.tar'), 'x'.repeat(1000))
    writeFileSync(join(folder, 'prepared-update.json'), '{}')
    writeFileSync(join(userData, '.electrobun-uninstall.json'), '{}')
    const outside = join(userData, 'keep.tar')
    writeFileSync(outside, 'keep')
    symlinkSync(outside, join(folder, 'linked.tar'))

    expect(removeRetainedArchives(userData)).toBe(1000)
    expect(existsSync(join(folder, '2awjhpteim5us.tar'))).toBe(false)
    // What the updater and uninstaller still need, and anything a link points at, stays.
    expect(existsSync(join(folder, 'prepared-update.json'))).toBe(true)
    expect(existsSync(join(userData, '.electrobun-uninstall.json'))).toBe(true)
    expect(existsSync(outside)).toBe(true)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('no unpacked folder (a development run) is nothing to do', () => {
  expect(removeRetainedArchives(join(tmpdir(), 'myr-no-such-folder'))).toBe(0)
})
