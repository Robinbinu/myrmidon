import { expect, test } from 'bun:test'
import { commandLabel, foregroundCommand } from '../src/terminal-foreground.ts'

test('a command is named by its program and its first argument, as a tab has room for', () => {
  expect(commandLabel('/opt/homebrew/bin/bun run dev')).toBe('bun run dev')
  expect(commandLabel('npm start')).toBe('npm start')
  expect(commandLabel('/usr/bin/python3 app.py --port 8000')).toBe('python3 app.py')
  expect(commandLabel('  sleep   30 ')).toBe('sleep 30')
  expect(commandLabel('vim -u NONE notes.md')).toBe('vim NONE')
  expect(commandLabel('ls -la')).toBe('ls')
  // A script run by its interpreter is named by the script, as it was typed.
  expect(commandLabel('node /usr/local/bin/npm run dev')).toBe('npm run dev')
  expect(commandLabel(`vim ${'x'.repeat(300)}`).length).toBeLessThanOrEqual(60)
})

test('nothing that looks like a secret reaches the tab, however the command was typed', () => {
  // ps shows arguments after the shell expanded them, so `-p$DB_PASS` arrives as the password itself.
  expect(commandLabel('mysql -phunter2 -u root shop')).toBe('mysql root')
  expect(commandLabel('perl -e sleep 3 -- --password=hunter2-from-env')).toBe('perl sleep')
  expect(commandLabel('psql --password=hunter2 db')).toBe('psql db')
  expect(commandLabel('gh --token=ghp_abc123 api')).toBe('gh api')
  expect(commandLabel('tool API_KEY=abc123 run')).toBe('tool')
  expect(commandLabel('tool client_secret=abc123')).toBe('tool')
  expect(commandLabel('tool auth_token=abc123')).toBe('tool')
  expect(commandLabel('curl -H Authorization: Bearer eyJhbGciOi https://api.example.com')).toBe('curl')
  expect(commandLabel('curl Bearer eyJhbGciOi')).toBe('curl')
  expect(commandLabel('curl https://robin:hunter2@example.com/x')).toBe('curl https://example.com/x')
  expect(commandLabel('deploy sk_live_51Hx9Q2abcDEF123456789xyz')).toBe('deploy')
  for (const label of [
    commandLabel('mysql -phunter2 -u root shop'),
    commandLabel('curl https://robin:hunter2@example.com/x'),
    commandLabel('perl -e sleep 3 -- --password=hunter2-from-env'),
  ])
    expect(label).not.toContain('hunter2')
})

test('a shell that is gone tells nothing, rather than an empty name', async () => {
  expect(await foregroundCommand(2 ** 22 + 12_345)).toBeUndefined()
})
