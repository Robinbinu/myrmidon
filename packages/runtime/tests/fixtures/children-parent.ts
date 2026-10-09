// A stand-in Myrmidon for children.test.ts: starts one kind of long-lived child through the real code, prints
// `started` (and any pid the test must not see stopped), then waits to be killed. A line on stdin stops Phonon the normal way.
//   bun children-parent.ts <leash|sibling|chrome|phonon|server|kitten> <dir>
import { mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserHub } from '../../src/browser.ts'
import { spawnLeashed } from '../../src/leashed.ts'
import { detectSandbox } from '../../src/sandbox.ts'
import { PhononStt } from '../../src/voice/stt.ts'
import { KittenTts } from '../../src/voice/tts.ts'

const [kind, dir] = process.argv.slice(2)
if (!dir) throw new Error('usage: children-parent.ts <kind> <dir>')

/** Waits until `pid` has `n` processes below it, so the test sees the whole tree. */
async function descendants(pid: number, n: number) {
  for (let i = 0; i < 100; i++) {
    const ps = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], { stdout: 'pipe' })
    const rows = new TextDecoder()
      .decode(ps.stdout)
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
    const found = new Set([pid])
    for (let grew = true; grew; ) {
      grew = false
      for (const [p, pp] of rows)
        if (p && pp && found.has(pp) && !found.has(p)) {
          found.add(p)
          grew = true
        }
    }
    if (found.size > n) return
    await Bun.sleep(50)
  }
  throw new Error(`${pid} did not start ${n} processes`)
}

const keep: unknown[] = []
let extra = ''
switch (kind) {
  case 'leash': {
    // A grandchild that ignores SIGTERM, so only the SIGKILL after the grace stops it.
    const proc = spawnLeashed(['sh', '-c', 'trap "" TERM; sleep 600 & sleep 600 & wait'], {
      stdout: 'ignore',
    })
    keep.push(proc)
    await descendants(proc.pid, 3)
    break
  }
  case 'sibling': {
    // A child started after the leash, not leashed: it must not hold the leash's stdin open.
    const proc = spawnLeashed(['sleep', '600'], { stdout: 'ignore' })
    const other = Bun.spawn(['sleep', '600'], { stdout: 'ignore' })
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
      command: 'sleep 600 & sleep 600',
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
