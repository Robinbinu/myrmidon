import { motion } from 'motion/react'
import { type ReactNode, useRef } from 'react'
import { fade, softSpring } from '../ui-config.ts'
import { useDialog } from './dialog.ts'

/**
 * A panel that slides in from the window's left edge over a dimmed window, for a sidebar the window is too narrow to
 * keep beside its content. Escape and a press on the dimmed window close it; focus moves in, stays in, and goes back
 * afterwards, as in a sheet.
 */
export function Drawer(props: { label: string; width: number; onClose(): void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useDialog(box, props.onClose)
  return (
    <motion.div
      className="fixed inset-0 z-[55] bg-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fade}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <motion.div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        initial={{ x: '-100%' }}
        animate={{ x: 0 }}
        exit={{ x: '-100%' }}
        transition={softSpring}
        // Some of the window stays uncovered, so it reads as a panel over the page and there is room to tap away. The
        // sidebar's material is see-through, made for the window's edge; over the page it needs a solid ground.
        style={{ width: `min(${props.width}px, 85vw)` }}
        className="h-full overflow-hidden bg-bg shadow-pop outline-none"
      >
        {props.children}
      </motion.div>
    </motion.div>
  )
}
