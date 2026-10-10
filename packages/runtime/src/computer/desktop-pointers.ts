/**
 * Where an omp desktop script acts on the screen, for the overlay's agent cursors (the same `ComputerHub.point` the
 * Cua path reports to). omp runs the script in its own worker, so Myrmidon sees neither the clicks nor their places;
 * this wraps the script's `desktop` so each input call, after it ran, reports its point in global screen points.
 *
 * `pointerFacade` is sent to the worker as source (`desktopPrefix`), so it must stand alone: no imports, nothing from
 * this module's scope. It only adds reports: every call goes to omp's own facade unchanged, and a report that fails
 * never fails the script.
 */

/** The bridge name the wrapper reports a point through (handled by DesktopEngine, never offered to agents). */
export const DESKTOP_POINT_CALL = '__myrmidon_point'

type Report = (point: { x: number; y: number; action: string }) => void
// biome-ignore lint/suspicious/noExplicitAny: omp's facade is untyped across the worker boundary
type Any = any

export function pointerFacade(desktop: Any, report: Report): Any {
  // omp freezes its handles and their methods, so a wrapper is a fresh object over each, with its fields copied (a
  // returned window still reads as one) and its methods defined, not assigned.
  const def = (o: Any, name: string, value: Any, enumerable = false) =>
    Object.defineProperty(o, name, { value, enumerable, configurable: true, writable: true })
  const over = (base: Any): Any => {
    const o = Object.create(base)
    for (const key of Object.keys(base)) def(o, key, base[key], true)
    return o
  }
  // The last full screenshot's coordinate frame per target ("desktop", a window id or a display): x/y in input calls
  // are its pixels (omp 18.8: `coordinateWidth`/`coordinateHeight`; a zoom never changes it).
  const shots: Record<string, { width: number; height: number }> = {}
  // Displays in desktop points and composite screenshot pixels, read when the whole desktop is screenshotted.
  let displays: Any[] = []
  const last: Record<string, { x: number; y: number }> = {}
  const send = (target: string, x: number, y: number, action: string) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    last[target] = { x, y }
    try {
      report({ x, y, action })
    } catch {
      // A cursor is a nicety; the script's own work goes on.
    }
  }
  const onWindow = (bounds: Any, id: string, x: number, y: number) => {
    const shot = shots[id]
    const sx = shot?.width ? bounds.width / shot.width : 1
    const sy = shot?.height ? bounds.height / shot.height : 1
    return { x: bounds.x + x * sx, y: bounds.y + y * sy }
  }
  const onDesktop = (x: number, y: number) => {
    const shot = shots.desktop
    const wide = Math.max(0, ...displays.map((d) => d.pixelX + d.pixelWidth))
    const tall = Math.max(0, ...displays.map((d) => d.pixelY + d.pixelHeight))
    const px = shot?.width && wide ? (x * wide) / shot.width : x
    const py = shot?.height && tall ? (y * tall) / shot.height : y
    const d = displays.find(
      (s) =>
        px >= s.pixelX && py >= s.pixelY && px < s.pixelX + s.pixelWidth && py < s.pixelY + s.pixelHeight,
    )
    if (!d) return { x: px, y: py }
    return {
      x: d.x + ((px - d.pixelX) * d.width) / d.pixelWidth,
      y: d.y + ((py - d.pixelY) * d.height) / d.pixelHeight,
    }
  }
  const element = (el: Any): Any => {
    if (!el || typeof el !== 'object') return el
    const out = over(el)
    const at = async (action: string) => {
      const b = await el.bounds().catch(() => null)
      if (b) send(`el:${el.ref}`, b.x + b.width / 2, b.y + b.height / 2, action)
    }
    for (const name of ['click', 'press', 'perform', 'setValue', 'focus'])
      def(out, name, async (...args: Any[]) => {
        const r = await el[name](...args)
        await at(name === 'setValue' ? 'type' : name === 'focus' ? 'move' : 'click')
        return r
      })
    def(out, 'parent', async () => element(await el.parent()))
    def(out, 'children', async () => (await el.children()).map(element))
    return out
  }
  // Input on a target (the desktop or a window), its points mapped by `place`; typing shows where it last acted, or
  // `rest` (a window's middle) before that.
  const inputs = (
    base: Any,
    out: Any,
    id: string,
    place: (x: number, y: number) => { x: number; y: number },
    rest: () => { x: number; y: number } | undefined,
  ) => {
    const pointed =
      (action: string) =>
      async (x: number, y: number, ...more: Any[]) => {
        const r = await base[action](x, y, ...more)
        const p = place(x, y)
        send(id, p.x, p.y, action === 'doubleClick' || action === 'holdMouse' ? 'click' : action)
        return r
      }
    for (const action of ['click', 'doubleClick', 'move', 'scroll', 'holdMouse'])
      def(out, action, pointed(action))
    def(out, 'drag', async (points: Any[], ...more: Any[]) => {
      const r = await base.drag(points, ...more)
      const end = points[points.length - 1]
      if (end) {
        const p = place(end[0], end[1])
        send(id, p.x, p.y, 'drag')
      }
      return r
    })
    for (const name of ['type', 'press'])
      def(out, name, async (...args: Any[]) => {
        const r = await base[name](...args)
        const p = last[id] ?? rest()
        if (p) send(id, p.x, p.y, 'type')
        return r
      })
    def(out, 'screenshot', async (...args: Any[]) => {
      const r = await base.screenshot(...args)
      const width = r?.coordinateWidth ?? r?.width
      const height = r?.coordinateHeight ?? r?.height
      if (width && height && !r.region) shots[id] = { width, height }
      if (id === 'desktop' || id.startsWith('display:'))
        displays = await desktop.displays().catch(() => displays)
      return r
    })
  }
  const win = (w: Any): Any => {
    if (!w || typeof w !== 'object') return w
    const out = over(w)
    const id = String(w.id)
    const b = w.bounds
    inputs(
      w,
      out,
      id,
      (x, y) => onWindow(b, id, x, y),
      () => (b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : undefined),
    )
    def(out, 'find', async (...args: Any[]) => (await w.find(...args)).map(element))
    def(out, 'ref', async (...args: Any[]) => element(await w.ref(...args)))
    return out
  }
  // One display chosen as a target: its own screenshot frame over that display's rectangle in desktop points.
  const display = (t: Any): Any => {
    if (!t || typeof t !== 'object') return t
    const o = over(t)
    const id = `display:${t.id}`
    const place = (x: number, y: number) => {
      const d = displays.find((s) => String(s.id) === String(t.id))
      const shot = shots[id]
      if (!d) return onDesktop(x, y)
      return {
        x: d.x + (shot?.width ? (x * d.width) / shot.width : x),
        y: d.y + (shot?.height ? (y * d.height) / shot.height : y),
      }
    }
    inputs(t, o, id, place, () => undefined)
    return o
  }
  const out = over(desktop)
  inputs(desktop, out, 'desktop', onDesktop, () => undefined)
  if (typeof desktop.display === 'function')
    def(out, 'display', async (...args: Any[]) => display(await desktop.display(...args)))
  def(out, 'window', async (...args: Any[]) => win(await desktop.window(...args)))
  def(out, 'focusedWindow', async () => win(await desktop.focusedWindow()))
  for (const name of ['elementAt', 'focusedElement', 'ref'])
    def(out, name, async (...args: Any[]) => element(await desktop[name](...args)))
  return out
}

/**
 * What goes before an agent's script: its `desktop`, wrapped to report where it acts. One statement, so the script's
 * own last expression is still what it returns.
 */
export function desktopPrefix(): string {
  return `globalThis.desktop = (${pointerFacade.toString()})(globalThis.desktop, (p) => { void globalThis.__omp_call_tool__?.(${JSON.stringify(DESKTOP_POINT_CALL)}, p)?.catch?.(() => {}) });\n`
}
