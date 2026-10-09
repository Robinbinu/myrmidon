/** The longest name a terminal's tab is given; the tab cuts it shorter still. */
const MAX_LABEL = 60
/** Package runners' verbs, after which the script's name says what runs (`bun run dev`, `pnpm exec vite`). */
const RUNNER_VERBS = new Set(['run', 'exec', 'x', 'dlx'])
/** Programs that run a script named by its path: the tab names the script, as it was typed (`npm`, not `node`). */
const INTERPRETERS = /^(node|python[\d.]*|ruby|perl|php|bash|sh|zsh)$/
/** How long one `ps` may take before the look-up gives up until the next one. */
const PS_TIMEOUT_MS = 2_000

async function ps(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(['ps', ...args], { stdout: 'pipe', stderr: 'ignore', timeout: PS_TIMEOUT_MS })
    return (await new Response(proc.stdout).text()).trim()
  } catch {
    // No `ps` here (Windows): the tab keeps showing the folder.
    return ''
  }
}

const fileName = (path: string) => path.split('/').pop() ?? path

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
 * A command line as a tab shows it: the program's name and its first argument that is not an option, the script's
 * name too after a runner's verb (`bun run dev`, `python3 app.py`, `sleep 30`). `ps` shows arguments as the shell
 * expanded them, so `mysql -p$DB_PASS` arrives with the password itself: options are never shown, and neither is an
 * argument that looks like a secret or anything after one; a URL loses its `user:password@`.
 */
export function commandLabel(args: string): string {
  const [first = '', ...words] = args.trim().split(/\s+/)
  let program = fileName(first)
  let plain = words.filter((w) => !w.startsWith('-'))
  if (INTERPRETERS.test(program) && plain[0]?.includes('/')) {
    program = fileName(plain[0])
    plain = plain.slice(1)
  }
  const shown = [program]
  for (const word of plain.slice(0, 2)) {
    if (secretLike(word)) break
    shown.push(word.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1'))
    if (!RUNNER_VERBS.has(word)) break
  }
  return shown.join(' ').slice(0, MAX_LABEL)
}

/**
 * What runs in the foreground of the terminal whose shell is `shellPid`: the command line of the terminal's
 * foreground process group, or null while the shell waits at its prompt; undefined when it cannot be told. `ps`
 * reports the group as TPGID (what tcgetpgrp answers for the shell's terminal) on macOS and Linux alike, so this
 * needs no native module.
 */
export async function foregroundCommand(shellPid: number): Promise<string | null | undefined> {
  const group = Number(await ps(['-o', 'tpgid=', '-p', String(shellPid)]))
  if (!Number.isInteger(group) || group <= 0) return undefined
  if (group === shellPid) return null
  // The group's leader is the command typed (in a pipeline, its first program).
  const args = await ps(['-o', 'args=', '-p', String(group)])
  return args ? commandLabel(args) : undefined
}
