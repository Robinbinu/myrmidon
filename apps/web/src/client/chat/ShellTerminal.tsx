import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { terminalSocket } from '../api.ts'
import { copy } from '../copy.ts'
import { Button } from '../ui/primitives.tsx'

const ANSI_COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

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
    // xterm draws on a canvas, so it takes the panel's colours as values and is given them again on a theme change.
    // A VS Code theme also brings its terminal palette (--ansi-*); Myrmidon's own looks keep xterm's.
    const colours = () => {
      const style = getComputedStyle(el)
      const root = getComputedStyle(document.documentElement)
      const ansi = Object.fromEntries(
        ANSI_COLOURS.flatMap((name) =>
          [false, true].map((bright) => {
            const key = bright ? `bright${name[0]?.toUpperCase()}${name.slice(1)}` : name
            return [key, root.getPropertyValue(`--ansi-${bright ? 'bright-' : ''}${name}`).trim()] as const
          }),
        ).filter(([, v]) => v),
      )
      return { ...ansi, background: style.backgroundColor, foreground: style.color, cursor: style.color }
    }
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      theme: colours(),
    })
    const retheme = () => {
      term.options.theme = colours()
    }
    const themed = new MutationObserver(retheme)
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    })
    const system = matchMedia('(prefers-color-scheme: dark)')
    system.addEventListener('change', retheme)
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
      themed.disconnect()
      system.removeEventListener('change', retheme)
      resized.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [props.project, session])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-footnote text-muted">
        <span className="min-w-0 flex-1 truncate font-mono">{props.cwdLabel}</span>
        {ended && (
          <span role="status" className="min-w-0 shrink truncate" title={ended}>
            {ended}
          </span>
        )}
        {ended && (
          <Button
            size="sm"
            variant="borderless"
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
