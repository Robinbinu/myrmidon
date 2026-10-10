import { expect, test } from 'bun:test'
import { commandLabel, foregroundCommand } from '../src/terminal-foreground.ts'

test('a command is named by its program and its first argument, as a tab has room for', () => {
  expect(commandLabel('/opt/homebrew/bin/bun run dev')).toBe('bun run dev')
  expect(commandLabel('npm start')).toBe('npm start')
  expect(commandLabel('/usr/bin/python3 app.py --port 8000')).toBe('python3 app.py')
  expect(commandLabel('  sleep   30 ')).toBe('sleep 30')
  expect(commandLabel('vim -u NONE notes.md')).toBe('vim notes.md')
  expect(commandLabel('ls -la')).toBe('ls')
  // A script run by its interpreter is named by the script, as it was typed.
  expect(commandLabel('node /usr/local/bin/npm run dev')).toBe('npm run dev')
  expect(commandLabel(`vim ${'x'.repeat(300)}`).length).toBeLessThanOrEqual(60)
})

test("an option's value is not taken for the argument the tab names", () => {
  // A known option that takes a value, in each of its forms.
  // ps joins the arguments with spaces, so a value is one word only when it has none.
  expect(commandLabel('vim -u NONE -c startinsert notes.md')).toBe('vim notes.md')
  expect(commandLabel('nvim --cmd startinsert -S session.vim app.ts')).toBe('nvim app.ts')
  expect(commandLabel('vim --clean notes.md')).toBe('vim notes.md')
  expect(commandLabel('ssh -i ~/.ssh/id -p 2222 -o StrictHostKeyChecking=no box.local')).toBe('ssh box.local')
  expect(commandLabel('psql -U robin -h db.local -d shop')).toBe('psql')
  expect(commandLabel('psql --username robin shop')).toBe('psql shop')
  expect(commandLabel('git -C ../site status')).toBe('git status')
  expect(commandLabel('make -C build all')).toBe('make all')
  expect(commandLabel('curl -o out.html https://example.com')).toBe('curl https://example.com')
  expect(commandLabel('bun --cwd apps/web run dev')).toBe('bun run dev')
  expect(commandLabel('docker run --name web -p 8080:80 -e MODE=dev nginx')).toBe('docker run nginx')
  // Joined to its option, the value was never an argument.
  expect(commandLabel('vim --cmd=startinsert notes.md')).toBe('vim notes.md')
  expect(commandLabel('python3 -Wignore app.py')).toBe('python3 app.py')
  // An option that takes nothing leaves the next word as the argument.
  expect(commandLabel('python3 -u app.py')).toBe('python3 app.py')
  expect(commandLabel('tail -f server.log')).toBe('tail server.log')
  expect(commandLabel('python3 -m http.server 8000')).toBe('python3 http.server')
  // Code given inline to an interpreter is no script name.
  expect(commandLabel('python3 -c import time; time.sleep(60)')).toBe('python3')
  expect(commandLabel('node -e setInterval(() => {}, 1000)')).toBe('node')
  expect(commandLabel('bash -c sleep 30')).toBe('bash')
  expect(commandLabel('bash -lc sleep 30')).toBe('bash')
  expect(commandLabel('python3 -E app.py')).toBe('python3 app.py')
})

test('nothing that looks like a secret reaches the tab, however the command was typed', () => {
  // ps shows arguments after the shell expanded them, so `-p$DB_PASS` arrives as the password itself.
  expect(commandLabel('mysql -phunter2 -u root shop')).toBe('mysql shop')
  expect(commandLabel('perl -e sleep 3 -- --password=hunter2-from-env')).toBe('perl')
  expect(commandLabel('psql --password=hunter2 db')).toBe('psql db')
  expect(commandLabel('gh --token=ghp_abc123 api')).toBe('gh api')
  // A value given to an option named for a secret, or to curl's user, is never the argument.
  expect(commandLabel('curl -u robin:hunter2 https://example.com')).toBe('curl https://example.com')
  expect(commandLabel('tool --password hunter2 run')).toBe('tool')
  expect(commandLabel('tool --api-key hunter2 run')).toBe('tool')
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
