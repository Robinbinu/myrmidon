import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { terminalSocket } from '../api.ts'
import { copy } from '../copy.ts'
import { Button } from '../ui/primitives.tsx'

/** How every terminal looks and behaves, picked in the Terminal view's ⋯ menu. */
export interface TerminalPrefs {
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  copyOnSelect: boolean
  scrollback: number
}

/**
 * One of the person's own shells, like an IDE's integrated terminal: a login shell on this machine in the chat's
 * project folder (or home), with their own permissions. Agents never use it; their commands are sandboxed separately.
 * It stays mounted while hidden, so its shell and scrollback live on while another terminal or view shows.
 */
export function ShellTerminal(props: {
  project?: string
  /** The one showing. */
  active: boolean
  /** Changes when the shown terminal should take focus. */
  focusRequest: number
  prefs: TerminalPrefs
  /** What runs in the foreground: a command line, or null while the shell waits at its prompt. */
  onProcess(name: string | null): void
  /** A title the shell or a program set (OSC 0 or 2), if any. */
  onTitle(title: string): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal>(undefined)
  const [ended, setEnded] = useState<string>()
  const [session, setSession] = useState(0)
  // The socket's handlers live as long as the shell; they read the latest props through these.
  const latest = useRef(props)
  latest.current = props

  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` restarts the shell
  useEffect(() => {
    const el = box.current
    if (!el) return
    setEnded(undefined)
    // xterm draws on a canvas, so it takes the panel's colours as values and is given them again on a theme change.
    const colours = () => {
      const style = getComputedStyle(el)
      return { background: style.backgroundColor, foreground: style.color, cursor: style.color }
    }
    const { prefs } = latest.current
    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      cursorStyle: prefs.cursorStyle,
      cursorBlink: prefs.cursorBlink,
      scrollback: prefs.scrollback,
      theme: colours(),
    })
    term.current = t
    const retheme = () => {
      t.options.theme = colours()
    }
    const themed = new MutationObserver(retheme)
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const system = matchMedia('(prefers-color-scheme: dark)')
    system.addEventListener('change', retheme)
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    fit.fit()
    const ws = terminalSocket(props.project, t.cols, t.rows)
    // The shell's output comes as binary frames; the server's notes (what runs in the foreground) as JSON text.
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return t.write(new Uint8Array(e.data as ArrayBuffer))
      const note = JSON.parse(e.data) as { type?: string; name?: unknown }
      if (note.type === 'process') latest.current.onProcess(typeof note.name === 'string' ? note.name : null)
    }
    ws.onclose = (e) => {
      setEnded(e.reason || copy.shellTerminal.closed)
      latest.current.onProcess(null)
    }
    const input = t.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })
    const titled = t.onTitleChange((title) => latest.current.onTitle(title))
    const selected = t.onSelectionChange(() => {
      if (!latest.current.prefs.copyOnSelect || !t.hasSelection()) return
      // The clipboard can refuse (no focus, no permission); the selection stays for ⌘C then.
      navigator.clipboard?.writeText(t.getSelection()).catch(() => undefined)
    })
    const resized = new ResizeObserver(() => {
      // A hidden terminal measures nothing; it fits again once it shows.
      if (!el.clientWidth) return
      fit.fit()
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
    })
    resized.observe(el)
    if (latest.current.active) t.focus()
    return () => {
      themed.disconnect()
      system.removeEventListener('change', retheme)
      resized.disconnect()
      input.dispose()
      titled.dispose()
      selected.dispose()
      ws.close()
      t.dispose()
      term.current = undefined
    }
  }, [props.project, session])

  const { cursorStyle, cursorBlink, scrollback } = props.prefs
  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.cursorStyle = cursorStyle
    t.options.cursorBlink = cursorBlink
    t.options.scrollback = scrollback
  }, [cursorStyle, cursorBlink, scrollback])

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request moves focus, not becoming active
  useEffect(() => {
    if (props.active) term.current?.focus()
  }, [props.focusRequest])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {ended && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-footnote text-muted">
          <span role="status" className="min-w-0 flex-1 truncate" title={ended}>
            {ended}
          </span>
          <Button
            size="sm"
            variant="borderless"
            onClick={() => setSession(session + 1)}
            icon={<RotateCcw className="size-3.5" />}
          >
            {copy.shellTerminal.newShell}
          </Button>
        </div>
      )}
      <div ref={box} data-terminal-screen className="min-h-0 flex-1 bg-surface px-2 py-1.5 text-fg" />
    </div>
  )
}
