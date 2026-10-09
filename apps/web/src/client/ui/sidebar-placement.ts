import { useCallback, useEffect, useRef, useState } from 'react'
import { SIDEBAR_DOCK_PX } from '../ui-config.ts'
import { useMinWidth } from './hooks.ts'

/**
 * Where the sidebar is: beside the page in a window at least SIDEBAR_DOCK_PX wide (hidden or shown as the person
 * chose, kept across visits), or, in a narrower one, off the page and slid over it as a drawer when asked for.
 * `toggle` is what ⌘B, the palette and the toolbar's sidebar button do in either case.
 *
 * Going somewhere (`place` changes, or `away` from a pick that stays in place) and the window widening past the
 * breakpoint put the drawer away. Focus then goes to the page through `onAway`, not back to the button that opened
 * the drawer: the person went somewhere, and that button may be gone.
 */
export function useSidebarPlacement(props: {
  collapsed: boolean
  setCollapsed(collapsed: boolean): void
  /** Changes whenever the page shows somewhere else: the open chat, the view, Settings. */
  place: string
  onAway(): void
}) {
  const docked = useMinWidth(SIDEBAR_DOCK_PX)
  const [drawer, setDrawer] = useState(false)
  const open = useRef(drawer)
  open.current = drawer
  const onAway = useRef(props.onAway)
  onAway.current = props.onAway
  const away = useCallback(() => {
    if (!open.current) return
    setDrawer(false)
    // After the drawer gives focus back on closing, so the page keeps it.
    requestAnimationFrame(() => onAway.current())
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: puts the drawer away on each change of place or width
  useEffect(away, [props.place, docked])
  return {
    docked,
    /** The drawer is open (only ever in a narrow window). */
    drawer: !docked && drawer,
    /** The sidebar takes its place beside the page. */
    beside: docked && !props.collapsed,
    toggle: () => (docked ? props.setCollapsed(!props.collapsed) : setDrawer(!drawer)),
    /** Closes the drawer the way the person dismissed it (Escape, the dimmed page): focus goes back where it was. */
    close: () => setDrawer(false),
    away,
  }
}
