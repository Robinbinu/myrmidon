import { expect, test } from 'bun:test'
import { commandLabel, foregroundCommand } from '../src/terminal-foreground.ts'

test("a command is named by its program's file name and its arguments, cut short when long", () => {
  expect(commandLabel('/opt/homebrew/bin/bun run dev')).toBe('bun run dev')
  expect(commandLabel('  sleep   30 ')).toBe('sleep 30')
  expect(commandLabel(`vim ${'x'.repeat(300)}`).length).toBeLessThanOrEqual(120)
})

test('a shell that is gone tells nothing, rather than an empty name', async () => {
  expect(await foregroundCommand(2 ** 22 + 12_345)).toBeUndefined()
})
