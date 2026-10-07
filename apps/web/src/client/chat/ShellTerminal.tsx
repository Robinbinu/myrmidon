import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { terminalSocket } from '../api.ts'
import { copy } from '../copy.ts'
import { Button } from '../ui/primitives.tsx'

/**
 * The person's own shell, like an IDE's integrated terminal: a login shell on this machine in the chat's project
 * folder (or home), with their own permissions. Agents never use it; their commands are sandboxed separately.
 */
export function ShellTerminal(props: { project?: string; cwdLabel: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [ended, setEnded] = useState<string>()
  const [session, setSession] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` restarts the shell
  useEffect(() => {
    const el = box.current
    if (!el) return
    setEnded(undefined)
    const style = getComputedStyle(el)
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    const ws = terminalSocket(props.project, term.cols, term.rows)
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer))
    ws.onclose = (e) => setEnded(e.reason || copy.shellTerminal.closed)
    const input = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })
    const resized = new ResizeObserver(() => {
      fit.fit()
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    })
    resized.observe(el)
    term.focus()
    return () => {
      resized.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [props.project, session])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
        <span className="min-w-0 flex-1 truncate font-mono">{props.cwdLabel}</span>
        {ended && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSession(session + 1)}
            icon={<RotateCcw className="size-3.5" />}
          >
            {copy.shellTerminal.newShell}
          </Button>
        )}
      </div>
      <div ref={box} className="min-h-0 flex-1 bg-surface px-2 py-1.5 text-fg" />
    </div>
  )
}
