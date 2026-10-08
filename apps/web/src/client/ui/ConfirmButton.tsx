import { Trash2 } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { CONFIRM_ARM_DELAY_MS } from '../ui-config.ts'
import { Button, IconButton } from './primitives.tsx'

/**
 * A removal that takes two clicks: the first arms it and says what happens, the second does it. Moving focus away or
 * pressing Escape disarms it, so one stray click never removes anything.
 */
export function ConfirmButton(props: {
  /** The button's text, or with `icon` the trash button's accessible name. */
  label: string
  /** An accessible name for the text button when its label alone is ambiguous in a list. */
  name?: string
  /** What the armed button says, such as "Remove for good". */
  confirm: string
  onConfirm(): void
  icon?: boolean
  /** A consequence worth spelling out, shown beside the armed button. */
  warning?: ReactNode
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  // Disarming with Escape puts focus back on the first button rather than losing it to the page.
  const [refocus, setRefocus] = useState(false)
  const armedAt = useRef(0)
  const arm = () => {
    armedAt.current = performance.now()
    setArmed(true)
  }
  if (armed)
    return (
      <span className="inline-flex items-center gap-2">
        {props.warning && (
          <span role="alert" className="max-w-64 text-right text-[12px] leading-snug text-bad-ink">
            {props.warning}
          </span>
        )}
        <Button
          size="sm"
          variant="danger"
          // The armed button replaces the one just clicked, so focus has to move onto it for blur to disarm it.
          autoFocus
          // Safari does not focus a clicked button, so pressing this one would otherwise blur it and disarm it
          // before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onBlur={() => {
            setArmed(false)
            setRefocus(false)
          }}
          onKeyDown={(e) => {
            // A held Enter repeats, and each repeat would press this button.
            if (e.repeat) return e.preventDefault()
            // Escape here only disarms; it must not also close the page around it.
            if (e.key !== 'Escape') return
            e.stopPropagation()
            setArmed(false)
            setRefocus(true)
          }}
          onClick={() => {
            if (performance.now() - armedAt.current < CONFIRM_ARM_DELAY_MS) return
            setArmed(false)
            setRefocus(false)
            props.onConfirm()
          }}
        >
          {props.confirm}
        </Button>
      </span>
    )
  return props.icon ? (
    <IconButton size="sm" label={props.label} disabled={props.disabled} autoFocus={refocus} onClick={arm}>
      <Trash2 className="size-4" />
    </IconButton>
  ) : (
    <Button
      size="sm"
      variant="ghost"
      aria-label={props.name}
      disabled={props.disabled}
      autoFocus={refocus}
      onClick={arm}
    >
      {props.label}
    </Button>
  )
}
