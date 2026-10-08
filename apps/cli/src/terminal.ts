import { createInterface } from 'node:readline'
import type { Terminal } from './setup.ts'

/** ANSI styles for everything the CLI prints. */
export const style = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

const cancelled = () => new Error('cancelled')
const ESC = '\x1b'

/** One line of input, echoed. */
function askLine(question: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<string>((resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        rl.close()
        reject(cancelled())
      },
      { once: true },
    )
    // Ctrl-C, or the input ending (a closed pipe), cancels the question rather than leaving it waiting.
    rl.on('SIGINT', () => rl.close())
    rl.on('close', () => reject(cancelled()))
    rl.question(`${question}: `, (answer) => {
      resolve(answer)
      rl.close()
    })
  })
}

/** One line of input with nothing echoed, for keys: the terminal is put in raw mode and read a key at a time. */
function askHidden(question: string, signal?: AbortSignal): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return askLine(question, signal)
  process.stdout.write(`${question}: `)
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (settle: () => void) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      settle()
    }
    const onData = (chunk: Buffer) => {
      // A paste can arrive wrapped in bracketed-paste markers; they are not part of the key.
      for (const ch of chunk.toString('utf8').replaceAll(`${ESC}[200~`, '').replaceAll(`${ESC}[201~`, '')) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value))
        // Ctrl-C and Ctrl-D.
        if (ch === '\u0003' || ch === '\u0004') return finish(() => reject(cancelled()))
        if (ch === '\u007f' || ch === '\b') {
          if (value) process.stdout.write('\b \b')
          value = value.slice(0, -1)
        } else if (ch >= ' ') {
          value += ch
          // One star per character, so the person sees the paste landed without seeing the key (as Hermes does).
          process.stdout.write('*')
        }
      }
    }
    signal?.addEventListener('abort', () => finish(() => reject(cancelled())), { once: true })
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

/**
 * Whether a browser opened for a sign-in would be on another device: an SSH session, or Linux with no display
 * (after Hermes's remote-session check).
 */
function headless(): boolean {
  const env = process.env
  if (env.SSH_CLIENT || env.SSH_TTY || env.SSH_CONNECTION) return true
  return process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

/** The real terminal the setup commands talk through. */
export function terminal(): Terminal {
  return {
    print: (line = '') => console.log(line),
    ask: (question, options = {}) =>
      options.hidden ? askHidden(question, options.signal) : askLine(question, options.signal),
    piped: async () => (process.stdin.isTTY ? undefined : await Bun.stdin.text()),
    interactive: Boolean(process.stdin.isTTY),
    onInterrupt(fn) {
      process.on('SIGINT', fn)
      return () => process.off('SIGINT', fn)
    },
    headless: headless(),
    style,
  }
}
