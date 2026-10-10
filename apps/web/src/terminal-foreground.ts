/** The longest name a terminal's tab is given; the tab cuts it shorter still. */
const MAX_LABEL = 60
/** Package runners' verbs, after which the script's name says what runs (`bun run dev`, `pnpm exec vite`). */
const RUNNER_VERBS = new Set(['run', 'exec', 'x', 'dlx'])
/** Programs that run a script named by its path: the tab names the script, as it was typed (`npm`, not `node`). */
const INTERPRETERS = /^(node|python[\d.]*|ruby|perl|php|bash|sh|zsh)$/
/** Programs that share their options under one name: the vim family, ssh's, mysql's, docker's and so on. */
const FAMILIES: [RegExp, string][] = [
  [/^(n?vim?|view|gvim|mvim)$/, 'vim'],
  [/^(ssh|scp|sftp|autossh)$/, 'ssh'],
  [/^(mysql|mariadb)$/, 'mysql'],
  [/^(docker|podman)$/, 'docker'],
  [/^python[\d.]*$/, 'python'],
  [/^(bash|sh|zsh)$/, 'shell'],
]
/**
 * Options whose value is the next word, by family: that word is not the argument a tab names (`vim -u NONE x` is vim
 * on x). A short one counts last in a cluster too (`ssh -Ap 22`), as getopt reads it.
 */
const VALUE_OPTIONS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries({
    vim: '-c -i -S -s -T -t -U -u -W -w --cmd --listen --startuptime',
    ssh: '-b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -R -S -W -w',
    mysql: '-D -h -P -S -u --database --host --port --socket --user',
    psql: '-c -d -f -h -p -U --command --dbname --file --host --port --username',
    docker:
      '-e -f -p -v -w --entrypoint --env --file --name --network --platform --publish --volume --workdir',
    curl: '-A -b -c -d -e -F -H -o -T -u -X -x --cookie --data --header --proxy --request --user --user-agent',
    git: '-c',
    python: '-W -X',
    node: '-r --require --import',
    ruby: '-I -r',
    perl: '-I -M',
  }).map(([family, options]) => [family, options.split(' ')]),
)
/**
 * Options most programs give a value to (`git -C dir`, `gcc -o out`), whatever the program. Only these: most single
 * letters mean different things to different programs (`tail -f log` keeps its log).
 */
const COMMON_VALUE_OPTIONS = new Set([
  ...'-C -o --config --cwd --directory --env-file --filter --host'.split(' '),
  ...'--log-level --name --output --port --prefix --profile --user'.split(' '),
])
/** Interpreters' options whose value is code to run, not a script: the tab names the interpreter alone. */
const INLINE_CODE: Record<string, readonly string[]> = {
  python: ['-c'],
  node: ['-e', '-p', '--eval', '--print'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
  shell: ['-c'],
}
/** An option named for a secret (`--password`, `--api-key`): its value is never shown, nor anything after it. */
const SECRET_OPTION = /^--?[\w-]*(pass(word|wd)?|token|secret|key|auth|credential)[\w-]*$/i
/** How long one `ps` may take before the look-up gives up until the next one. */
const PS_TIMEOUT_MS = 2_000

async function ps(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(['ps', ...args], { stdout: 'pipe', stderr: 'ignore', timeout: PS_TIMEOUT_MS })
    return (await new Response(proc.stdout).text()).trim()
  } catch {
    // No `ps` here: the tab keeps showing the folder.
    return ''
  }
}

/** A program's name from its path, either slash; on Windows without its extension (`C:\…\node.exe` is `node`). */
const fileName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.(exe|cmd|bat|com)$/i, '')

/**
 * Whether an argument may be a secret: a header or `name=value` naming a password, token, key or secret, or a long
 * run of letters and digits such as an API key.
 */
function secretLike(word: string): boolean {
  if (/^(proxy-)?(authorization|bearer|basic)\b/i.test(word)) return true
  if (/(pass(word|wd)?|token|secret|key|auth|credential|session)[^=]*=/i.test(word)) return true
  return /^[A-Za-z0-9_+=-]{24,}$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word)
}

/**
 * A command line as a tab shows it: the program's name and its first argument that is not an option or an option's
 * value, the script's name too after a runner's verb (`bun run dev`, `python3 app.py`, `vim notes.md`). `ps` shows
 * arguments as the shell expanded them, so `mysql -p$DB_PASS` arrives with the password itself: options are never
 * shown, and neither is an argument that looks like a secret or anything after one; a URL loses its `user:password@`.
 */
export function commandLabel(args: string | readonly string[]): string {
  // Windows gives the words themselves, so a path with spaces stays one word.
  const [first = '', ...words] = typeof args === 'string' ? args.trim().split(/\s+/) : args
  let program = fileName(first)
  let found = argumentsOf(program, words)
  const script = found.plain[0]
  if (INTERPRETERS.test(program) && !found.inline && script && /[\\/]/.test(script.word)) {
    program = fileName(script.word)
    found = argumentsOf(program, words.slice(script.at + 1))
  }
  const shown = [program]
  for (const { word } of found.plain.slice(0, 2)) {
    if (secretLike(word)) break
    shown.push(word.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1'))
    if (!RUNNER_VERBS.has(word)) break
  }
  return shown.join(' ').slice(0, MAX_LABEL)
}

/**
 * A command's words that are not options or an option's value, with where each is. `inline` when an interpreter was
 * given code to run (`python3 -c …`), whose words name no script; the words stop at an option named for a secret.
 */
function argumentsOf(
  program: string,
  words: string[],
): { plain: { word: string; at: number }[]; inline: boolean } {
  const family = FAMILIES.find(([name]) => name.test(program))?.[1] ?? program
  const takes = new Set(VALUE_OPTIONS[family])
  const code = new Set(INLINE_CODE[family])
  const plain: { word: string; at: number }[] = []
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ''
    if (!word.startsWith('-')) {
      plain.push({ word, at })
      continue
    }
    // `--opt=value` carries its value with it.
    if (word.includes('=')) continue
    if (SECRET_OPTION.test(word)) break
    const last = /^-[A-Za-z]{2,}$/.test(word) ? `-${word.at(-1)}` : word
    if (code.has(word) || code.has(last)) return { plain, inline: true }
    if (takes.has(word) || takes.has(last) || COMMON_VALUE_OPTIONS.has(word)) at++
  }
  return { plain, inline: false }
}

/**
 * What runs in the foreground of the terminal whose shell is `shellPid`: the command line of the terminal's
 * foreground process group, or null while the shell waits at its prompt; undefined when it cannot be told. `ps`
 * reports the group as TPGID (what tcgetpgrp answers for the shell's terminal) on macOS and Linux alike, so this
 * needs no native module. Windows has no foreground group: there it is the last of the shell's children as the OS
 * lists them (`children`), or null when it has none.
 */
export async function foregroundCommand(
  shellPid: number,
  options: { platform?: NodeJS.Platform; children?: (pid: number) => string[][] } = {},
): Promise<string | null | undefined> {
  if ((options.platform ?? process.platform) === 'win32') {
    if (!options.children) return undefined
    // The console host ConPTY starts serves the terminal, not a command typed in it.
    const running = options
      .children(shellPid)
      .filter((args) => args.length && !/^conhost$/i.test(fileName(args[0] ?? '')))
    const last = running.at(-1)
    return last ? commandLabel(last) : null
  }
  const group = Number(await ps(['-o', 'tpgid=', '-p', String(shellPid)]))
  if (!Number.isInteger(group) || group <= 0) return undefined
  if (group === shellPid) return null
  // The group's leader is the command typed (in a pipeline, its first program).
  const args = await ps(['-o', 'args=', '-p', String(group)])
  return args ? commandLabel(args) : undefined
}
