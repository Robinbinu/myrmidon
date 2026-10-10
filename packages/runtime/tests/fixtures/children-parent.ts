// A stand-in Myrmidon for children.test.ts: starts one kind of long-lived child through the real code, prints
// `started` (and any pid the test must not see stopped), then waits to be killed. A line on stdin stops Phonon the normal way.
//   bun children-parent.ts <leash|sibling|chrome|phonon|server|kitten> <dir>
import { mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserHub } from '../../src/browser.ts'
import { treeOf } from '../../src/leash.ts'
import { spawnLeashed } from '../../src/leashed.ts'
import { detectSandbox } from '../../src/sandbox.ts'
import { PhononStt } from '../../src/voice/stt.ts'
import { KittenTts } from '../../src/voice/tts.ts'
import { runningProcesses } from './processes.ts'
import { sleeper, twoSleeps } from './sleeper.ts'

const [kind, dir] = process.argv.slice(2)
if (!dir) throw new Error('usage: children-parent.ts <kind> <dir>')

/** Waits until `pid` has `n` processes below it, so the test sees the whole tree. */
async function descendants(pid: number, n: number) {
  for (let i = 0; i < 100; i++) {
    if (treeOf(runningProcesses(), pid).size > n) return
    await Bun.sleep(50)
  }
  throw new Error(`${pid} did not start ${n} processes`)
}

const keep: unknown[] = []
let extra = ''
switch (kind) {
  case 'leash': {
    // A command that ignores SIGTERM, so only the SIGKILL after the grace stops it, and two children of its own.
    const proc = spawnLeashed(sleeper('--ignore-term', '--children=2'), { stdout: 'ignore' })
    keep.push(proc)
    await descendants(proc.pid, 3)
    break
  }
  case 'sibling': {
    // A child started after the leash, not leashed: it must not hold the leash's stdin open. Detached on Windows,
    // where Bun's job object would otherwise end it with this process, so it could not outlive it as it must here.
    const proc = spawnLeashed(sleeper(), { stdout: 'ignore' })
    const other = Bun.spawn(sleeper(), { stdout: 'ignore', detached: process.platform === 'win32' })
    keep.push(proc, other)
    await descendants(proc.pid, 1)
    extra = ` ${other.pid}`
    break
  }
  case 'chrome': {
    const hub = new BrowserHub(join(dir, 'profile'))
    keep.push(hub)
    const tab = await hub.tab('c1', 'wren')
    await tab.page.setContent('<p>hello</p>')
    break
  }
  case 'phonon': {
    const phonon = new PhononStt(join(dir, 'home'), () => {}, join(dir, 'bin'))
    keep.push(phonon)
    await phonon.start()
    void (async () => {
      for await (const _ of Bun.stdin.stream()) phonon.stop()
    })()
    break
  }
  case 'server': {
    mkdirSync(join(dir, 'project'), { recursive: true })
    const server = detectSandbox().start({
      command: twoSleeps(),
      cwd: join(dir, 'project'),
      writable: [join(dir, 'project')],
    })
    keep.push(server)
    await descendants(server.pid, 3)
    break
  }
  case 'kitten': {
    mkdirSync(join(dir, 'home', 'voice', 'kitten'), { recursive: true })
    symlinkSync(
      join(homedir(), '.myrmidon', 'voice', 'kitten', 'nano'),
      join(dir, 'home', 'voice', 'kitten', 'nano'),
    )
    const kitten = new KittenTts(join(dir, 'home'), () => ({ model: 'nano', voice: 'Leo', speed: 1 }))
    keep.push(kitten)
    await kitten.speak('Hello.')
    break
  }
  default:
    throw new Error(`unknown kind ${kind}`)
}
console.log(`started${extra}`)
setInterval(() => {}, 60_000)
